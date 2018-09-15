/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Unit tests for recovery tokens model.
 */

'use strict';

// TODO: test listing by multiple pivtokens guids

const fs = require('fs');
const path = require('path');
const VError = require('verror');

const models = require('../../../lib/models/');
const mod_recovery_configuration = models.recovery_configuration;
const mod_recovery_token = models.recovery_token;

const mod_log = require('../../lib/log');
const mod_server = require('../../lib/server');

const log_child = mod_log.child({
    component: 'test-server'
});

const test = require('tape');

const eboxTpl = fs.readFileSync(path.resolve(
    __dirname, '../../fixtures/backup'), 'ascii');

test('RecoveryToken model test', function setup(suite) {
    mod_server.setupMoray(log_child, function setupCb(setupErr, moray) {
        if (setupErr) {
            suite.comment('Skipping tests b/c moray setup failed');
            suite.end(setupErr);
            return;
        }

        var BUCKET;
        var UUID;
        var TOKEN;
        var ETAG;
        var REC_CFG;


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
                REC_CFG = recCfg;
                t.ok(recCfg.params.template, 'recovery configuration template');
                t.ok(recCfg.params.created, 'recovery configuration created');
                t.ok(recCfg.etag, 'recovery configuration etag');
                t.end();
            });
        });

        suite.test('Init kbmapi_recovery_tokens bucket', function bucket(t) {
            mod_recovery_token.init(moray, function initCb(err) {
                t.ifError(err, 'Init bucket error');
                if (!err) {
                    BUCKET = true;
                }
                t.end();
            });
        });

        suite.test('Create RecoveryToken', function doCreate(t) {
            if (!BUCKET) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }

            mod_recovery_token.create({
                moray: moray,
                params: {
                    pivtoken: '75CA077A14C5E45037D7A0740D5602A5',
                    recovery_configuration:
                        REC_CFG.key()
                }
            }, function createCb(createErr, recTk) {
                t.ifError(createErr, 'Create Error');
                t.ok(recTk.params, 'recovery token params');
                t.ok(recTk.params.uuid, 'recovery token uuid');
                UUID = recTk.params.uuid;
                t.ok(recTk.params.token, 'recovery token');
                TOKEN = recTk.params.token;
                t.ok(recTk.params.created, 'recovery token created');
                t.ok(recTk.etag, 'recovery token etag');
                t.ok(recTk.template, 'recovery configuration template');
                ETAG = recTk.etag;
                t.end();
            });
        });

        suite.test('Get RecoveryToken', function doGet(t) {
            if (!UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }

            mod_recovery_token.get({
                moray: moray,
                params: {
                    uuid: UUID
                }
            }, function getCb(getErr, recTk) {
                t.ifError(getErr, 'Get error');
                t.ok(recTk.params, 'recovery token params');
                t.equal(recTk.etag, ETAG, 'recovery token eTag');
                t.end();
            });
        });

        suite.test('Update RecoveryToken', function doUpdate(t) {
            if (!UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_recovery_token.update({
                moray: moray,
                key: UUID,
                val: {
                    staged: new Date().toISOString()
                }
            }, function (upErr, recTk) {
                t.ifError(upErr, 'Update error');
                t.ok(recTk, 'Updated recovery token');
                t.ok(recTk.etag !== ETAG, 'Etag changed after update');
                t.ok(recTk.params, 'Updated params');
                t.ok(recTk.params.staged, 'recovery token staged');
                t.end();
            });
        });

        suite.test('Update wrong ETAG', function wrongEtag(t) {
            if (!UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_recovery_token.update({
                moray: moray,
                key: UUID,
                val: {
                    staged: new Date().toISOString()
                },
                remove: true,
                etag: ETAG
            }, function (upErr, _recTk) {
                t.ok(upErr, 'expected update error');
                t.ok(VError.hasCauseWithName(upErr, 'EtagConflictError'),
                    'Expected eTag error');
                t.end();
            });
        });

        suite.test('List RecoveryToken', function doList(t) {
            if (!UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_recovery_token.ls({
                moray: moray,
                log: log_child,
                params: {}
            }, function lsCb(lsErr, lsItems) {
                t.ifError(lsErr, 'list error');
                t.ok(Array.isArray(lsItems), 'Array of list items');
                t.equal(lsItems[0].params.uuid, UUID, 'Expected UUID');
                t.end();
            });
        });

        suite.test('Avoid duplicate RecoveryToken', function doDup(t) {
            if (!UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_recovery_token.create({
                moray: moray,
                params: {
                    token: TOKEN,
                    pivtoken: '75CA077A14C5E45037D7A0740D5602A5',
                    recovery_configuration: REC_CFG.key()
                }
            }, function createCb(createErr) {
                t.ok(createErr, 'Expected createErr');
                t.ok(VError.hasCauseWithName(createErr, 'EtagConflictError'),
                    'Expected eTag error');
                t.end();
            });
        });

        suite.test('Avoid Delete wrongEtag', function doDelWrongEtag(t) {
            if (!UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_recovery_token.del({
                moray: moray,
                uuid: UUID,
                etag: ETAG
            }, function (delErr) {
                t.ok(delErr, 'Expected deleteErr');
                t.ok(VError.hasCauseWithName(delErr, 'EtagConflictError'),
                    'Expected eTag error');
                t.end();
            });
        });

        suite.test('Delete RecoveryToken', function doDelete(t) {
            if (!UUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_recovery_token.del({
                moray: moray,
                uuid: UUID
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
