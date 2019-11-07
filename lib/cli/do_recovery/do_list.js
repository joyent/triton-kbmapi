/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 *
 * `kbmctl recovery list ...`
 */
'use strict';

const cmdln = require('cmdln');

function do_list(subcmd, opts, args, cb) {
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

    kbmapi.listRecoveryConfigurations({
    }, function listCb(err, items, res) {
        if (err) {
            log.error({
                err: err
            }, 'List recovery configuration error');
            cb(err);
            return;
        }
        const util = require('util');
        console.log(util.inspect(items, false, 8, true));
        cb();
    });
    /* eslint-enable no-invalid-this */
}

do_list.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

do_list.synopses = [
    '{{name}} {{cmd}} [OPTIONS]'
];

do_list.help = [
    /* eslint-disable max-len */
    'List recovery configurations.',
    '',
    '{{usage}}',
    '',
    '{{options}}'
    /* eslint-enable max-len */
].join('\n');

do_list.helpOpts = {
    maxHelpCol: 20
};

do_list.aliases = ['ls'];

module.exports = do_list;
// vim: set softtabstop=4 shiftwidth=4:
