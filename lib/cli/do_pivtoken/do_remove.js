/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 *
 * `kbmctl pivtokens remove ...`
 */
'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const cmdln = require('cmdln');
const vasync = require('vasync');

const common = require('../common.js');
const privkeyPath = path.resolve(__dirname, '../../../etc/sdc_key');

function do_remove(subcmd, opts, args, cb) {
    // Given how cmdln instantiates the subcommands, this rule is useless:
    /* eslint-disable no-invalid-this */
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length === 0) {
        cb(new cmdln.UsageError('missing GUID argument'));
        return;
    } else if (args.length > 1) {
        cb(new cmdln.UsageError('incorrect number of arguments'));
        return;
    }

    var log = this.top.log;
    var kbmapi = this.top.kbmapi;
    const guid = args[0];

    const privkey = fs.readFileSync(privkeyPath, 'ascii');
    const pubkey = fs.readFileSync(privkeyPath + '.pub', 'ascii');
    if (!privkey || !pubkey) {
        const msg = util.format('Error trying to read sdc key: %s',
            privkeyPath);
        console.error(msg);
        cb(new cmdln.CmdlnError({message: msg}));
        return;
    }

    vasync.pipeline({funcs: [
        function confirm(_, next) {
            if (opts.force) {
                next();
                return;
            }

            common.promptYesNo({
                msg: util.format('Delete PIVToken %s? [y/n] ', guid)
            }, function (answer) {
                if (answer !== 'y') {
                    console.error('Aborting');
                    next(true); // early abort signal
                    return;
                }
                next();
            });
        },

        function removePIVToken(_, next) {
            kbmapi.deleteToken({
                guid: guid,
                privkey: privkey,
                pubkey: pubkey
            }, function removeCb(err, res) {
                if (err) {
                    log.error({
                        err: err,
                        uuid: guid
                    }, 'Remove PIVToken error');
                    next(err);
                    return;
                }
                console.log('PIVToken successfuly removed.');
                next();
            });
        }

    ]}, cb);
    /* eslint-enable no-invalid-this */
}

do_remove.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['force', 'f'],
        type: 'bool',
        help: 'Skip confirmation of delete.'
    }
];

do_remove.synopses = [
    '{{name}} {{cmd}} [OPTIONS] GUID'
];

do_remove.help = [
    /* eslint-disable max-len */
    'Remove a PIVToken.',
    '',
    '{{usage}}',
    '',
    '{{options}}',
    'Where GUID is the PIVToken GUID.'
    /* eslint-enable max-len */
].join('\n');

do_remove.helpOpts = {
    maxHelpCol: 20
};

do_remove.aliases = ['rm', 'delete', 'del'];

module.exports = do_remove;
// vim: set softtabstop=4 shiftwidth=4:
