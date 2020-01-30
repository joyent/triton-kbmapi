/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Test configuration
 */

'use strict';

var fmt = require('util').format;

var KBMAPI_HOST = process.env.KBMAPI_HOST || 'localhost';
var KBMAPI_PORT = process.env.KBMAPI_PORT || 80;

var CONFIG = {
    kbmapi: {
        host: fmt('http://%s:%d', KBMAPI_HOST, KBMAPI_PORT)
    }
};

module.exports = CONFIG;
