/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Unit tests for recovery configuration transition model.
 */

'use strict';
const UUID = require('node-uuid');
const VError = require('verror');

const mod_rec_cfg_tr = require(
    '../../../lib/models/recovery-configuration-transition');

const mod_log = require('../../lib/log');
const mod_server = require('../../lib/server');

const log_child = mod_log.child({
    component: 'test-server'
});

const test = require('tape');

var targets = [];
var taskids = [];
var i = 0;
while (i < 20) {
    targets.push(UUID.v4());
    taskids.push(UUID.v4());
    i += 1;
}

test('RecoveryConfigurationTransition model test', function setup(suite) {
    mod_server.setupMoray(log_child, function setupCb(setupErr, moray) {
        if (setupErr) {
            suite.comment('Skipping tests b/c moray setup failed');
            suite.end(setupErr);
            return;
        }

        var BUCKET;
        var RCT_UUID;
        var RCT;
        var ETAG;

        suite.test('Init bucket', function bucket(t) {
            mod_rec_cfg_tr.init(moray, function initCb(err) {
                t.ifError(err, 'Init bucket error');
                if (!err) {
                    BUCKET = true;
                }
                t.end();
            });
        });

        suite.test('Create RecCfgTransition', function doCreate(t) {
            if (!BUCKET) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }

            mod_rec_cfg_tr.create({
                moray: moray,
                params: {
                    recovery_config_uuid: UUID.v4(),
                    name: 'stage',
                    concurrency: 5,
                    targets: targets
                }
            }, function createCb(createErr, recCfgTr) {
                t.ifError(createErr, 'Create Error');
                t.ok(recCfgTr.params, 'recovery configuration tr params');
                t.ok(recCfgTr.params.uuid, 'recovery configuration tr uuid');
                t.equal(recCfgTr.params.forced, false,
                    'recCfgTr no --force flag');
                RCT_UUID = recCfgTr.params.uuid;
                t.ok(recCfgTr.etag, 'recovery configuration etag');
                ETAG = recCfgTr.etag;
                t.end();
            });
        });

        suite.test('Get RecCfgTransition', function doGet(t) {
            if (!RCT_UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }

            mod_rec_cfg_tr.get({
                moray: moray,
                params: {
                    uuid: RCT_UUID
                }
            }, function getCb(getErr, recCfg) {
                t.ifError(getErr, 'Get error');
                t.ok(recCfg.params, 'recovery configuration params');
                t.equal(recCfg.etag, ETAG, 'recovery configuration eTag');
                RCT = recCfg;
                t.end();
            });
        });

        suite.test('Update invalid params', function doUpInvalid(t) {
            if (!RCT_UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_rec_cfg_tr.update({
                moray: moray,
                key: RCT_UUID,
                val: {
                    targets: targets,
                    name: 'unstage',
                    recovery_config_uuid: UUID.v4(),
                    started: new Date().toISOString(),
                    locked_by: UUID.v4()
                }
            }, function upCb(upErr, _recCfgTr) {
                t.ok(upErr, 'Updated invalid parameters error');
                t.ok(VError.hasCauseWithName(upErr, 'InvalidParamsError'),
                    'invalid params');
                t.end();
            });
        });

        suite.test('Update RecCfgTransition', function doUpdate(t) {
            if (!RCT_UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_rec_cfg_tr.update({
                moray: moray,
                key: RCT_UUID,
                val: {
                    taskids: taskids.slice(0, 5),
                    started: new Date().toISOString(),
                    locked_by: UUID.v4()
                }
            }, function upCb(upErr, recCfgTr) {
                t.ifError(upErr, 'Unexpected update error');
                t.ok(recCfgTr, 'update recCfg Transition');
                RCT = recCfgTr;
                t.end();
            });
        });


        suite.test('Update invalid etag', function doUpEtag(t) {
            if (!RCT_UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_rec_cfg_tr.update({
                moray: moray,
                key: RCT_UUID,
                val: {
                    completed: targets.slice(0, 5),
                    taskids: taskids.slice(5, 10)
                },
                etag: ETAG
            }, function upCb(upErr, _recCfgTr) {
                t.ok(upErr, 'Update wrong etag error');
                t.ok(VError.hasCauseWithName(upErr, 'EtagConflictError'),
                    'etag conflict error');
                ETAG = RCT.etag;
                t.end();
            });
        });


        suite.test('Update valid etag', function doUp(t) {
            if (!RCT_UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_rec_cfg_tr.update({
                moray: moray,
                key: RCT_UUID,
                val: {
                    completed: targets.slice(0, 5),
                    taskids: taskids.slice(5, 10)
                },
                etag: ETAG
            }, function upCb(upErr, recCfgTr) {
                t.ifError(upErr, 'Unexpected update error');
                t.ok(recCfgTr, 'update recCfg Transition');
                RCT = recCfgTr;
                ETAG = RCT.etag;
                t.end();
            });
        });


        suite.test('Update finish transition', function doUpFinish(t) {
            if (!RCT_UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_rec_cfg_tr.update({
                moray: moray,
                key: RCT_UUID,
                val: {
                    completed: targets,
                    taskids: taskids,
                    finished: new Date().toISOString(),
                    locked_by: null
                },
                etag: ETAG
            }, function upCb(upErr, recCfgTr) {
                t.ifError(upErr, 'Unexpected update error');
                t.ok(recCfgTr, 'update recCfg Transition');
                RCT = recCfgTr;
                ETAG = RCT.etag;
                t.end();
            });
        });

        suite.test('Delete RecCfgTransition', function doDelete(t) {
            if (!RCT_UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_rec_cfg_tr.del({
                moray: moray,
                uuid: RCT_UUID
            }, function (delErr) {
                t.ifError(delErr, 'Deletion error');
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
