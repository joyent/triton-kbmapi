/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');
var fs = require('fs');

function validateConfig(config) {
    assert.optionalNumber(config.maxHttpSockets,
        'maxHttpSockets (maximum open connections)');
    assert.number(config.port, 'port (port number)');

    assert.object(config.moray, 'moray (moray config section)');
    if (config.moray.host) {
        assert.string(config.moray.host, 'moray.host');
        assert.number(config.moray.port, 'moray.port');
    } else {
        assert.string(config.moray.srvDomain, 'moray.srvDomain');
        assert.object(config.moray.cueballOptions, 'moray.cueballOptions');
    }
}

function loadConfig(configFile) {
    assert.string(configFile, 'configFile');
    var config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    validateConfig(config);

    return config;
}

module.exports = {
    load: loadConfig,
    validate: validateConfig
};
