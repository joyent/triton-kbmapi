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
const tabula = require('tabula');
const vasync = require('vasync');

const common = require('../common.js');

// columns default without -o
const columnsDefault = 'uuid,staged_tokens,activated_tokens,state';

// columns default with -l
// (same for now)
const columnsDefaultLong = columnsDefault +
    ',created,staged,activated,expired';

// sort default with -s
const sortDefault = 'created';

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


    var columns = columnsDefault;
    if (opts.o) {
        columns = opts.o;
    } else if (opts.long) {
        columns = columnsDefaultLong;
    }
    columns = columns.split(',');

    var sort = opts.s.split(',');

    var log = this.top.log;
    var kbmapi = this.top.kbmapi;

    // We need to retrieve all the PIV Tokens with a Recovery Token associated
    // with each recovery configuration, alongside the state of such recovery
    // token. So, we need the public fields of the recovery tokens.
    kbmapi.listRecoveryConfigurations({
    }, function listCb(err, items, res) {
        if (err) {
            log.error({
                err: err
            }, 'List recovery configurations error');
            cb(err);
            return;
        }

        vasync.forEachParallel({
            inputs: items,
            func: function fetchTokens(arg, next) {
                kbmapi.listRecoveryConfigurationTokens({
                    uuid: arg.uuid
                }, function lsCb(listErr, tokens) {
                    if (listErr) {
                        next(listErr);
                        return;
                    }
                    arg.tokens = tokens;
                    next();
                });
            }
        }, function paraCb(paraErr) {
            if (paraErr) {
                log.error({
                    err: paraErr
                }, 'List recovery configuration tokens error');
                cb(paraErr);
                return;
            }

            if (opts.json) {
                common.jsonStream(items);
            } else {
                items = items.map(function prepForPrinting(item) {
                    if (item.tokens && item.tokens.length) {
                        item.staged_tokens = item.tokens.filter(
                            function fStaged(t) {
                            return (t.staged && !t.activated && !t.expired);
                        }).length;

                        item.activated_tokens = item.tokens.filter(
                            function fActivated(t) {
                            return (t.activated && !t.expired);
                        }).length;
                    } else {
                        item.staged_tokens = item.activated_tokens = 0;
                    }
                    item.state = item.expired ? 'expired' :
                        item.activated ? 'active' :
                        item.staged ? 'staged' : 'created';
                    return item;
                });
                tabula(items, {
                    skipHeader: opts.H,
                    columns: columns,
                    sort: sort,
                    dottedLookup: true
                });
            }
            cb();
        });
    });
    /* eslint-enable no-invalid-this */
}

do_list.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
].concat(common.getCliTableOptions({
    includeLong: true,
    sortDefault: sortDefault
}));

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
