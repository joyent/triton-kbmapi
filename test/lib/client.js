/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Test helpers for dealing with the KBMAPI client
 */

'use strict';


// --- Globals



var CLIENT;



// --- Exports



function getClient() {
    if (!CLIENT) {
        throw new Error('KBMAPI client not initialized!');
    }

    return CLIENT;
}


function initialized() {
    return (CLIENT !== undefined && CLIENT !== null);
}


function setClient(client) {
    CLIENT = client;
}

module.exports = {
    initialized: initialized,
    get: getClient,
    set: setClient
};
