/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */
'use strict';

const fs = require('fs');
const tty = require('tty');
const util = require('util');
const format = util.format;

const assert = require('assert-plus');
const jsprim = require('jsprim');

/*
 * Read stdin in and callback with it as a string
 *
 * @param {Function} cb - callback in the form `function (str) {}`
 */
function readStdin(cb) {
    assert.func(cb, 'cb');

    var stdin = '';
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', function stdinOnData(chunk) {
        stdin += chunk;
    });
    process.stdin.on('end', function stdinOnEnd() {
        cb(stdin);
    });
}

/**
 * Prompt a user for a y/n answer.
 *
 *      cb('y')        user entered in the affirmative
 *      cb('n')        user entered in the negative
 *      cb(false)      user ^C'd
 *
 * Dev Note: Borrowed from imgadm's common.js. If this starts showing issues,
 * we should consider using the npm 'read' module.
 */
function promptYesNo(opts_, cb) {
    assert.object(opts_, 'opts');
    assert.string(opts_.msg, 'opts.msg');
    assert.optionalString(opts_.default, 'opts.default');
    var opts = jsprim.deepCopy(opts_);

    // Setup stdout and stdin to talk to the controlling terminal if
    // process.stdout or process.stdin is not a TTY.
    var stdout;
    if (opts.stdout) {
        stdout = opts.stdout;
    } else if (process.stdout.isTTY) {
        stdout = process.stdout;
    } else {
        opts.stdout_fd = fs.openSync('/dev/tty', 'r+');
        stdout = opts.stdout = new tty.WriteStream(opts.stdout_fd);
    }
    var stdin;
    if (opts.stdin) {
        stdin = opts.stdin;
    } else if (process.stdin.isTTY) {
        stdin = process.stdin;
    } else {
        opts.stdin_fd = fs.openSync('/dev/tty', 'r+');
        stdin = opts.stdin = new tty.ReadStream(opts.stdin_fd);
    }

    stdout.write(opts.msg);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    var input = '';
    stdin.on('data', onData);

    function postInput() {
        stdout.write('\n');
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
    }

    function finish(rv) {
        if (opts.stdout_fd !== undefined) {
            stdout.end();
            delete opts.stdout_fd;
        }
        if (opts.stdin_fd !== undefined) {
            stdin.end();
            delete opts.stdin_fd;
        }
        cb(rv);
    }

    function onData(ch) {
        ch = ch + '';

        switch (ch) {
        case '\n':
        case '\r':
        case '\u0004':
            // EOT. They've finished typing their answer
            postInput();
            var answer = input.toLowerCase();
            if (answer === '' && opts.default) {
                finish(opts.default);
            } else if (answer === 'yes' || answer === 'y') {
                finish('y');
            } else if (answer === 'no' || answer === 'n') {
                finish('n');
            } else {
                stdout.write('Please enter "y", "yes", "n" or "no".\n');
                promptYesNo(opts, cb);
                return;
            }
            break;
        case '\u0003': // Ctrl C
            postInput();
            finish(false);
            break;
        case '\u007f': // DEL
            input = input.slice(0, -1);
            stdout.clearLine();
            stdout.cursorTo(0);
            stdout.write(opts.msg);
            stdout.write(input);
            break;
        default:
            // Rule out special ASCII chars.
            var code = ch.charCodeAt(0);
            if (code >= 0 && code <= 31) {
               break;
            }
            // More plaintext characters
            stdout.write(ch);
            input += ch;
            break;
        }
    }
}

/*
 * take some basic information and return node-cmdln options suitable for
 * tabula
 *
 * @param {String} (optional) opts.columnDefault Default value for `-o`
 * @param {String} (optional) opts.sortDefault Default value for `-s`
 * @param {String} (optional) opts.includeLong Include `-l` option
 * @return {Array} Array of cmdln options objects
 */
function getCliTableOptions(opts) {
    opts = opts || {};
    assert.object(opts, 'opts');
    assert.optionalString(opts.columnsDefault, 'opts.columnsDefault');
    assert.optionalString(opts.sortDefault, 'opts.sortDefault');
    assert.optionalBool(opts.includeLong, 'opts.includeLong');

    var o;

    // construct the options object
    var tOpts = [];

    // header
    tOpts.push({
        group: 'Output options'
    });

    // -H
    tOpts.push({
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    });

    // -o field1,field2,...
    o = {
        names: ['o'],
        type: 'string',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    };
    if (opts.columnsDefault) {
        o.default = opts.columnsDefault;
    }
    tOpts.push(o);

    // -l, --long
    if (opts.includeLong) {
        tOpts.push({
            names: ['long', 'l'],
            type: 'bool',
            help: 'Long/wider output. Ignored if "-o ..." is used.'
        });
    }

    // -s field1,field2,...
    o = {
        names: ['s'],
        type: 'string',
        help: 'Sort on the given fields.',
        helpArg: 'field1,...'
    };
    if (opts.sortDefault) {
        o.default = opts.sortDefault;
        o.help = format('%s Default is "%s".', o.help, opts.sortDefault);
    }
    tOpts.push(o);

    // -j, --json
    tOpts.push({
        names: ['json', 'j'],
        type: 'bool',
        help: 'JSON output.'
    });

    return tOpts;
}

/**
 * given an array return a string with each element
 * JSON-stringifed separated by newlines
 */
function jsonStream(arr, stream) {
    stream = stream || process.stdout;

    arr.forEach(function (elem) {
        stream.write(JSON.stringify(elem) + '\n');
    });
}

module.exports = {
    readStdin: readStdin,
    promptYesNo: promptYesNo,
    getCliTableOptions: getCliTableOptions,
    jsonStream: jsonStream
};
// vim: set softtabstop=4 shiftwidth=4:
