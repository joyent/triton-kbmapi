/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 *
 * `kbmctl recovery ...`
 */
'use strict';

var Cmdln = require('cmdln').Cmdln;
var util = require('util');



// ---- CLI class

function RecoveryCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: top.name + ' recovery',
        /* BEGIN JSSTYLED */
        desc: [
            'List and manage KBMAPI Recovery Configurations.'
        ].join('\n'),
        /* END JSSTYLED */
        helpOpts: {
            minHelpCol: 24 /* line up with option help */
        },
        helpSubcmds: [
            'help',
            'list',
            'get',
            'add',
            'stage',
            'activate',
            'cancel',
            'remove'// ,
//            'wait'
        ]
    });
}
util.inherits(RecoveryCLI, Cmdln);

/* eslint-disable no-unused-vars */
RecoveryCLI.prototype.init = function init(opts, args, cb) {
    this.log = this.top.log;
    Cmdln.prototype.init.apply(this, arguments);
};
/* eslint-enable no-unused-vars */

RecoveryCLI.prototype.do_list = require('./do_list');
RecoveryCLI.prototype.do_get = require('./do_get');
RecoveryCLI.prototype.do_add = require('./do_add');
RecoveryCLI.prototype.do_stage = require('./do_stage');
RecoveryCLI.prototype.do_activate = require('./do_activate');
RecoveryCLI.prototype.do_cancel = require('./do_cancel');
RecoveryCLI.prototype.do_remove = require('./do_remove');
// RecoveryCLI.prototype.do_wait = require('./do_wait');


RecoveryCLI.aliases = ['cfg'];

module.exports = RecoveryCLI;

// vim: set softtabstop=4 shiftwidth=4:
