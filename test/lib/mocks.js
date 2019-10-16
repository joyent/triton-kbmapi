/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */
'use strict';

const EventEmitter = require('events').EventEmitter;
const util = require('util');
const UUID = require('node-uuid');
const mod_recovery_token = require('../../lib/models').recovery_token;
// --- Globals

var CNAPI_CONNECTED = true;
var TASKS = {};

/*
 * We need to cause the same results than CNAPI + cn-agent
 * into KBMAPI so we need to perform some MORAY updates for
 * recovery tokens
 */
function FakeCnapiClient(moray) {
    var self = this;
    self.moray = moray;
    EventEmitter.call(this);
    process.nextTick(function () {
        self.emit('connect');
    });
}
util.inherits(FakeCnapiClient, EventEmitter);


Object.defineProperty(FakeCnapiClient.prototype, 'connected', {
    get: function () { return CNAPI_CONNECTED; }
});

FakeCnapiClient.prototype.listServers = function (params, options, cb) {
    console.log(util.inspect(params, false, 8, true));
    console.log(util.inspect(options, false, 8, true));
    cb();
};

FakeCnapiClient.prototype.getServer = function (uuid, options, cb) {
    console.log(util.inspect(uuid, false, 8, true));
    console.log(util.inspect(options, false, 8, true));
    cb();
};

FakeCnapiClient.prototype.getTask = function (id, _options, cb) {
    if (TASKS[id]) {
        cb(null, TASKS[id]);
        return;
    }
    cb(new Error('Unknown task'));
};

// The only relevant option is timeout, which we're not carying about
// too much right now
FakeCnapiClient.prototype.waitTask = function (id, _options, cb) {
    if (TASKS[id]) {
        TASKS[id].status = 'complete';
        cb(null, TASKS[id]);
        return;
    }
    cb(new Error('Unknown task'));
};


// We only care about path '/servers/:uuid/update-recovery-config' for our
// testing purposes.
FakeCnapiClient.prototype.post = function (uuid, params, cb) {
    var self = this;
    // this.post(format('/servers/%s/update-recovery-config', server),
    //      params, cb);
    // params should include "action" and be one of "stage" or "activate" for
    // now. Recovery token's uuid must be also present and, eventually,
    // recovery token's token too.
    var task = {
        id: UUID.v4(),
        req_id: UUID.v4(),
        task: params.action,
        server_uuid: uuid,
        status: 'active',
        timestamp: new Date().toISOString()
    };
    TASKS[task.id] = task;
    var val = {};
    if (params.action === 'stage') {
        val.staged = new Date().toISOString();
    } else if (params.action === 'activate') {
        val.activated = new Date().toISOString();
    }
    mod_recovery_token.update({
        moray: self.moray,
        key: params.recovery_token.uuid,
        val: val
    }, function upCb(upErr, _upRes) {
        if (upErr) {
            console.error(upErr);
        }
        console.log(util.inspect(_upRes, false, 8, true));
        cb(null, task);
    });
};

FakeCnapiClient.prototype.ping = function (cb) {
    cb();
};

FakeCnapiClient.prototype.close = function () {
    CNAPI_CONNECTED = false;
};

module.exports = {
    // -- mocks

    cnapi: FakeCnapiClient,

    set cnapiConnected(val) {
        CNAPI_CONNECTED = val;
    }
};

// vim: set softtabstop=4 shiftwidth=4:
