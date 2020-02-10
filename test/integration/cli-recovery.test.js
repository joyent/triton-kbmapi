
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Test `kbmctl pivtoken ...` subcommands
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');

const test = require('tape');
const UUID = require('node-uuid');
const vasync = require('vasync');

const h = require('./helpers');
const common = require('../lib/common');
const helpers = require('../unit/helpers');
const mod_server = require('../lib/server');

const models = require('../../lib/models');

var KBMAPI;
var MORAY;
var CLIENT;
var REC_CFG;
var ANOTHER_REC_CFG;
var PIVTOKENS_CACHE = [];


var targets = [];
var i = 0;
while (i < 25) {
    targets.push(UUID.v4());
    i += 1;
}

test('Initial setup', function tInitialSetup(suite) {
    helpers.reset();
    suite.test('Create client and server', function tCreateClientServer(t) {
        helpers.createClientAndServer(function (err, client, moray, server) {
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

    suite.test('Create Recovery Configuration', function (t) {
        h.kbmctl([
            'recovery',
            'create',
            '--json',
            path.resolve(__dirname, '../fixtures/backup')
        ], function (err, stdout, stderr) {
            if (common.ifErr(t, err, 'create recovery config')) {
                t.end();
                return;
            }
            t.equal(stderr, '', 'empty stderr');
            t.ok(stdout, 'expected cmd stdout');
            try {
                REC_CFG = JSON.parse(stdout.trim());
            } catch (e) {
                console.error(e);
                t.end();
                return;
            }
            t.ok(REC_CFG, 'Recovery configuration');
            t.end();
        });
    });

    // First configuration is always staged and active by default, let's create
    // another one:
    suite.test('Create Another Recovery Configuration', function (t) {
        h.kbmctl([
            'recovery',
            'create',
            '--json',
            path.resolve(__dirname, '../fixtures/another')
        ], function (err, stdout, stderr) {
            if (common.ifErr(t, err, 'create recovery config')) {
                t.end();
                return;
            }
            t.equal(stderr, '', 'empty stderr');
            t.ok(stdout, 'expected cmd stdout');
            try {
                ANOTHER_REC_CFG = JSON.parse(stdout.trim());
            } catch (e) {
                console.error(e);
                t.end();
                return;
            }
            t.ok(ANOTHER_REC_CFG, 'Recovery configuration');
            t.end();
        });
    });

    suite.test('Get Recovery Configuration', function (t) {
        h.kbmctl([
            'recovery',
            'get',
            REC_CFG.uuid
        ], function (err, stdout, stderr) {
            if (common.ifErr(t, err, 'get recovery')) {
                t.end();
                return;
            }
            t.equal(stderr, '', 'empty stderr');
            t.ok(stdout, 'expected cmd stdout');
            t.end();
        });
    });


    suite.test('Get Recovery Configuration --json', function (t) {
        h.kbmctl([
            'recovery',
            'get',
            '--json',
            ANOTHER_REC_CFG.uuid
        ], function (err, stdout, stderr) {
            if (common.ifErr(t, err, 'get recovery')) {
                t.end();
                return;
            }
            t.equal(stderr, '', 'empty stderr');
            t.ok(stdout, 'expected cmd stdout');
            t.deepEqual(JSON.parse(stdout), ANOTHER_REC_CFG,
                'expected rec cfg');
            t.end();
        });
    });

    suite.test('List Recovery Configuration JSON', function (t) {
        h.kbmctl([
            'recovery',
            'list',
            '--json'
        ], function (err, stdout, stderr) {
            if (common.ifErr(t, err, 'list recovery')) {
                t.end();
                return;
            }
            t.equal(stderr, '', 'empty stderr');
            t.ok(stdout, 'expected cmd stdout');
            var cfgs = stdout.trim().split('\n');
            cfgs = cfgs.map(function parse(c) {
                return JSON.parse(c);
            });
            t.ok(cfgs, 'parsed recovery configs');
            t.equal(2, cfgs.length, 'got two configs');
            t.ok(cfgs[0].activated, 'first config is active');
            t.ok(cfgs[0].staged, 'first config has been staged');
            t.notOk(cfgs[1].staged, '2nd config has not been staged');
            t.notOk(cfgs[1].activated, '2nd config is not active');
            t.end();
        });
    });

    suite.test('Activate Recovery Configuration', function (t) {
        h.kbmctl([
            'recovery',
            'activate',
            ANOTHER_REC_CFG.uuid
        ], function (err, stdout, stderr) {
            t.ok(err, 'cannot activate before staging err');
            t.ok(stderr, 'got stderr');
            t.equal('', stdout, 'no stdout');
            t.end();
        });
    });

    // We will create a lot of PIVTokens here to get a proper list,
    // but w/o having to write temporary files and create them
    // through the cmdline tool:

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
                            '9e': fs.readFileSync(path.resolve(__dirname, '../fixtures/one_token_test_edcsa.pub'), 'ascii')
                            /* eslint-enable max-len */
                        },
                        recovery_configuration: REC_CFG.uuid
                    }
                }, function createTkCb(err, body, response) {
                    t.ifError(err, 'create token err');
                    t.equal(response.statusCode, 201,
                        'create token response code');
                    if (body) {
                        t.ok(body, 'create token body');
                        PIVTOKENS_CACHE.push(body);
                    }
                    next(err);
                });
            },
            inputs: targets
        }, function paraCb(paraErr, _paraRes) {
            t.ifError(paraErr, 'Create PIVTokens error');
            t.end();
        });
    });


    suite.test('Stage Recovery Configuration', function (t) {
        h.kbmctl([
            'recovery',
            'stage',
            ANOTHER_REC_CFG.uuid
        ], function (err, stdout, stderr) {
            if (common.ifErr(t, err, 'stage recovery')) {
                t.end();
                return;
            }
            t.equal(stderr, '', 'empty stderr');
            t.ok(stdout, 'expected cmd stdout');
            t.end();
        });
    });

    suite.test('List Recovery Before Staging', function (t) {
        h.kbmctl([
            'recovery',
            'list'
        ], function (err, stdout, stderr) {
            if (common.ifErr(t, err, 'list recovery')) {
                t.end();
                return;
            }
            t.equal(stderr, '', 'empty stderr');
            t.ok(stdout, 'expected cmd stdout');
            t.end();
        });
    });

    suite.test('Complete stage transition', function (t) {
        models.recovery_configuration_transition.ls({
            moray: MORAY,
            log: KBMAPI.log,
            params: {
                filter: util.format(
                    '(&(name=stage)(recovery_config_uuid=%s)(!(finished=*)))',
                    ANOTHER_REC_CFG.uuid)
            }
        }, function lsCb(lsErr, lsItems) {
            t.ifError(lsErr, 'list transition error');
            t.ok(lsItems, 'found pending stage transition');
            t.equal(1, lsItems.length, 'exactly one pending transition');
            var requests = [
                {
                    bucket: models.recovery_configuration_transition.bucket()
                        .name,
                    key: lsItems[0].key(),
                    value: Object.assign(lsItems[0].raw(), {
                        finished: new Date().toISOString(),
                        started: new Date().toISOString()
                    })
                }, {
                    bucket: models.recovery_configuration.bucket().name,
                    key: ANOTHER_REC_CFG.uuid,
                    value: Object.assign(ANOTHER_REC_CFG, {
                        staged: new Date().toISOString()
                    })
                }
            ];

            // One recover token will be created by each CN's cn-agent
            PIVTOKENS_CACHE.forEach(function addTokenRequest(piv) {
                var tk = crypto.randomBytes(40).toString('hex');
                var uuid = models.uuid(tk);
                requests.push({
                    bucket: models.recovery_token.bucket().name,
                    value: {
                        pivtoken: piv.uuid,
                        recovery_configuration: ANOTHER_REC_CFG.uuid,
                        token: tk,
                        uuid: uuid,
                        staged: new Date().toISOString()
                    },
                    key: uuid
                });
            });

            MORAY.batch(requests, function batchCb(batchErr, batchMeta) {
                t.ifError(batchErr, 'batch update error');
                t.ok(batchMeta, 'Batch update metadata ok');
                t.end();
            });
        });
    });

    suite.test('List Recovery After Staging', function (t) {
        h.kbmctl([
            'recovery',
            'list',
            '-l',
            '-H'
        ], function (err, stdout, stderr) {
            if (common.ifErr(t, err, 'list recovery')) {
                t.end();
                return;
            }
            t.equal(stderr, '', 'empty stderr');
            t.ok(stdout, 'expected cmd stdout');
            var lines = stdout.trim().split('\n');
            t.equal(2, lines.length, 'Expected list output');
            lines.forEach(function (line) {
                line = line.split(/\s+/);
                if (line[0] === REC_CFG.uuid) {
                    t.equal(0, Number(line[1]), 'expected staged tokens');
                    t.equal(PIVTOKENS_CACHE.length, Number(line[2]),
                        'expected active tokens');
                } else {
                    t.equal(PIVTOKENS_CACHE.length, Number(line[1]),
                        'expected staged tokens');
                    t.equal(0, Number(line[2]), 'expected active tokens');
                }
            });
            t.end();
        });
    });

    suite.test('Activate Recovery Configuration', function (t) {
        h.kbmctl([
            'recovery',
            'activate',
            ANOTHER_REC_CFG.uuid
        ], function (err, stdout, stderr) {
            if (common.ifErr(t, err, 'stage recovery')) {
                t.end();
                return;
            }
            t.equal(stderr, '', 'empty stderr');
            t.ok(stdout, 'expected cmd stdout');
            t.end();
        });
    });

    suite.test('Cancel Recovery Configuration', function (t) {
        h.kbmctl([
            'recovery',
            'cancel',
            ANOTHER_REC_CFG.uuid
        ], function (err, stdout, stderr) {
            if (common.ifErr(t, err, 'stage recovery')) {
                t.end();
                return;
            }
            t.equal(stderr, '', 'empty stderr');
            t.ok(stdout, 'expected cmd stdout');
            t.end();
        });
    });

    // This should fail b/c we canceled the activation of the new
    // config so, the previous one remains active:
    suite.test('Remove Recovery Configuration', function (t) {
        h.kbmctl([
            'recovery',
            'remove',
            REC_CFG.uuid,
            '--force'
        ], function (err, stdout, stderr) {
            t.ok(err, 'cannot remove active recovery config');
            t.equal(stdout, '', 'empty stdout');
            t.ok(stderr, 'expected cmd stderr');
            t.end();
        });
    });

    suite.end();
});

test('Stop server', function closeServers(t) {
    KBMAPI.server.close();
    mod_server.close(t);
});

// vim: set softtabstop=4 shiftwidth=4:
