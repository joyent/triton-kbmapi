/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 *
 * `kbmctl recovery add ...`
 */
'use strict';

const cmdln = require('cmdln');
const util = require('util');
const fs = require('fs');
const vasync = require('vasync');

const common = require('../common.js');


function do_add(subcmd, opts, args, cb) {
    // Given how cmdln instantiates the subcommands, this rule is useless:
    /* eslint-disable no-invalid-this */
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length === 0) {
        cb(new cmdln.UsageError('missing TEMPLATE argument'));
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

            ctx.data = fs.readFileSync(filePath, 'ascii');
            ctx.from = filePath;
            next();
        },

        function createConfig(ctx, next) {
            kbmapi.createRecoveryConfiguration({
                template: ctx.data
            }, function createCb(createErr, recCfg, res) {
                if (createErr) {
                    next(createErr);
                    return;
                }
                ctx.statusCode = res.statusCode;
                ctx.recoveryConfig = recCfg;
                next();
            });
        }
    ]}, function pipeCb(pipeErr) {
        if (pipeErr) {
            log.error({
                err: pipeErr,
                template: context.data
            }, 'Add recovery configuration error');
            cb(pipeErr);
            return;
        }
        if (context.statusCode === 202) {
            console.log('Recovery configuration already exists.');
        } else {
            console.log('Recovery configuration created.');
        }
        console.log(util.inspect(context.recoveryConfig, false, 8, true));
        cb();
    });
    /* eslint-enable no-invalid-this */
}

do_add.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

do_add.synopses = [
    '{{name}} {{cmd}} [OPTIONS] TEMPLATE'
];

do_add.help = [
    /* eslint-disable max-len */
    'Create a new recovery configuration.',
    '',
    '{{usage}}',
    '',
    '{{options}}',
    'Where TEMPLATE is the path to a Recovery Configuration template',
    'created using pivy-box, or "-" to pass the template on stdin.'
    /* eslint-enable max-len */
].join('\n');

do_add.helpOpts = {
    maxHelpCol: 20
};

module.exports = do_add;
// vim: set softtabstop=4 shiftwidth=4:
