/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Unit tests for PIVTokens history model.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const VError = require('verror');

const models = require('../../../lib/models');
const mod_pivtoken = models.pivtoken;
const mod_recovery_configuration = models.recovery_configuration;
const mod_pivtoken_history = models.pivtoken_history;

const mod_log = require('../../lib/log');
const mod_server = require('../../lib/server');

const log_child = mod_log.child({
    component: 'test-server'
});

const test = require('tape');

const eboxTpl = fs.readFileSync(path.resolve(
    __dirname, '../../fixtures/backup'), 'ascii');

var TOKENS = [
    {
        guid: '75CA077A14C5E45037D7A0740D5602A5',
        pin: '12345',
        serial: 'abcd12345',
        model: 'ACME insta-token model 1',
        cn_uuid: '00000000-0000-0000-0000-000000000001',
        pubkeys: {
            /* eslint-disable max-len */
            '9a': 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBC7NhJvp9c5XMOkPLfDvsHZytnY4cWduFRF4KlQIr7LNQnbw50NNlbyhXHzD85KjcztyMoqn9w4XuHdJh4O1lH4=',
            '9d': 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBD+uKKyn5tBNziW21yPt/0FE2LD4l1cWgzONYjn3n8BzSNo/aTzJccki7Q/Lyk7dM8yZLAc/5V/U/QHbLTpexBg=',
            '9e': fs.readFileSync(path.resolve(__dirname, '../../fixtures/one_token_test_edcsa.pub'), 'ascii')
            /* eslint-enable max-len */
        }
    }
];

test('RecoveryTokenHistory model test', function setup(suite) {
    mod_server.setupMoray(log_child, function setupCb(setupErr, moray) {
        if (setupErr) {
            suite.comment('Skipping tests b/c moray setup failed');
            suite.end(setupErr);
            return;
        }

        var BUCKET;
        var RECOVERY_CONFIG;
        var PIVTOKEN;
        var ETAG;
        var GUID;

        suite.test('Init models buckets', function bucket(t) {
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
                RECOVERY_CONFIG = recCfg.params.uuid;
                t.end();
            });
        });


        suite.test('Create PIVToken', function doCreate(t) {
            if (!RECOVERY_CONFIG) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }

            mod_pivtoken.create({
                moray: moray,
                log: log_child,
                params: Object.assign(TOKENS[0], {
                    recovery_configuration: RECOVERY_CONFIG
                })
            }, function createCb(createErr, pivtoken) {
                t.ifError(createErr, 'Create Error');
                t.ok(pivtoken.params, 'PIVToken params');
                PIVTOKEN = pivtoken;
                t.end();
            });
        });


        suite.test('Create PIVToken history', function doCreateHistory(t) {
            if (!PIVTOKEN) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }

            var params = Object.assign(PIVTOKEN.serialize(), {
                recovery_tokens: PIVTOKEN.params.recovery_tokens
            });

            mod_pivtoken_history.create({
                moray: moray,
                log: log_child,
                params: params
            }, function createCb(createErr, pivtoken) {
                t.ifError(createErr, 'Create Error');
                t.ok(pivtoken.params, 'PIVToken params');
                t.ok(pivtoken.params.guid, 'PIVToken uuid');
                GUID = pivtoken.params.guid;
                t.ok(pivtoken.params.recovery_tokens,
                    'PIVToken recovery tokens');
                t.ok(pivtoken.params.active_range, 'PIVToken active_range');
                t.ok(pivtoken.etag, 'PIVToken etag');
                ETAG = pivtoken.etag;
                t.end();
            });
        });

        suite.test('Get PIVToken History', function doGet(t) {
            if (!GUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }

            mod_pivtoken_history.get({
                moray: moray,
                log: log_child,
                params: {
                    guid: GUID
                }
            }, function getCb(getErr, getPIV) {
                t.ifError(getErr, 'Get error');
                t.ok(getPIV.params, 'pivtoken params');
                t.equal(getPIV.etag, ETAG, 'recovery configuration eTag');
                t.end();
            });
        });



        suite.test('List PIVToken History', function doList(t) {
            if (!GUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_pivtoken_history.list({
                moray: moray,
                log: log_child,
                params: {}
            }, function lsCb(lsErr, lsItems) {
                t.ifError(lsErr, 'list error');
                t.ok(Array.isArray(lsItems), 'Array of list items');
                t.equal(lsItems[0].params.guid, GUID, 'Expected gUID');
                t.end();
            });
        });

        suite.test('Delete Ok', function doDelOk(t) {
            if (!GUID) {
                t.comment('Skipping tests due to previous failure');
                t.end();
                return;
            }
            mod_pivtoken_history.del({
                moray: moray,
                params: {
                    guid: GUID
                },
                log: log_child
            }, function (delErr) {
                t.ifError(delErr, 'Unexpected delete Error');

                mod_pivtoken_history.get({
                    moray: moray,
                    params: {
                        guid: GUID
                    },
                    log: log_child
                }, function getCb(getErr) {
                    t.ok(getErr, 'Expected getErr');
                    t.ok(VError.hasCauseWithName(getErr, 'ObjectNotFoundError'),
                    'Expected PIVToken history to be deleted');
                    t.end();
                });
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
