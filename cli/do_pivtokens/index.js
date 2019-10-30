/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 *
 * `kbmctl pivtokens ...`
 */
'use strict';

var Cmdln = require('cmdln').Cmdln;
var util = require('util');



// ---- CLI class

function PIVTokenCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: top.name + ' pivtoken',
        /* BEGIN JSSTYLED */
        desc: [
            'List and manage KBMAPI PIVTokens.'
        ].join('\n'),
        /* END JSSTYLED */
        helpOpts: {
            minHelpCol: 24 /* line up with option help */
        },
        helpSubcmds: [
            'help',
            'add',
            'remove',
            'list'// ,
 //           'get',
 //           'update'
        ]
    });
}
util.inherits(PIVTokenCLI, Cmdln);

/* eslint-disable no-unused-vars */
PIVTokenCLI.prototype.init = function init(opts, args, cb) {
    this.log = this.top.log;
    Cmdln.prototype.init.apply(this, arguments);
};
/* eslint-enable no-unused-vars */

PIVTokenCLI.prototype.do_list = require('./do_list');
// PIVTokenCLI.prototype.do_get = require('./do_get');
PIVTokenCLI.prototype.do_add = require('./do_add');
PIVTokenCLI.prototype.do_remove = require('./do_remove');
// PIVTokenCLI.prototype.do_update = require('./do_update');


PIVTokenCLI.aliases = ['piv'];

module.exports = PIVTokenCLI;

// vim: set softtabstop=4 shiftwidth=4:
