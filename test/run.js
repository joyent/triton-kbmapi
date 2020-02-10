/*
 * Copyright 2020 Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');
var fs = require('fs');
var mod_server = require('./lib/server');
var path = require('path');
var test = require('tape');

function runTests(directory) {
    fs.readdir(directory, function dirCb(err, files) {
        assert.ifError(err);
        files.filter(function fileFilter(f) {
            return (/\.test\.js$/.test(f));
        }).map(function fileMap(f) {
            return (path.join(directory, f));
        }).forEach(require);

        test('Shutdown Postgres', function stopPg(t) {
            mod_server.stopPG();
            t.end();
        });
    });
}

(function main() {
    runTests(__dirname + '/unit/models');
    runTests(__dirname + '/unit/resources');
    runTests(__dirname + '/integration');
})();

// vim: set softtabstop=4 shiftwidth=4:
