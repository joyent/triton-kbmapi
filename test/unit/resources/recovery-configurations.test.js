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
const util = require('util');


const UUID = require('node-uuid');
const vasync = require('vasync');

const h = require('../helpers');
const mod_log = require('../../lib/log');
const mod_server = require('../../lib/server');
const models = require('../../../lib/models');
const mocks = require('../../lib/mocks');
const KbmApiTransitioner = require('../../../transitioner').KbmApiTransitioner;
const test = require('tape');

const eboxTpl = fs.readFileSync(path.resolve(
    __dirname, '../../fixtures/backup'), 'ascii');


const log_child = mod_log.child({
    component: 'test-server'
});

var KBMAPI;
var MORAY;
var CLIENT;
var RECOVERY_CONFIG;
var TRANSITIONER;
var PIVTOKENS_CACHE = [];

var targets = [];
var i = 0;
while (i < 25) {
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

    suite.test('Create transitioner', function (t) {
        TRANSITIONER = new KbmApiTransitioner({
            moray: MORAY,
            cnapi: new mocks.cnapi(MORAY),
            log: log_child,
            config: {
                instanceUuid: 'dc7cdc64-f03d-4e74-b710-0e9f174918e9'
            }
        });
        TRANSITIONER.on('initialized', function started() {
            // Run transitions.
            // Then stop the transitioner until something else makes it
            // run again.
            t.end();
        });
        TRANSITIONER.start();
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

    suite.test('Re-Create RecoveryConfiguration', function doCreate(t) {
        CLIENT.createRecoveryConfiguration({
            template: eboxTpl
        }, function createCb(err, recoveryConfig, res) {
            t.ifError(err, 'create recovery configuration error');
            t.ok(recoveryConfig, 'recoveryConfig');
            t.ok(recoveryConfig.uuid, 'recoveryConfig UUID');
            t.equal(res.statusCode, 202, 're-create rec-cfg response code');
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

    suite.test('Create 25 PIVTokens', function doPIVTokens(t) {
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
                            '9e': fs.readFileSync(path.resolve(__dirname, '../../fixtures/one_token_test_edcsa.pub'), 'ascii')
                            /* eslint-enable max-len */
                        },
                        recovery_configuration: RECOVERY_CONFIG.uuid
                    }
                }, function createTkCb(err, body, response) {
                    t.ifError(err, 'create token err');
                    t.equal(response.statusCode, 201,
                        'create token response code');
                    t.ok(body, 'create token body');
                    PIVTOKENS_CACHE.push(body);
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

    // Recovery config is created active when there are no pivtokens, let's
    // reset that:
    suite.test('Reset recovery cfg', function (t) {
        models.recovery_configuration.update({
            moray: MORAY,
            key: RECOVERY_CONFIG.uuid,
            val: {
                staged: '',
                activated: ''
            },
            remove: true
        }, function upCb(upErr, _upRes) {
            t.ifError(upErr, 'update error');
            t.end();
        });
    });

    suite.test('Run not yet existing stage transition', function (t) {
        TRANSITIONER.runTransition(function runCb(runErr, pendingTrs) {
            t.ifError(runErr, 'unexpected transitioner err');
            t.notOk(pendingTrs, 'should not be pending transtions');
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

    suite.test('Run canceled stage transition', function (t) {
        TRANSITIONER.runTransition(function runCb(runErr, pendingTrs) {
            t.ifError(runErr, 'unexpected transitioner err');
            t.notOk(pendingTrs, 'should not be pending transtions');
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

    suite.test('Run stage transition', function (t) {
        TRANSITIONER.runTransition(function runCb(runErr, runRes) {
            t.ifError(runErr, 'transitioner run error');
            t.equal(runRes.length, 0, 'transitioner run results');
            t.end();
        });
    });

    suite.test('Activate single PIVToken', function doActivateOne(t) {
        CLIENT.updateRecoveryConfiguration({
            uuid: RECOVERY_CONFIG.uuid,
            action: 'activate',
            pivtoken: PIVTOKENS_CACHE[0].guid,
            force: true
        }, function (err, body, res) {
            t.ifError(err, 'activate error');
            t.ok(Object.keys(body).length === 0, 'no transition response body');
            t.equal(204, res.statusCode, 'activate status code');
            t.equal(
                util.format(
                    '/recovery-configurations/%s?action=watch&' +
                    'transition=activate',
                    RECOVERY_CONFIG.uuid
                ),
                res.headers['location'],
                'location header'
            );
            t.end();
        });
    });

    suite.test('Run activate PIVToken transition', function (t) {
        TRANSITIONER.runTransition(function runCb(runErr, runRes) {
            t.ifError(runErr, 'transitioner run error');
            t.equal(runRes.length, 0, 'transitioner run results');
            t.end();
        });
    });

    suite.test('Verify token', function doVerify(t) {
        // The recovery token should be active now, but the configuration
        // should remain staged b/c we activated a single pivtoken:
        models.recovery_token.ls({
            moray: MORAY,
            log: log_child,
            params: {
                filter: util.format(
                    '(&(recovery_configuration=%s)(activated=*))',
                    RECOVERY_CONFIG.uuid)
            }
        }, function lsCb(lsErr, lsTk) {
            t.ifErr(lsErr, 'list tokens error');
            t.ok(lsTk, 'list token');
            t.equal(lsTk.length, 25, 'token is active');
            t.end();
        });
    });

    suite.test('Activate recovery configuration', function doActivate(t) {
        CLIENT.updateRecoveryConfiguration({
            uuid: RECOVERY_CONFIG.uuid,
            action: 'activate'
        }, function (err, body, res) {
            t.ifError(err, 'activate error');
            t.ok(Object.keys(body).length === 0, 'no transition response body');
            t.equal(204, res.statusCode, 'activate status code');
            t.equal(
                util.format(
                    '/recovery-configurations/%s?action=watch&' +
                    'transition=activate',
                    RECOVERY_CONFIG.uuid
                ),
                res.headers['location'],
                'location header'
            );
            t.end();
        });
    });

    suite.test('Watch recovery configuration', function doWatch(t) {
        t.comment('Pending');
        // body...
        t.end();
    });

    suite.test('Run activate transition', function (t) {
        TRANSITIONER.runTransition(function runCb(runErr, runRes) {
            t.ifError(runErr, 'transitioner run error');
            t.equal(runRes.length, 0, 'transitioner run results');
            t.end();
        });
    });

    suite.test('Verify tokens', function doVerify(t) {
        models.recovery_token.ls({
            moray: MORAY,
            log: log_child,
            params: {
                filter: util.format(
                    '(&(recovery_configuration=%s)(activated=*))',
                    RECOVERY_CONFIG.uuid)
            }
        }, function lsCb(lsErr, lsTk) {
            t.ifErr(lsErr, 'list tokens error');
            t.ok(lsTk, 'list tokens');
            t.equal(lsTk.length, targets.length, 'tokens are active');
            t.end();
        });
    });

    suite.test('Delete RecoveryConfig before expire', function doDel(t) {
        CLIENT.deleteRecoveryConfiguration({
            uuid: RECOVERY_CONFIG.uuid
        }, function delCb(err, res) {
            t.ok(err, 'Cannot delete recovery config if not expired');
            t.equal(res.statusCode, 412, 'delete rec-cfg response code');
            t.end();
        });
    });

    suite.test('Expire recovery configuration', function doExpire(t) {
        CLIENT.updateRecoveryConfiguration({
            uuid: RECOVERY_CONFIG.uuid,
            action: 'expire'
        }, function (err, body, res) {
            t.ifError(err, 'activate error');
            t.ok(Object.keys(body).length === 0, 'no transition response body');
            t.equal(204, res.statusCode, 'activate status code');
            CLIENT.getRecoveryConfiguration({
                uuid: RECOVERY_CONFIG.uuid
            }, function getCb(getErr, cfg) {
                t.ifError(getErr, 'recovery configuration error');
                t.ok(cfg.expired, 'recovery configuration is expired');
                t.end();
            });
        });
    });

    suite.test('Verify tokens', function doVerify(t) {
        models.recovery_token.ls({
            moray: MORAY,
            log: log_child,
            params: {
                filter: util.format(
                    '(&(recovery_configuration=%s)(expired=*))',
                    RECOVERY_CONFIG.uuid)
            }
        }, function lsCb(lsErr, lsTk) {
            t.ifErr(lsErr, 'list tokens error');
            t.ok(lsTk, 'list tokens');
            t.equal(lsTk.length, targets.length, 'tokens are expired');
            t.end();
        });
    });

    suite.test('Reactivate recovery configuration', function doReactivate(t) {
        CLIENT.updateRecoveryConfiguration({
            uuid: RECOVERY_CONFIG.uuid,
            action: 'reactivate'
        }, function (err, body, res) {
            t.ifError(err, 'activate error');
            t.ok(Object.keys(body).length === 0, 'no transition response body');
            t.equal(204, res.statusCode, 'activate status code');
            CLIENT.getRecoveryConfiguration({
                uuid: RECOVERY_CONFIG.uuid
            }, function getCb(getErr, cfg) {
                t.ifError(getErr, 'recovery configuration error');
                t.notOk(cfg.expired, 'recovery configuration is not expired');
                t.notOk(cfg.activated, 'recovery config is not activated');
                t.notOk(cfg.staged, 'recovery configuration is not staged');
                t.end();
            });
        });
    });

    suite.test('Verify tokens', function doVerify(t) {
        models.recovery_token.ls({
            moray: MORAY,
            log: log_child,
            params: {
                filter: util.format(
                    '(&(recovery_configuration=%s)(expired=*))',
                    RECOVERY_CONFIG.uuid)
            }
        }, function lsCb(lsErr, lsTk) {
            t.ifErr(lsErr, 'list tokens error');
            t.ok(lsTk, 'list tokens');
            t.equal(lsTk.length, 0, 'tokens are just created');
            t.end();
        });
    });

    suite.test('List recovery configurations', function doList(t) {
        CLIENT.listRecoveryConfigurations({
        }, function lsCb(lsErr, lsItems) {
            t.ifError(lsErr, 'list error');
            t.ok(lsItems, 'list recovery configs');
            t.end();
        });
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
    TRANSITIONER.stop(function () {
        mod_server.close(t);
    });
});

// vim: set softtabstop=4 shiftwidth=4:
