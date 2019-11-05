/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 *
 * `kbmctl pivtokens add ...`
 */
'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const cmdln = require('cmdln');
const vasync = require('vasync');

const common = require('../common.js');
const privkeyPath = path.resolve(__dirname, '../../etc/sdc_key');

function do_add(subcmd, opts, args, cb) {
    // Given how cmdln instantiates the subcommands, this rule is useless:
    /* eslint-disable no-invalid-this */
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length === 0) {
        cb(new cmdln.UsageError('missing PIVTOKEN argument'));
        return;
    } else if (args.length > 1) {
        cb(new cmdln.UsageError('incorrect number of arguments'));
        return;
    }

    var log = this.top.log;
    var kbmapi = this.top.kbmapi;
    const filePath = args[0];
    var context = {
        cli: this.top
    };

    vasync.pipeline({arg: context, funcs: [
        function gatherDataStdin(ctx, next) {
            if (filePath !== '-') {
                next();
                return;
            }

            common.readStdin(function gotStdin(stdin) {
                ctx.data = stdin;
                ctx.from = '<stdin>';
                next();
            });
        },

        function gatherDataFile(ctx, next) {
            if (!filePath || filePath === '-') {
                next();
                return;
            }

            ctx.data = fs.readFileSync(filePath, 'utf8');
            try {
                ctx.data = JSON.parse(ctx.data);
            } catch (e) {
                console.error('Error parsing JSON Data');
                next(e);
                return;
            }
            ctx.from = filePath;
            next();
        },

        function loadSshKey(ctx, next) {
            ctx.privkey = fs.readFileSync(privkeyPath, 'ascii');
            ctx.pubkey = fs.readFileSync(privkeyPath + '.pub', 'ascii');
            if (!ctx.privkey || !ctx.pubkey) {
                var msg = util.format('Error trying to read sdc key: %s',
                    privkeyPath);
                console.error(msg);
                next(new cmdln.CmdlnError({message: msg}));
                return;
            }
            next();
        },

        function createPIVToken(ctx, next) {
            kbmapi.createToken({
                token: ctx.data,
                guid: ctx.data.guid,
                privkey: ctx.privkey,
                pubkey: ctx.pubkey
            }, function createCb(createErr, pivtoken, res) {
                if (createErr) {
                    next(createErr);
                    return;
                }
                ctx.statusCode = res.statusCode;
                ctx.pivtoken = pivtoken;
                next();
            });
        }
    ]}, function pipeCb(pipeErr) {
        if (pipeErr) {
            log.error({
                err: pipeErr,
                data: context.data
            }, 'Add PIVToken error');
            cb(pipeErr);
            return;
        }

        if (opts.json) {
            console.log(JSON.stringify(context.pivtoken));
        } else {
            var msg = 'PIVToken ';
            msg += (context.statusCode === 200) ? 'already exists' : 'created';
            msg += ' (' + context.pivtoken.guid + ').';
            console.log(msg);
        }
        cb();
    });
    /* eslint-enable no-invalid-this */
}

do_add.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'JSON stream output.'
    }
];

do_add.synopses = [
    '{{name}} {{cmd}} [OPTIONS] PIVTOKEN'
];

do_add.help = [
    /* eslint-disable max-len */
    'Create a new PIVToken.',
    '',
    '{{usage}}',
    '',
    '{{options}}',
    'Where PIVTOKEN is the path to a JSON file containing PIVToken details',
    'or "-" to pass the raw JSON on stdin.'
    /* eslint-enable max-len */
].join('\n');

do_add.helpOpts = {
    maxHelpCol: 20
};

do_add.aliases = ['create'];

module.exports = do_add;
// vim: set softtabstop=4 shiftwidth=4:
