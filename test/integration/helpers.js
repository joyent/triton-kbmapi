/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Helper to run `kbmctl` command. Shamelessly reaped from node-triton.
 */

'use strict';

const execFile = require('child_process').execFile;
const path = require('path');

const assert = require('assert-plus');
const VError = require('verror').VError;

const KBMCTL = [process.execPath, path.resolve(__dirname, '../../bin/kbmctl')];

/**
 * A convenience wrapper around `child_process.exec` to take away some
 * logging and error handling boilerplate.
 *
 * @param args {Object}
 *      - command {String|Array} Required.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 *      - execOpts {Array} Optional. child_process.exec options.
 *      - errMsg {String} Optional. Error string to use in error message on
 *        failure.
 * @param cb {Function} `function (err, stdout, stderr)` where `err` here is
 *      an `VError` wrapper around the child_process error.
 */
function execPlus(args, cb) {
    assert.object(args, 'args');
    assert.optionalString(args.errMsg, 'args.errMsg');
    assert.optionalObject(args.execOpts, 'args.execOpts');
    assert.func(cb);
    var command = args.command;
    var execOpts = args.execOpts;
    if (typeof (command) === 'string') {
        command = ['/bin/sh', '-c', command];
    }
    execFile(command[0], command.slice(1), execOpts,
        function (err, stdout, stderr) {
        if (err) {
            var niceErr = new VError(err,
                    '%s:\n'
                    + '\tcommand: %s\n'
                    + '\texit status: %s\n'
                    + '\tstdout:\n%s\n'
                    + '\tstderr:\n%s',
                    args.errMsg || 'exec error', command, err.code,
                    stdout.trim(), stderr.trim());
            niceErr.code = err.code;
            cb(niceErr, stdout, stderr);
            return;
        }
        cb(null, stdout, stderr);
    });
}


/*
 * Call the `kbmctl` CLI with the given args.
 *
 * @param args {String|Array} Required. CLI arguments to `kbmctl ...` (without
 *      the "kbmctl"). This can be an array of args, or a string.
 * @param opts {Object} Optional.
 *      - opts.cwd {String} cwd option to exec.
 * @param cb {Function}
 */
function kbmctl(args, opts, cb) {
    var command = [].concat(KBMCTL).concat(args);
    if (typeof (args) === 'string') {
        command = command.join(' ');
    }
    if (cb === undefined) {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'opts');
    assert.optionalString(opts.cwd, 'opts.cwd');
    assert.func(cb, 'cb');
    execPlus({
        command: command,
        execOpts: {
            maxBuffer: Infinity,
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                KBMAPI: process.env.KBMAPI_HOST || '10.99.99.122'
            },
            cwd: opts.cwd
        }
    }, cb);
}


module.exports = {
    kbmctl: kbmctl,
    execPlus: execPlus
};
// vim: set softtabstop=4 shiftwidth=4:
