/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');
var common = require('../lib/common');
var mod_server = require('../lib/server');

function reset() {
    common.resetCreated();
}

function createClient(t) {
    return common.createClient(mod_server.get().info().url, t);
}

function createClientAndServer(opts, callback) {
    if (callback === undefined) {
        callback = opts;
        opts = {};
    }

    assert.object(opts, 'opts');
    assert.func(callback, 'callback');

    mod_server._create(opts, function (err, res) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, res.client, res.moray, res.server);
    });
}

module.exports = {
    createClient: createClient,
    createClientAndServer: createClientAndServer,
    reset: reset
};
