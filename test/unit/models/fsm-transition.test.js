
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Unit tests for recovery configuration FSM transition.
 */

'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');

const UUID = require('node-uuid');
const vasync = require('vasync');

const models = require('../../../lib/models/');
const mod_recovery_configuration = models.recovery_configuration;
const mod_recovery_configuration_transition =
    models.recovery_configuration_transition;
const mod_recovery_token = models.recovery_token;
const fsm_transition = models.fsm_transition;
const mod_log = require('../../lib/log');
const mod_server = require('../../lib/server');

const log_child = mod_log.child({
    component: 'test-server'
});

const test = require('tape');

const eboxTpl = fs.readFileSync(path.resolve(
    __dirname, '../../fixtures/backup'), 'ascii');

var targets = [];
var taskids = [];
var i = 0;
while (i < 20) {
    targets.push(UUID.v4());
    taskids.push(UUID.v4());
    i += 1;
}

test('FSM Transition test', function setup(suite) {
    mod_server.setupMoray(log_child, function setupCb(setupErr, moray) {
        if (setupErr) {
            suite.comment('Skipping tests b/c moray setup failed');
            suite.end(setupErr);
            return;
        }

        var BUCKET;
        var REC_CFG_UUID;
        var REC_CFG;
        var TRANSITION;
        var PIVTOKENS_CACHE = [];

        suite.test('Init kbmapi_recovery_configs bucket', function bucket(t) {
            models.init({ moray: moray }, function initCb(err) {
                t.ifError(err, 'Init bucket error');
                if (!err) {
                    BUCKET = true;
                }
                t.end();
            });
        });

        suite.test('Create RecoveryConfiguration', function doCreate(t) {
            if (!BUCKET) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }

            mod_recovery_configuration.create({
                moray: moray,
                params: {
                    template: eboxTpl
                }
            }, function createCb(createErr, recCfg) {
                t.ifError(createErr, 'Create Error');
                t.ok(recCfg.params, 'recovery configuration params');
                t.ok(recCfg.params.uuid, 'recovery configuration uuid');
                REC_CFG_UUID = recCfg.params.uuid;
                REC_CFG = recCfg;
                t.ok(recCfg.params.template, 'recovery configuration template');
                t.ok(recCfg.params.created, 'recovery configuration created');
                t.ok(recCfg.etag, 'recovery configuration etag');
                t.end();
            });
        });

        suite.test('Create 20 PIVTokens', function (t) {
            vasync.forEachParallel({
                func: function createPIVToken(arg, next) {
                    models.pivtoken.create({
                        log: log_child,
                        moray: moray,
                        params: {
                            guid: crypto.randomBytes(16).toString('hex')
                                .toUpperCase(),
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
                            recovery_configuration: REC_CFG_UUID
                        }
                    }, function (pivErr, pivRes) {
                        if (pivErr) {
                            next(pivErr);
                            return;
                        }
                        t.ok(pivRes, 'PIVToken created');
                        PIVTOKENS_CACHE.push(pivRes);
                        next();
                    });
                },
                inputs: targets
            }, function paraCb(paraErr, _paraRes) {
                t.ifError(paraErr, 'Create PIVTokens error');
                t.end();
            });
        });

        // Recovery config is created active when there are no pivtokens, let's
        // reset that:
        suite.test('Reset recovery cfg', function (t) {
            mod_recovery_configuration.update({
                moray: moray,
                key: REC_CFG_UUID,
                val: {
                    staged: '',
                    activated: ''
                },
                remove: true
            }, function upCb(upErr, upRes) {
                t.ifError(upErr, 'update error');
                REC_CFG = upRes;
                t.end();
            });
        });

        suite.test('Stage without uuid and recCfg', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'stage',
                params: {}
            }, function trCb(trErr, _trRes) {
                t.ok(trErr, 'Expected stage error');
                t.end();
            });
        });


        suite.test('FSM invalid action', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'cha-cha-cha',
                params: {
                    recoveryConfiguration: REC_CFG
                }
            }, function trCb(trErr, _trRes) {
                t.ok(trErr, 'Expected stage error');
                t.end();
            });
        });

        suite.test('FSM cancel without transition in progress', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'cancel',
                params: {
                    recoveryConfiguration: REC_CFG
                }
            }, function trCb(trErr, _trRes) {
                t.ok(trErr, 'Cancel w/o transition error');
                t.end();
            });
        });

        suite.test('Cannot stage single CN', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'stage',
                params: {
                    recoveryConfiguration: REC_CFG,
                    targets: targets[0]
                }
            }, function trCb(trErr, _trRes) {
                t.ok(trErr, 'Stage single CN error');
                t.end();
            });
        });

        suite.test('Activate before stage', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'activate',
                force: true,
                params: {
                    recoveryConfiguration: REC_CFG
                }
            }, function trCb(trErr, _trRes) {
                t.ok(trErr, 'Activate before stage error');
                t.end();
            });
        });

        suite.test('Stage with UUID', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'stage',
                params: {
                    uuid: REC_CFG_UUID
                }
            }, function trCb(trErr, trRes) {
                t.ifError(trErr, 'Stage with UUID Error');
                t.ok(trRes, 'Stage with UUID result');
                t.ok(trRes.recoveryConfiguration, 'Stage with UUID recCfg');
                t.ok(trRes.transition, 'Stage with UUID recCfgTr');
                TRANSITION = trRes.transition;
                t.end();
            });
        });

        suite.test('Cancel stage transition', function (t) {
            if (!TRANSITION) {
                t.end();
                return;
            }
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'cancel',
                params: {
                    uuid: REC_CFG_UUID
                }
            }, function trCb(trErr, trRes) {
                t.ifError(trErr, 'Cancel stage transition error');
                t.ok(trRes, 'Cancel stage transition');
                if (trRes) {
                    t.equal(trRes.transition.key(), TRANSITION.key(),
                        'Cancel transition');
                }
                t.end();
            });
        });

        suite.test('Cannot re-cancel a canceled transition', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'cancel',
                params: {
                    recoveryConfiguration: REC_CFG
                }
            }, function trCb(trErr, _trRes) {
                t.ok(trErr, 're-cancel transition error');
                t.end();
            });
        });

        suite.test('Re-stage recovery configuration', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'stage',
                params: {
                    recoveryConfiguration: REC_CFG
                }
            }, function trCb(trErr, trRes) {
                t.ifError(trErr, 'Stage with UUID Error');
                t.ok(trRes, 'Stage with UUID result');
                t.ok(trRes.recoveryConfiguration, 'Stage with UUID recCfg');
                t.ok(trRes.transition, 'Stage with UUID recCfgTr');
                TRANSITION = trRes.transition;
                t.end();
            });
        });

        // This should happen once the transition has been created and the
        // runner picks it up to execute. Obviously, we are just interested
        // into the recovery tokens update which will allow us to move to
        // the next FSM status w/o errors (not anything happening for real
        // into the CNs)
        suite.test('Stage recovery tokens', function (t) {
            var newCfg = REC_CFG.raw();
            var newTr = TRANSITION.raw();
            const staged = new Date().toISOString();
            newCfg.staged = staged;
            newTr.staged = staged;
            newTr.completed = newTr.targets;
            newTr.finished = staged;
            newTr.started = staged;
            moray.batch([{
                bucket: mod_recovery_configuration.bucket().name,
                operation: 'put',
                key: REC_CFG_UUID,
                value: newCfg
            }, {
                bucket: mod_recovery_token.bucket().name,
                operation: 'update',
                filter: util.format(
                    '(recovery_configuration=%s)', REC_CFG_UUID),
                fields: {
                    staged: staged
                }
            }, {
                bucket: mod_recovery_configuration_transition.bucket().name,
                operation: 'put',
                key: TRANSITION.key(),
                value: newTr
            }], function batchCb(batchErr, batchMeta) {
                t.ifError(batchErr, 'Stage recTokens err');
                t.ok(batchMeta, 'Stage recTokens metadata');
                if (batchMeta && Array.isArray(batchMeta.etags) &&
                    batchMeta.etags.length >= 3) {
                    REC_CFG = new mod_recovery_configuration
                        .RecoveryConfiguration(Object.assign(newCfg, {
                            etag: batchMeta.etags[0].etag
                        }));
                    TRANSITION = new mod_recovery_configuration_transition
                        .RecoveryConfigurationTransition(Object.assign(newTr, {
                            etag: batchMeta.etags[2].etag
                        }));
                }
                t.end();
            });
        });

        suite.test('Activate single CN without --force', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'activate',
                params: {
                    recoveryConfiguration: REC_CFG,
                    targets: [targets[0]]
                }
            }, function trCb(trErr, _trRes) {
                t.ok(trErr, 'Activate single CN w/o --force err');
                t.end();
            });
        });

        suite.test('Activate single CN with --force', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'activate',
                params: {
                    recoveryConfiguration: REC_CFG,
                    targets: [targets[0]],
                    force: true
                }
            }, function trCb(trErr, trRes) {
                t.ifError(trErr, 'Activate single CN error');
                TRANSITION = trRes.transition;
                t.end();
            });
        });

        suite.test('Activate another CN concurrently', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'activate',
                params: {
                    force: true,
                    recoveryConfiguration: REC_CFG,
                    targets: [targets[1]]
                }
            }, function trCb(trErr, trRes) {
                t.ok(trErr, 'Activate another CN concurrently error');
                t.ok(trRes, 'Another transition info');
                t.end();
            });
        });

        suite.test('Finish CN activation', function (t) {
            moray.batch([{
                bucket: mod_recovery_token.bucket().name,
                operation: 'update',
                filter: util.format(
                    '(&(recovery_configuration=%s)(pivtoken=%s))',
                    REC_CFG_UUID, PIVTOKENS_CACHE[0].key()),
                fields: {
                    activated: new Date().toISOString()
                }
            }, {
                bucket: mod_recovery_configuration_transition.bucket().name,
                operation: 'put',
                key: TRANSITION.key(),
                value: Object.assign(TRANSITION.raw(), {
                    finished: new Date().toISOString(),
                    started: new Date().toISOString()
                })
            }], function batchCb(batchErr, batchMeta) {
                t.ifError(batchErr, 'finish CN activation error');
                t.ok(batchMeta, 'finish CN activation response');
                t.end();
            });
        });

        suite.test('Activate RecoveryConfiguration', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'activate',
                params: {
                    recoveryConfiguration: REC_CFG
                }
            }, function trCb(trErr, trRes) {
                t.ifError(trErr, 'Activate error');
                t.ok(trRes, 'Another transition info');
                TRANSITION = trRes.transition;
                t.end();
            });
        });

        // This should happen once the transition has been created and the
        // runner picks it up to execute. Obviously, we are just interested
        // in the recovery tokens update which will allow us to move to
        // the next FSM status w/o errors (not anything happening for real
        // in the CNs)
        suite.test('Activate recovery tokens', function (t) {
            var newCfg = REC_CFG.raw();
            var newTr = TRANSITION.raw();
            const activated = new Date().toISOString();
            newCfg.activated = activated;
            newTr.activated = activated;
            newTr.completed = newTr.targets;
            newTr.finished = activated;
            newTr.started = activated;
            moray.batch([{
                bucket: mod_recovery_configuration.bucket().name,
                operation: 'put',
                key: REC_CFG_UUID,
                value: newCfg
            }, {
                bucket: mod_recovery_token.bucket().name,
                operation: 'update',
                filter: util.format(
                    '(&(recovery_configuration=%s)(!(activated=*)))',
                    REC_CFG_UUID),
                fields: {
                    activated: activated
                }
            }, {
                bucket: mod_recovery_configuration_transition.bucket().name,
                operation: 'put',
                key: TRANSITION.key(),
                value: newTr
            }], function batchCb(batchErr, batchMeta) {
                t.ifError(batchErr, 'Activate recTokens err');
                t.ok(batchMeta, 'Activate recTokens metadata');
                if (batchMeta && Array.isArray(batchMeta.etags) &&
                    batchMeta.etags.length >= 3) {
                    REC_CFG = new mod_recovery_configuration
                        .RecoveryConfiguration(Object.assign(newCfg, {
                            etag: batchMeta.etags[0].etag
                        }));
                    TRANSITION = new mod_recovery_configuration_transition
                        .RecoveryConfigurationTransition(Object.assign(newTr, {
                            etag: batchMeta.etags[2].etag
                        }));
                }
                t.end();
            });
        });

        suite.test('Expire recovery configuration', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'expire',
                params: {
                    uuid: REC_CFG_UUID
                }
            }, function trCb(trErr, trRes) {
                t.ifError(trErr, 'Expire error');
                t.ok(trRes, 'Expire transition info');
                t.ok(!trRes.transition, 'No transition for expire');
                t.end();
            });
        });

        suite.test('Reactivate recovery configuration', function (t) {
            fsm_transition({
                moray: moray,
                log: log_child,
                action: 'reactivate',
                params: {
                    uuid: REC_CFG_UUID
                }
            }, function trCb(trErr, trRes) {
                t.ifError(trErr, 'Reactivate error');
                t.ok(trRes, 'Reactivate transition info');
                t.ok(!trRes.transition, 'No transition for reactivate');
                t.end();
            });
        });

        suite.test('Verify reactivation', function (t) {
            mod_recovery_token.ls({
                moray: moray,
                log: log_child,
                params: {
                    filter: util.format(
                    '(recovery_configuration=%s)', REC_CFG_UUID)
                }
            }, function lsCb(lsErr, lsRes) {
                t.ifError(lsErr, 'verify reactivation error');
                t.ok(lsRes, 'verify reactivation recovery tokens');
                if (lsRes && Array.isArray(lsRes) && lsRes.length) {
                    t.equal(targets.length, lsRes.length,
                        'verify reactivation tokens count');
                    t.ok(!lsRes[0].staged, 'token not staged');
                    t.ok(!lsRes[0].activated, 'token not active');
                    t.ok(!lsRes[0].expired, 'token not expired');
                }
                t.end();
            });
        });

        suite.test('Stop moray', function stopMoray(t) {
            moray.close();
            mod_server.stopPG();
            t.end();
        });
    });
});

// vim: set softtabstop=4 shiftwidth=4:
