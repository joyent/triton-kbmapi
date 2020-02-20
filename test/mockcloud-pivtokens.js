
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Create pivtokens for the existing mockcloud servers into the given
 * Triton setup.
 *
 * Note this assumes every mockcloud server hostname will begin with 'VC'.
 */


/* eslint-disable max-len */
// In order to make all the mockcloud servers to be Zpool Encrypted run,
// within the mockcloud zone:
//
//      declare -a arr=($(ls /data/mockcloud/servers/*/sysinfo.json))
//      for i in "${arr[@]}"; do json -I -f $i -e 'this["Zpool Encrypted"] = true'; done
//
// Additionally, in order to set custom active and/or staged recovery
// configurations:
//
//      for i in "${arr[@]}"; do json -I -f $i -e 'this["Zpool Recovery"] = {"staged": "55CA0CC2BF60A1FD6B723D34EF0363C22D3A5787F4889A95508EFBCAFAA9F1A538D1818786A50986942E2C491A3707E5AEDC6BBFFD50FC3F6017CC827BA043E5", "active": "95C2E096C7709B0C98BAA873767ABDC9075AA9CF697F1D170F0572D02B4BA933AE7C2513CDD496D81146BFA27172B9F88B1F3C326DEB50C3C5CFC5E64B795C51"}'; done
//
// Note these are the values for the sample recovery configuration templates
// under test/fixtures.
//
/* eslint-enable max-len */

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

const host = process.env.KBMAPI_HOST || 'localhost';
const port = process.env.KBMAPI_PORT || config.port || 80;

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
