
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Create pivtokens for the existing mockcloud servers into the given
 * Triton setup.
 *
 * Note this assumes every mockcloud server hostname will begin with 'VC'.
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const util = require('util');
const vasync = require('vasync');
const UUID = require('node-uuid');
const kbmapi = require('../client');

const MC_RE = /^VC*/;

const mod_config = require('../lib/config');
const config = mod_config.load(path.resolve(__dirname, '../config.json'));

const mod_cnapi = require('sdc-clients').CNAPI;
const cnapi = new mod_cnapi(config.cnapi);


const privkeyPath = path.resolve(__dirname + '/../etc/sdc_key');
const PRIVKEY = fs.readFileSync(privkeyPath, 'ascii');
const PUBKEY = fs.readFileSync(privkeyPath + '.pub', 'ascii');

var host = 'localhost';
var port = process.env.KBMAPI_PORT || 80;

if (config.host) {
    host = config.host;
} else if (process.env.KBMAPI_HOST) {
    host = process.env.KBMAPI_HOST;
} else {
    port = config.port;
}

const KBMAPI = new kbmapi({
    agent: false,
    headers: { 'x-request-id': UUID.v4() },
    url: util.format('http://%s:%d', host, port)
});

cnapi.listServers(function lsCb(lsErr, lsServers) {
    if (lsErr) {
        console.error('Error listing servers: ' + lsErr);
        process.exit(1);
    }

    const servers = lsServers.filter(function (srv) {
        return MC_RE.test(srv.hostname);
    });


        vasync.forEachParallel({
            func: function createPIVToken(arg, next) {
                const GUID = crypto.randomBytes(16).toString('hex')
                            .toUpperCase();
                KBMAPI.createToken({
                    guid: GUID,
                    privkey: PRIVKEY,
                    pubkey: PUBKEY,
                    token: {
                        guid: GUID,
                        pin: String(Math.floor(Math.random() * 1000000)),
                        serial: crypto.randomBytes(12).toString('hex'),
                        model: 'ACME insta-token model 1',
                        cn_uuid: arg.uuid,
                        pubkeys: {
                            /* eslint-disable max-len */
                            '9a': 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBC7NhJvp9c5XMOkPLfDvsHZytnY4cWduFRF4KlQIr7LNQnbw50NNlbyhXHzD85KjcztyMoqn9w4XuHdJh4O1lH4=',
                            '9d': 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBD+uKKyn5tBNziW21yPt/0FE2LD4l1cWgzONYjn3n8BzSNo/aTzJccki7Q/Lyk7dM8yZLAc/5V/U/QHbLTpexBg=',
                            '9e': fs.readFileSync(path.resolve(__dirname, './fixtures/one_token_test_edcsa.pub'), 'ascii')
                            /* eslint-enable max-len */
                        }
                    }
                }, function createTkCb(err, body, _response) {
                    console.log(util.inspect(body, false, 8, true));
                    next(err);
                });
            },
            inputs: servers
        }, function paraCb(paraErr, _paraRes) {
            if (paraErr) {
                console.error('Error creating pivtokens: ' + paraErr);
                process.exit(2);
            }
        });
});



// vim: set softtabstop=4 shiftwidth=4:
