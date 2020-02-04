/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

'use strict';

const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const os = require('os');
const util = require('util');

const assert = require('assert-plus');
const backoff = require('backoff');
const jsprim = require('jsprim');
const moray = require('moray');
const restify = require('restify');
const trace_event = require('trace-event');
const vasync = require('vasync');
const VError = require('verror');

const endpoints = require('./endpoints');
const models = require('./models');
const mod_apis_moray = require('./apis/moray');
const mod_config = require('./config');

// Globals
const USAGE_PERIOD = 8 * 60 * 60 * 1000; // 8 hours
const PKG = require('../package.json');
var request_seq_id = 0;


// --- Internal functions


function periodicUsageLog(log) {
    log.info({ memory: process.memoryUsage() },
        'Current memory usage');
}


// --- KBMAPI object and methods



/**
 * KBMAPI constructor
 */
function KBMAPI(opts) {
    var self = this;
    this.log = opts.log;
    this.config = opts.config;
    this.running = false;

    if (opts.config.testBucketPrefix) {
        mod_apis_moray.setTestPrefix(
            opts.config.testBucketPrefix.replace(/-/g, '_'));
    }

    var maxSockets = opts.config.maxHttpSockets || 100;
    opts.log.debug('Setting maxSockets to %d', maxSockets);
    http.globalAgent.maxSockets = maxSockets;
    https.globalAgent.maxSockets = maxSockets;

    function populateReq(req, res, next) {
        req.config = opts.config;
        req.app = self;
        next();
    }

    function checkServices(req, res, next) {
        if (!req.app.running) {
            next(new restify.ServiceUnavailableError(
                'Server is still initializing'));
            return;
        }

        next();
    }

    var before = [ populateReq, checkServices ];
    var server = this.server = restify.createServer({
        log: opts.log,
        name: PKG.description,
        handleUncaughtExceptions: false,
        version: PKG.version
    });

    server.use(restify.requestLogger());
    var EVT_SKIP_ROUTES = {
        'getping': true,
        'headping': true
    };
    server.use(function initTrace(req, res, next) {
        req.trace = trace_event.createBunyanTracer({
            log: req.log
        });
        if (req.route && !EVT_SKIP_ROUTES[req.route.name]) {
            request_seq_id = (request_seq_id + 1) % 1000;
            req.trace.seq_id = (req.time() * 1000) + request_seq_id;
            req.trace.begin({
                name: req.route.name,
                req_seq: req.trace.seq_id
            });
        }
        next();
    });

    server.use(function addTrace(req, res, next) {
        res.on('header', function onHeader() {
            var now = Date.now();
            req.header('Date', new Date());
            req.header('Server', server.name);
            req.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
            res.header('x-server-name', os.hostname());
        });
        next();
    });

    server.use(restify.acceptParser(server.acceptable));
    server.use(restify.queryParser());
    server.use(restify.bodyParser());

    server.on('after', function (req, res, route, _err) {
        if (route && !EVT_SKIP_ROUTES[route.name]) {
            req.trace.end({ name: route.name, req_seq: req.trace.seq_id });
        }
    });

    endpoints.registerEndpoints(server, before, self.log);

    EventEmitter.call(this);
}

util.inherits(KBMAPI, EventEmitter);

/**
 * Starts the server
 */
KBMAPI.prototype.start = function start(callback) {
    const self = this;

    this.server.on('error', callback);

    const srvOpts = {
        port: this.config.port
    };
    if (this.config.host) {
        srvOpts.host = this.config.host;
    }
    this.server.listen(srvOpts, callback);

    var context = {
        log: this.log
    };
    vasync.pipeline({
        arg: context,
        funcs: [
            function initMemlogger(ctx, next) {
                ctx.log.info({ period: USAGE_PERIOD },
                    'Starting periodic logging of memory usage');
                self.usageTimer = setInterval(periodicUsageLog,
                    USAGE_PERIOD, ctx.log);
                next();
            },

            function initMoray(ctx, next) {
                if (self.moray) {
                    next();
                    return;
                }

                var conf = jsprim.deepCopy(self.config.moray);

                ctx.log.debug(conf, 'Creating moray client');

                conf.log = ctx.log.child({
                    component: 'moray',
                    level: self.config.moray.logLevel || 'info'
                });

                self.moray = moray.createClient(conf);

                self.moray.once('connect', function onMorayConnect() {
                    ctx.log.info('moray: connected');
                    next();
                });

                self.moray.once('error', function onMorayError(err) {
                    self.initErr = new VError(err, 'moray: connection failed');
                    next(err);
                });
            },

            function initBuckets(ctx, next) {
                self.morayVersion = 2;

                var modelsInitBackoff = backoff.exponential({
                    initialDelay: 100,
                    maxDelay: 10000
                });

                modelsInitBackoff.on('ready', function onBackoff() {
                    models.init(self, function onModelsInit(modelsInitErr) {
                        if (modelsInitErr) {
                            ctx.log.error({
                                err: modelsInitErr
                            }, 'Error when initializing models, backing off');
                            modelsInitBackoff.backoff();
                        } else {
                            ctx.log.info('Models initialized successfully');
                            modelsInitBackoff.reset();
                            /* eslint-disable callback-return */
                            next();
                            /* eslint-enable callback-return */
                        }
                    });
                });

                modelsInitBackoff.backoff();
            }
        ]
    }, function initDone(initErr) {
        if (!initErr) {
            self.running = true;
            self.emit('initialized');
        }
        callback(initErr);
    });
};

/**
 * Stops the server
 */
KBMAPI.prototype.stop = function stop(callback) {
    var self = this;

    if (self.moray) {
        self.moray.close();
    }

    self.running = false;

    if (self.usageTimer) {
        clearInterval(self.usageTimer);
        self.usageTimer = null;
    }

    if (callback) {
        /* eslint-disable callback-return */
        callback();
        /* eslint-enable callback-return */
    }
};

/**
 * Returns connection info for the server
 */
KBMAPI.prototype.info = function info() {
    if (!this.server) {
        return {};
    }

    return {
        name: this.server.name,
        port: this.config.port,
        url: this.server.url
    };
};


function createServer(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.configFile, 'opts.configFile');

    opts.log.info('Loading config from "%s"', opts.configFile);
    var config = mod_config.load(opts.configFile);

    if (config.hasOwnProperty('logLevel')) {
        opts.log.info('Setting log level to "%s"', config.logLevel);
        opts.log.level(config.logLevel);
    }

    return new KBMAPI({
        log: opts.log,
        config: config
    });
}

module.exports = {
    createServer: createServer,
    KBMAPI: KBMAPI
};
