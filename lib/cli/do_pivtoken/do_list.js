/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 *
 * `kbmctl pivtokens list ...`
 */
'use strict';

const cmdln = require('cmdln');
const jsprim = require('jsprim');
const tabula = require('tabula');

const common = require('../common.js');

// columns default without -o
const columnsDefault = 'guid,cn_uuid,active,staged';

// columns default with -l
// (same for now)
const columnsDefaultLong = columnsDefault;

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

    kbmapi.listTokens({
    }, function listCb(err, items, res) {
        if (err) {
            log.error({
                err: err
            }, 'List pivtokens error');
            cb(err);
            return;
        }

        items.forEach(function (item) {
            const rectokens = jsprim.deepCopy(item.recovery_tokens).reverse();
            item.active_token = rectokens.find(function (tk) {
                return tk.activated;
            });
            item.active = item.active_token ?
                item.active_token.recovery_configuration : null;
            item.staged_token = rectokens.find(function (tk) {
                return tk.staged;
            });
            item.staged = item.staged_token ?
                item.staged_token.recovery_configuration : null;
        });

        if (opts.json) {
            common.jsonStream(items);
        } else {
            tabula(items, {
                skipHeader: opts.H,
                columns: columns,
                sort: sort,
                dottedLookup: true
            });
        }
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
].concat(common.getCliTableOptions({
    includeLong: true,
    sortDefault: sortDefault
}));

do_list.synopses = [
    '{{name}} {{cmd}} [OPTIONS]'
];

do_list.help = [
    /* eslint-disable max-len */
    'List pivtokens.',
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
