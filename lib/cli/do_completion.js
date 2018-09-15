/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 *
 * `kbmctl completion`
 */

'use strict';

function do_completion(subcmd, opts, _args, cb) {
    // Given how cmdln instantiates the subcommands, this rule is useless:
    /* eslint-disable no-invalid-this */
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    console.log(this.bashCompletion({includeHidden: true}));
    cb();
}

do_completion.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
do_completion.help = [
    'Output bash completion code for the `kbmctl` CLI.',
    '',
    'By default, kbmctl installation should setup for Bash completion.',
    'However, you can update the completions as follows:',
    '',
    '    kbmctl completion >/opt/smartdc/kbmapi/etc/kbmctl.completion \\',
    '       && source /opt/smartdc/kbmapi/etc/kbmctl.completion'
].join('\n');
do_completion.hidden = true;

module.exports = do_completion;
