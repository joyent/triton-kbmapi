/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');
var endpoints = require('./endpoints');
var http = require('http');
var https = require('https');
var models = require('./models');
var mod_apis_moray = require('./apis/moray');
var mod_config = require('./config');
var mod_jsprim = require('jsprim');
var mod_mooremachine = require('mooremachine');
var moray = require('moray');
var os = require('os');
var restify = require('restify');
var trace_event = require('trace-event');
var util = require('util');
var VError = require('verror');

// Globals
var USAGE_PERIOD = 8 * 60 * 60 * 1000; // 8 hours
var PKG = require('../package.json');
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

    if (opts.config.bucketPrefix) {
        mod_apis_moray.setTestPrefix(
            opts.config.bucketPrefix.replace(/-/g, '_'));
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
        if (!req.app.isInState('running')) {
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
    mod_mooremachine.FSM.call(this, 'waiting');
}

util.inherits(KBMAPI, mod_mooremachine.FSM);

/**
 * Starts the server
 */
KBMAPI.prototype.start = function start(callback) {
    this.server.on('error', callback);
    const srvOpts = {
        port: this.config.port
    };
    if (this.config.host) {
        srvOpts.host = this.config.host;
    }
    this.server.listen(srvOpts, callback);

    this.emit('startAsserted');
};

/**
 * Stops the server
 */
KBMAPI.prototype.stop = function stop(callback) {
    assert.ok(this.isInState('running'));
    this.emit('stopAsserted', callback);
};

/**
 * Returns conneciton info for the server
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

KBMAPI.prototype.state_waiting = function (S) {
    S.validTransitions(['init']);

    S.on(this, 'startAsserted', function () {
        S.gotoState('init');
    });
};

KBMAPI.prototype.state_init = function (S) {
    S.gotoState('init.memlogger');
};

KBMAPI.prototype.state_init.memlogger = function (S) {
    this.log.info({ period: USAGE_PERIOD },
        'Starting periodic logging of memory usage');
    this.usageTimer = setInterval(periodicUsageLog, USAGE_PERIOD, this.log);
    S.gotoState('init.moray');
};

KBMAPI.prototype.state_init.moray = function (S) {
    var self = this;

    S.validTransitions([ 'init.buckets', 'failed' ]);

    if (self.moray) {
        S.gotoState('init.buckets');
        return;
    }

    var conf = mod_jsprim.deepCopy(self.config.moray);

    self.log.debug(conf, 'Creating moray client');

    conf.log = self.log.child({
        component: 'moray',
        level: self.config.moray.logLevel || 'info'
    });

    self.moray = moray.createClient(conf);

    S.on(self.moray, 'connect', function onMorayConnect() {
        self.log.info('moray: connected');
        S.gotoState('init.buckets');
    });

    S.on(self.moray, 'error', function onMorayError(err) {
        self.initErr = new VError(err, 'moray: connection failed');
        S.gotoState('failed');
    });
};

KBMAPI.prototype.state_init.buckets = function (S) {
    var self = this;

    S.validTransitions([ 'init.buckets', 'running' ]);

    self.morayVersion = 2;

    models.init(self, function (err) {
        if (err) {
            self.log.error(err, 'Error initializing models; retrying in 10s');
            S.timeout(10000, function () {
                S.gotoState('init.buckets');
            });
            return;
        }

        S.gotoState('running');
    });
};

KBMAPI.prototype.state_running = function (S) {
    var self = this;

    S.validTransitions([ 'stopping' ]);

    S.on(self, 'stopAsserted', function (callback) {
        self.stopcb = callback;
        S.gotoState('stopping');
    });

    S.immediate(function () {
        self.emit('initialized');
    });
};

KBMAPI.prototype.state_failed = function (S) {
    var self = this;

    S.validTransitions([]);

    self._cleanup(function () {
        self.emit('error', self.initErr);
    });
};

KBMAPI.prototype.state_stopping = function (S) {
    var self = this;

    S.validTransitions([ 'stopped' ]);

    self._cleanup(function cleanupCb(err) {
        self.stoperr = err;
        S.gotoState('stopped');
    });
};

KBMAPI.prototype.state_stopped = function (S) {
    S.validTransitions([]);
    setImmediate(this.stopcb, this.stoperr);
};

KBMAPI.prototype._cleanup = function (callback) {
    var self = this;

    if (self.moray) {
        self.moray.close();
    }

    if (self.usageTimer) {
        clearInterval(self.usageTimer);
        self.usageTimer = null;
    }

    if (callback) {
        callback();
        return;
    }
};

function createServer(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.configFile, 'opts.configFile');

    opts.log.info('Loading config from "%s"', opts.configFile);
    var config = mod_config.load(opts.configFile);

    if (config.hasOwnProperty('loglevel')) {
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
