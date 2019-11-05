/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
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
const helpers = require('../unit/helpers');
const mod_server = require('../lib/server');

var KBMAPI;
var MORAY;
var CLIENT;
var REC_CFG;
var PIVTOKENS_CACHE = [];
var PIVTK;


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
            if (h.ifErr(t, err, 'create recovery config')) {
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

    suite.test('Create PIVToken', function (t) {
        h.kbmctl([
            'pivtoken',
            'create',
            '--json',
            path.resolve(__dirname, '../fixtures/pivtoken.json')
        ], function (err, stdout, stderr) {
            if (h.ifErr(t, err, 'create pivtoken')) {
                t.end();
                return;
            }
            t.equal(stderr, '', 'empty stderr');
            t.ok(stdout, 'expected cmd stdout');
            try {
                PIVTK = JSON.parse(stdout.trim());
            } catch (e) {
                console.error(e);
                t.end();
                return;
            }
            t.ok(PIVTK, 'PIVToken');
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


    suite.test('List PIVTokens', function (t) {
        h.kbmctl([
            'pivtoken',
            'list'
        ], function (err, stdout, stderr) {
            if (h.ifErr(t, err, 'list pivtoken')) {
                t.end();
                return;
            }
            t.equal(stderr, '', 'empty stderr');
            t.ok(stdout, 'expected cmd stdout');
            var lines = stdout.trim().split('\n');
            t.equal(lines.length, targets.length + 2,
                'expected number of pivtokens');
            t.end();
        });
    });

    suite.test('Get PIVToken', function (t) {
        // body...
        t.end();
    });

    suite.test('Update PIVToken', function (t) {
        // body...
        t.end();
    });

    suite.test('Remove PIVToken', function (t) {
        h.kbmctl([
            'pivtoken',
            'remove',
            PIVTK.guid,
            '--force'
        ], function (err, stdout, stderr) {
            if (h.ifErr(t, err, 'remove pivtoken')) {
                t.end();
                return;
            }
            t.equal(stderr, '', 'empty stderr');
            t.ok(stdout, 'expected cmd stdout');
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
