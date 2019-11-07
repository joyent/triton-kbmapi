/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */
'use strict';
/*
 * kbmctl CLI main file
 */
// var assert = require('assert-plus');
var bunyan = require('bunyan');
// var child_process = require('child_process'),
//    spawn = child_process.spawn,
//    exec = child_process.exec;
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;
// var fs = require('fs');
// var mkdirp = require('mkdirp');
var util = require('util'),
    format = util.format;
// var path = require('path');
// var vasync = require('vasync');
var UUID = require('node-uuid');
var kbmapi = require('../../client');

var packageJson = require('../../package.json');
var config = require('../../config.json');

var OPTIONS = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Print this help and exit.'
    },
    {
        name: 'version',
        type: 'bool',
        help: 'Print version and exit.'
    },
    {
        names: ['verbose', 'v'],
        type: 'bool',
        help: 'Verbose/debug output.'
    }
];

function CLI() {
    Cmdln.call(this, {
        name: 'kbmctl',
        desc: packageJson.description,
        options: OPTIONS,
        helpOpts: {
            includeEnv: true,
            minHelpCol: 30
        },
        helpSubcmds: [
            'help',
            'recovery',
            'pivtoken'
        ],
        helpBody: [
            /* eslint-disable max-len */
            'Exit Status:',
            '    0   Successful completion.',
            '    1   An error occurred.',
            '    2   Usage error.',
            '    3   "ResourceNotFound" error (when a config, pivtoken, etc. with',
            '        the given name or id is not found) or "PIVTokenDeleted" error.'
            /* eslint-enable max-len */
        ].join('\n')
    });
}
util.inherits(CLI, Cmdln);

CLI.prototype.init = function (opts, args, callback) {
    var self = this;
    this.opts = opts;

    this.log = bunyan.createLogger({
        name: this.name,
        serializers: bunyan.stdSerializers,
        stream: process.stderr,
        level: 'warn'
    });

    if (opts.verbose) {
        this.log.level('trace');
        this.log.src = true;
        this.showErrStack = true;
    }

    if (opts.version) {
        console.log('KBMAPI CTL', packageJson.version);
        console.log(packageJson.homepage);
        callback(false);
        return;
    }

    this.__defineGetter__('kbmapi', function getTritonapi() {
        if (self._kbmapi === undefined) {
            var host = 'localhost';
            var port = process.env.KBMAPI_PORT || 80;

            if (opts.host) {
                host = opts.host;
            } else if (process.env.KBMAPI_HOST) {
                host = process.env.KBMAPI_HOST;
            } else {
                port = config.port;
            }


            var reqID = UUID.v4();
            var clientOpts = {
                agent: false,
                headers: { 'x-request-id': reqID },
                url: format('http://%s:%d', host, port)
            };

            self._kbmapi = new kbmapi(clientOpts);
            self._kbmapi.req_id = reqID;
            self.log.trace('created kbmapi');
        }
        return self._kbmapi;
    });

    // Cmdln class handles `opts.help`.
    Cmdln.prototype.init.call(self, opts, args, callback);
};

CLI.prototype.fini = function fini(subcmd, err, cb) {
    this.log.trace({err: err, subcmd: subcmd}, 'cli fini');
    if (this._kbmapi) {
        delete this._kbmapi;
    }
    cb();
};

CLI.prototype.do_recovery = require('./do_recovery');
CLI.prototype.do_pivtoken = require('./do_pivtoken');

// --- mainline

function main(argv) {
    if (!argv) {
        argv = process.argv;
    }

    var cli = new CLI();
    cli.main(argv, function (err) {
        var exitStatus = (err ? err.exitStatus || 1 : 0);
        var showErr = (cli.showErr !== undefined ? cli.showErr : true);
        var errHelp;
        var errMessage;

        if (err && showErr) {
            var code = (err.body ? err.body.code : err.code) || err.restCode;
            if (code === 'NoCommand') {
                /* jsl:pass */
            } else if (err.name === 'InternalServerError') {
                /*
                 * Internal server error, we want to provide a useful error
                 * message without exposing internals.
                 */
                console.error('%s: internal error. Please try again later, ' +
                    'and contact support in case the error persists.',
                    cmdln.nameFromErr(err));
            } else {
                /*
                 * If the err has `body.errors`, as some Triton/SDC APIs do per
                 *      // JSSTYLED
                 *      https://github.com/joyent/eng/blob/master/docs/index.md#error-handling
                 * then append a one-line summary for each error object.
                 */
                var bodyErrors = '';
                if (err.body && err.body.errors) {
                    err.body.errors.forEach(function (e) {
                        bodyErrors += format('\n    %s: %s', e.field, e.code);
                        if (e.message) {
                            bodyErrors += ': ' + e.message;
                        }
                    });
                }

                /*
                 * Try to find the most descriptive message to output.
                 *
                 * 1. If there's a message property on the error object, we
                 * assume this is suitable to output to the user.
                 *
                 * 2. Otherwise, if there's an "orignalBody" property, we output
                 * its content per joyent/node-triton#30.
                 *
                 * 3. We fall back to using the error's name as the error
                 * message.
                 */
                if (typeof (err.message) === 'string' && err.message !== '') {
                    errMessage = err.message;
                } else if (err.originalBody !== undefined) {
                    errMessage = err.originalBody.toString();
                } else {
                    errMessage = err.name;
                }

                console.error('%s: error%s: %s%s',
                    cmdln.nameFromErr(err),
                    (code ? format(' (%s)', code) : ''),
                    (cli.showErrStack ? err.stack : errMessage),
                    bodyErrors);
            }

            errHelp = cmdln.errHelpFromErr(err);
            if (errHelp) {
                console.error(errHelp);
            }
        }

        /*
         * We'd like to NOT use `process.exit` because that doesn't always
         * allow std handles to flush (e.g. all logging to complete). However
         * I don't know of another way to exit non-zero.
         */
        if (exitStatus !== 0) {
            process.exit(exitStatus);
        }
    });
}


// --- exports

module.exports = {
    CLI: CLI,
    main: main
};

// vim: set softtabstop=4 shiftwidth=4:
