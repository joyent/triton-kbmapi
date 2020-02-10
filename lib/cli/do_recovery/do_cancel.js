/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 *
 * `kbmctl recovery cancel ...`
 */
'use strict';

const cmdln = require('cmdln');

function do_cancel(subcmd, opts, args, cb) {
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
    var updateOpts = {
        uuid: uuid,
        action: 'cancel'
    };

    kbmapi.updateRecoveryConfiguration(updateOpts,
        function upCb(err, _recCfg, res) {
        if (err) {
            log.error({
                err: err,
                updateOpts: updateOpts
            }, 'Update recovery configuration error');
            cb(err);
            return;
        }
        console.log('done');
        cb();
    });
    /* eslint-enable no-invalid-this */
}

do_cancel.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

do_cancel.synopses = [
    '{{name}} {{cmd}} [OPTIONS] UUID'
];

do_cancel.help = [
    /* eslint-disable max-len */
    'Cancel a recovery configuration transition.',
    '',
    '{{usage}}',
    '',
    '{{options}}',
    'Where UUID is the Recovery Configuration UUID.'
    /* eslint-enable max-len */
].join('\n');

do_cancel.helpOpts = {
    maxHelpCol: 20
};

module.exports = do_cancel;
// vim: set softtabstop=4 shiftwidth=4:
