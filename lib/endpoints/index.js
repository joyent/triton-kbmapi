/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * The kbmapi endpoints
 */

'use strict';

/*
 * Endpoints are in their own individual files, in a directory structure
 * that roughly matches their routes, eg:
 *   /pivtokens -> pivtokens.js
 *   /recovery-configs -> recovery-configs.js
 */
var toRegister = {
    '/pivtokens': require('./pivtokens'),
    '/recovery-configurations': require('./recovery-configurations')
};

/*
 * Register all endpoints with the restify server
 */
function registerEndpoints(http, before, log) {
    for (var t in toRegister) {
        log.debug('Registering endpoints for "%s"', t);
        toRegister[t].registerEndpoints(http, before, log);
    }
}

module.exports = {
    registerEndpoints: registerEndpoints
};
// vim: set softtabstop=4 shiftwidth=4:
