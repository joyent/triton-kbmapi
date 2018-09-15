/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */

/*
 * bunyan logger for tests
 */

'use strict';

var bunyan = require('bunyan');

module.exports = bunyan.createLogger({
    name: 'kbmapi-test',
    serializers: bunyan.stdSerializers,
    streams: [
        {
            level: process.env.LOG_LEVEL || 'fatal',
            stream: process.stderr
        }
    ]
});
