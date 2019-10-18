/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 *
 * `kbmctl recovery get ...`
 */
'use strict';

const cmdln = require('cmdln');

function do_get(subcmd, opts, args, cb) {
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

    kbmapi.getRecoveryConfiguration({
        uuid: uuid
    }, function getCb(err, recCfg, res) {
        if (err) {
            log.error({
                err: err,
                uuid: uuid
            }, 'Get recovery configuration error');
            cb(err);
            return;
        }
        const util = require('util');
        console.log(util.inspect(recCfg, false, 8, true));
        cb();
    });
    /* eslint-enable no-invalid-this */
}

do_get.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

do_get.synopses = [
    '{{name}} {{cmd}} [OPTIONS] UUID'
];

do_get.help = [
    /* eslint-disable max-len */
    'Get a recovery configuration.',
    '',
    '{{usage}}',
    '',
    '{{options}}',
    'Where UUID is the Recovery Configuration UUID.'
    /* eslint-enable max-len */
].join('\n');

do_get.helpOpts = {
    maxHelpCol: 20
};

module.exports = do_get;
// vim: set softtabstop=4 shiftwidth=4:
