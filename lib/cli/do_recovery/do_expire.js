/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 *
 * `kbmctl recovery expire ...`
 */
'use strict';

const util = require('util');

const cmdln = require('cmdln');
const vasync = require('vasync');

const common = require('../common.js');

function do_expire(subcmd, opts, args, cb) {
    // Given how cmdln instantiates the subcommands, this rule is useless:
    /* eslint-disable no-invalid-this */
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length !== 0) {
        cb(new cmdln.UsageError('incorrect number of arguments'));
        return;
    }

    var log = this.top.log;
    var kbmapi = this.top.kbmapi;

    vasync.pipeline({funcs: [
        function confirm(_, next) {
            if (opts.force) {
                next();
                return;
            }

            common.promptYesNo({
                msg: 'Expire Unused Recovery Configurations? [y/n] '
            }, function (answer) {
                if (answer !== 'y') {
                    console.error('Aborting');
                    next(true); // early abort signal
                    return;
                }
                next();
            });
        },

        function expireRecoveryCfg(_, next) {
            kbmapi.expireRecoveryConfigurations({
            }, function expireCb(err, body, res) {
                if (err) {
                    log.error({
                        err: err
                    }, 'expire recovery configurations error');
                    next(err);
                    return;
                }
                if (Array.isArray(body) && body.length) {
                    console.log(util.format(
                        'Recovery Configurations successfuly expired: %s',
                        body.map(function toUuid(c) {
                            return c.uuid;
                        }).join(', ')));
                } else {
                    console.log('There are no unused recovery configurations');
                }
                next();
            });
        }

    ]}, cb);

    /* eslint-enable no-invalid-this */
}

do_expire.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['force', 'f'],
        type: 'bool',
        help: 'Skip confirmation of expiration.'
    }
];

do_expire.synopses = [
    '{{name}} {{cmd}} [OPTIONS]'
];

do_expire.help = [
    /* eslint-disable max-len */
    'Expire unused recovery configurations.',
    '',
    '{{usage}}',
    '',
    '{{options}}'
    /* eslint-enable max-len */
].join('\n');

do_expire.helpOpts = {
    maxHelpCol: 20
};

module.exports = do_expire;
// vim: set softtabstop=4 shiftwidth=4:
