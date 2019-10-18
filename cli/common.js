/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */
'use strict';
const assert = require('assert-plus');
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

module.exports = {
    readStdin: readStdin
};
// vim: set softtabstop=4 shiftwidth=4:
