/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Test subcommands existence and usage
 */

'use strict';

var f = require('util').format;

var h = require('./helpers');
var test = require('tape');

var subs = [
    ['recovery'],
    ['recovery list', 'recovery ls'],
    ['recovery get'],
    ['recovery activate'],
    ['recovery stage'],
    ['recovery cancel'],
    ['recovery remove', 'recovery delete', 'recovery rm', 'recovery del'],
    ['recovery add', 'recovery create'],
    ['pivtoken', 'pivtokens'],
    ['pivtoken list', 'pivtoken ls'],
    ['pivtoken add', 'pivtoken create'],
    ['pivtoken remove', 'pivtoken delete', 'pivtoken rm', 'pivtoken del']
];


test('kbmctl subcommands', function (subcommandsSuite) {
    // loop each sub command group
    subs.forEach(function (subcmds) {
        subcommandsSuite.test(f('  [%s]', subcmds), function (suite) {
            var out = [];

            // loop each individual subcommand to test
            // triton help <subcmd>
            // triton <subcmd> -h
            subcmds.forEach(function (subcmd) {
                var helpArgs = subcmd.split(' ');
                helpArgs.splice(helpArgs.length - 1, 0, 'help');

                suite.test(f('    kbmctl %s', helpArgs.join(' ')),
                function (t) {
                    h.kbmctl(helpArgs, function (err, stdout, stderr) {
                        if (h.ifErr(t, err, 'no error')) {
                            t.end();
                            return;
                        }
                        t.equal(stderr, '', 'stderr produced');
                        t.notEqual(stdout, '', 'stdout empty');
                        out.push(stdout);
                        t.end();
                    });
                });

                var flagArgs = subcmd.split(' ').concat('-h');

                suite.test(f('    kbmctl %s', flagArgs.join(' ')),
                function (t) {
                    h.kbmctl(flagArgs, function (err, stdout, stderr) {
                        if (h.ifErr(t, err, 'no error')) {
                            t.end();
                            return;
                        }
                        t.equal(stderr, '', 'stderr produced');
                        t.notEqual(stdout, '', 'stdout empty');
                        out.push(stdout);
                        t.end();
                    });
                });
            });

            // ensure all stdout output is the same
            out.forEach(function (stdout) {
                suite.equal(stdout, out[0], 'stdout mismatch');
            });
            suite.end();
        });
    });

    subcommandsSuite.end();
});

// vim: set softtabstop=4 shiftwidth=4:
