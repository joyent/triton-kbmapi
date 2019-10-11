/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Unit tests for recovery-configurations endpoints
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// So linter doesn't complain b/c I do have it around and not used for now.
const util = require('util');


const UUID = require('node-uuid');
const vasync = require('vasync');

const h = require('../helpers');
const mod_server = require('../../lib/server');
const test = require('tape');

const eboxTpl = fs.readFileSync(path.resolve(
    __dirname, '../../backup'), 'ascii');

var KBMAPI;
var MORAY;
var CLIENT;
var RECOVERY_CONFIG;


var targets = [];
var i = 0;
while (i < 20) {
    targets.push(UUID.v4());
    i += 1;
}

test('Initial setup', function tInitialSetup(suite) {
    h.reset();

    suite.test('Create client and server', function tCreateClientServer(t) {
        h.createClientAndServer(function (err, client, moray, server) {
            KBMAPI = server;
            MORAY = moray;
            CLIENT = client;
            t.ifError(err, 'server creation');
            t.ok(KBMAPI, 'server');
            t.ok(MORAY, 'moray');
            t.ok(CLIENT, 'client');
            t.end();
        });
    });

    suite.test('Create RecoveryConfiguration', function doCreate(t) {
        CLIENT.createRecoveryConfiguration({
            template: eboxTpl
        }, function createCb(err, recoveryConfig, res) {
            t.ifError(err, 'create recovery configuration error');
            t.ok(recoveryConfig, 'recoveryConfig');
            t.ok(recoveryConfig.uuid, 'recoveryConfig UUID');
            t.ok(recoveryConfig.created, 'recoveryConfig created');
            RECOVERY_CONFIG = recoveryConfig;
            t.equal(res.statusCode, 201, 'create rec-cfg response code');
            t.end();
        });
    });

    suite.test('Get RecoveryConfiguration', function doGet(t) {
        CLIENT.getRecoveryConfiguration({
            uuid: RECOVERY_CONFIG.uuid
        }, function (err, recoveryConfig, res) {
            t.ifError(err, 'get recovery configuration error');
            t.equal(res.statusCode, 200, 'get rec-cfg response code');
            t.deepEqual(RECOVERY_CONFIG, recoveryConfig,
                'expected recovery config');
            t.end();
        });
    });

    suite.test('Create 20 PIVTokens', function doPIVTokens(t) {
        vasync.forEachParallel({
            func: function createPIVToken(arg, next) {
                const GUID = crypto.randomBytes(16).toString('hex')
                            .toUpperCase();
                CLIENT.createToken({
                    guid: GUID,
                    token: {
                        guid: GUID,
                        pin: String(Math.floor(Math.random() * 1000000)),
                        serial: crypto.randomBytes(12).toString('hex'),
                        model: 'ACME insta-token model 1',
                        cn_uuid: arg,
                        pubkeys: {
                            /* eslint-disable max-len */
                            '9a': 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBC7NhJvp9c5XMOkPLfDvsHZytnY4cWduFRF4KlQIr7LNQnbw50NNlbyhXHzD85KjcztyMoqn9w4XuHdJh4O1lH4=',
                            '9d': 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBD+uKKyn5tBNziW21yPt/0FE2LD4l1cWgzONYjn3n8BzSNo/aTzJccki7Q/Lyk7dM8yZLAc/5V/U/QHbLTpexBg=',
                            '9e': fs.readFileSync(path.resolve(__dirname, '../../one_token_test_edcsa.pub'), 'ascii')
                            /* eslint-enable max-len */
                        },
                        recovery_configuration: RECOVERY_CONFIG.uuid
                    }
                }, function createTkCb(err, body, response) {
                    t.ifError(err, 'create token err');
                    t.equal(response.statusCode, 201,
                        'create token response code');
                    t.ok(body, 'create token body');
                    next(err);
                });
            },
            inputs: targets
        }, function paraCb(paraErr, _paraRes) {
            t.ifError(paraErr, 'Create PIVTokens error');
            t.end();
        });
    });

    suite.test('Get 404 RecoveryConfiguration', function doGet404(t) {
        CLIENT.getRecoveryConfiguration({
            uuid: '00000000-0000-0000-0000-000000000003'
        }, function (err, _recoveryConfig, res) {
            t.ok(err, 'Get recovery configuration 404');
            t.equal(res.statusCode, 404, 'get rec-cfg response code');
            t.end();
        });
    });

    suite.test('Stage recovery configuration', function doStage(t) {
        CLIENT.updateRecoveryConfiguration({
            uuid: RECOVERY_CONFIG.uuid,
            action: 'stage'
        }, function (err, body, res) {
            t.ifError(err, 'stage error');
            t.ok(Object.keys(body).length === 0, 'no transition response body');
            t.equal(204, res.statusCode, 'stage status code');
            t.equal(
                util.format(
                    '/recovery-configurations/%s?action=watch&transition=stage',
                    RECOVERY_CONFIG.uuid
                ),
                res.headers['location'],
                'location header'
            );
            t.end();
        });
    });

    suite.test('Cancel stage', function doCancelStage(t) {
        CLIENT.updateRecoveryConfiguration({
            uuid: RECOVERY_CONFIG.uuid,
            action: 'cancel'
        }, function (err, body, res) {
            t.ifError(err, 'stage error');
            t.ok(Object.keys(body).length === 0, 'no transition response body');
            t.equal(204, res.statusCode, 'stage status code');
            t.equal(
                util.format(
                    '/recovery-configurations/%s?action=watch&transition=stage',
                    RECOVERY_CONFIG.uuid
                ),
                res.headers['location'],
                'location header'
            );
            t.end();
        });
    });

    suite.test('Re-stage recovery configuration', function doReStage(t) {
        CLIENT.updateRecoveryConfiguration({
            uuid: RECOVERY_CONFIG.uuid,
            action: 'stage'
        }, function (err, body, res) {
            t.ifError(err, 'stage error');
            t.ok(Object.keys(body).length === 0, 'no transition response body');
            t.equal(204, res.statusCode, 'stage status code');
            t.equal(
                util.format(
                    '/recovery-configurations/%s?action=watch&transition=stage',
                    RECOVERY_CONFIG.uuid
                ),
                res.headers['location'],
                'location header'
            );
            t.end();
        });
    });

    suite.test('Activate single PIVToken', function doActivateOne(t) {
        t.comment('Pending');
        // we need to modify several things here so we can move ahead
        t.end();
    });

    suite.test('Activate recovery configuration', function doActivate(t) {
        t.comment('Pending');
        // we need to modify several things here so we can move ahead
        // or can also modify progressively and watch twice or more
        t.end();
    });

    suite.test('Watch recovery configuration', function doWatch(t) {
        t.comment('Pending');
        // body...
        t.end();
    });

    suite.test('Expire recovery configuration', function doExpire(t) {
        t.comment('Pending');
        // body...
        t.end();
    });

    suite.test('Reactivate recovery configuration', function doReactivate(t) {
        t.comment('Pending');
        // body...
        t.end();
    });

    suite.test('Delete RecoveryConfiguration', function doDel(t) {
        CLIENT.deleteRecoveryConfiguration({
            uuid: RECOVERY_CONFIG.uuid
        }, function delCb(err, res) {
            t.ifError(err, 'Delete RecoveryConfiguration error');
            t.equal(res.statusCode, 204, 'delete rec-cfg response code');
            t.end();
        });
    });

    suite.test('Delete 404 RecoveryConfiguration', function doDel404(t) {
        CLIENT.deleteRecoveryConfiguration({
            uuid: '00000000-0000-0000-0000-000000000003'
        }, function (err, res) {
            t.ok(err, 'Delete recovery configuration 404');
            t.equal(res.statusCode, 404, 'delete rec-cfg response code');
            t.end();
        });
    });
});


test('Stop server', function closeServers(t) {
    KBMAPI.server.close();
    mod_server.close(t);
});

// vim: set softtabstop=4 shiftwidth=4:
