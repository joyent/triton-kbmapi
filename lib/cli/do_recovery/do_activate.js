/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 *
 * `kbmctl recovery activate ...`
 */
'use strict';

const cmdln = require('cmdln');

function do_activate(subcmd, opts, args, cb) {
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
        action: 'activate'
    };

    if (opts.pivtoken) {
        updateOpts.pivtoken = opts.pivtoken;
    }

    if (opts.force) {
        updateOpts.force = opts.force;
    }

    kbmapi.updateRecoveryConfiguration(updateOpts,
        function upCb(err, recCfg, res) {
        if (err) {
            log.error({
                err: err,
                updateOpts: updateOpts
            }, 'Update recovery configuration error');
            cb(err);
            return;
        }
        const util = require('util');
        console.log(util.inspect(recCfg, false, 8, true));
        cb();
    });
    /* eslint-enable no-invalid-this */
}

do_activate.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['force', 'f'],
        type: 'bool',
        help: 'Force activation (required when pivtoken is given)\n' +
        'or when there are CNs where the recovery configuration has not\n' +
        'been staged.'
    },
    {
        names: ['pivtoken', 'p'],
        helpArg: 'PIVTOKEN',
        type: 'string',
        help: 'GUID of the PIVToken to activate (when optionally want to ' +
        'activate a single CN).'
    }
];

do_activate.synopses = [
    '{{name}} {{cmd}} [OPTIONS] UUID'
];

do_activate.help = [
    /* eslint-disable max-len */
    'Activate recovery configuration.',
    '',
    '{{usage}}',
    '',
    '{{options}}',
    'Where UUID is the Recovery Configuration UUID.'
    /* eslint-enable max-len */
].join('\n');

do_activate.helpOpts = {
    maxHelpCol: 20
};

module.exports = do_activate;
// vim: set softtabstop=4 shiftwidth=4:
