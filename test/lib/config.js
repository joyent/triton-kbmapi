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

module.exports = {
    kbmapi: {
        host: process.env.KBMAPI_HOST || 'localhost',
        port: process.env.KBMAPI_PORT || 80
    }
};
