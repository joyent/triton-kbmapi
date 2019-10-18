/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 *
 * `kbmctl recovery remove ...`
 */
'use strict';

const cmdln = require('cmdln');

function do_remove(subcmd, opts, args, cb) {
    // Given how cmdln instantiates the subcommands, this rule is useless:
    /* eslint-disable no-invalid-this */
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length === 0) {
        cb(new cmdln.UsageError('missing UUID argument'));
        return;
    } else if (args.length > 1) {
        cb(new cmdln.UsageError('incorrect number of arguments'));
        return;
    }

    var log = this.top.log;
    var kbmapi = this.top.kbmapi;
    const uuid = args[0];

    kbmapi.deleteRecoveryConfiguration({
        uuid: uuid
    }, function removeCb(err, res) {
        if (err) {
            log.error({
                err: err,
                uuid: uuid
            }, 'Remove recovery configuration error');
            cb(err);
            return;
        }
        console.log('Recovery Configuration successfuly removed.');
        cb();
    });
    /* eslint-enable no-invalid-this */
}

do_remove.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

do_remove.synopses = [
    '{{name}} {{cmd}} [OPTIONS] UUID'
];

do_remove.help = [
    /* eslint-disable max-len */
    'Remove a recovery configuration.',
    '',
    '{{usage}}',
    '',
    '{{options}}',
    'Where UUID is the Recovery Configuration UUID.'
    /* eslint-enable max-len */
].join('\n');

do_remove.helpOpts = {
    maxHelpCol: 20
};

module.exports = do_remove;
// vim: set softtabstop=4 shiftwidth=4:
