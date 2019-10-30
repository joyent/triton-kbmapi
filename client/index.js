/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Client library for the Triton Key Backup and Management API (KBMAPI)
 */

'use strict';

const cp = require('child_process');
const util = require('util');
const format = util.format;

const assert = require('assert-plus');
const httpSignature = require('http-signature');
const jsprim = require('jsprim');
const restifyClients = require('restify-clients');

const AUTHZ_FMT =
  'Signature keyId="%s",algorithm="%s",headers="%s",signature="%s"';


// --- Exported Client


/*
 * This is an example from kbmd:
 * date="$(LC_TIME=C TZ=GMT date +"%a, %d %b %Y %T %Z")"
 * sig="$(printf "$date" | $PIVYTOOL sign 9e | $OPENSSL enc -base64 -A)"
 *
 * pin=$($CURL -sS \
 *  -H "Date: $date" \
 *  -H "Authorization: $sig" \
 *  "$url" | json pin) || exit 1
 *
 */

var SIGNER;
var PRIVKEY;
var PRIVTOKEN;
var PUBKEY;
var OPENSSL;
var PIVYTOOL;
var AUTH_REQUIRED;

function requestSigner(req) {
    // Let each method decide if we need http auth, either using HMAC or
    // http signature. And do nothing for methods not needing it.
    if (!AUTH_REQUIRED) {
        return false;
    }

    if (SIGNER === 'httpSignature') {
        if (PRIVTOKEN) {
            httpSignature.signRequest(req, {
                key: PRIVTOKEN,
                keyId: 'recovery_token',
                algorithm: 'hmac-sha256'
            });
        } else {
            httpSignature.signRequest(req, {
                key: PRIVKEY,
                keyId: httpSignature.sshKeyFingerprint(PUBKEY)
            });
        }
    } else {
        var date = req.getHeader('Date');
        if (!date) {
            date = jsprim.rfc1123(new Date());
            req.setHeader('Date', date);
        }

        const cmd = format('printf "%s" | %s sign 9e | %s enc -base64 -A',
                         'date: ' + date, PIVYTOOL, OPENSSL);
        try {
            var result = cp.execSync(cmd);
        } catch (err) {
            req.log.error({err: err}, 'PIVYTOOL sign error');
            return false;
        }

        result = result.toString().trim();

        // It might be empty and we could be setting an empty signature:
        if (!result) {
            return false;
        }

        const hdr = util.format(AUTHZ_FMT,
            httpSignature.sshKeyFingerprint(PUBKEY),
            'ecdsa-sha256',
            'date',
            result
        );

        req.setHeader('Authorization', hdr);
    }
    return true;
}

function KBMAPI(options) {
    assert.object(options, 'options');
    assert.string(options.url, 'options.url');
    assert.optionalObject(options.contentMd5, 'options.contentMd5');

    if (!options.contentMd5) {
        options.contentMd5 = {
            encodings: ['utf8', 'binary']
        };
    }

    options.signRequest = function signRequest(req) {
        requestSigner(req);
    };

    this.client = restifyClients.createJsonClient(options);
}

/**
 * Creates a pivtoken
 *
 * @param {Object} opts object containing:
 *      - {String} guid: (required) the guid of the token.
 *      - {Object} token: (required) the token to be created.
 *      - {Function} privkey: (optional) private key to sign the request and
 *        generate the HTTP Signature Auth header which will be used to perform
 *        the HTTP request authentication using the token 9e pubkey.
 * @param {Function} cb: of the form f(err, token, res)
 *
 */
KBMAPI.prototype.createToken = function createToken(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.guid, 'opts.guid');
    assert.object(opts.token, 'opts.token');
    assert.func(cb, 'cb');

    opts.token.guid = opts.guid;

    var reqOpts = Object.assign(opts, {
        path: '/pivtokens',
        data: opts.token,
        method: 'POST',
        authRequired: true,
        pubkey: opts.pubkey || opts.token.pubkeys['9e']
    });

    this._request(reqOpts, function reqCb(err, req, res, body) {
        cb(err, body, res);
    });
};


/**
 * Replaces a pivtoken with a new one, using the initial pivtoken's
 * recovery_token value as the key for authentication using HMAC.
 *
 * @param {Object} opts object containing:
 *      - {String} guid: (required) the guid of the token to be replaced.
 *      - {String} recovery_token: (required) the recovery token of the token
 *        to be replaced.
 *      - {Object} token: (required) the new token to be created.
 * @param {Function} cb: of the form f(err, token, res)
 *
 */
KBMAPI.prototype.replaceToken = function replaceToken(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.guid, 'opts.guid');
    assert.string(opts.recovery_token, 'opts.recovery_token');
    assert.object(opts.token, 'opts.token');
    assert.func(cb, 'cb');

    var reqOpts = Object.assign(opts, {
        path: '/pivtokens/' + opts.guid + '/replace',
        data: {
            token: opts.token
        },
        method: 'POST',
        authRequired: true,
        privtoken: opts.recovery_token
    });

    this._request(reqOpts, function reqCb(err, req, res, body) {
        cb(err, body, res);
    });
};

/**
 * Deletes the pivtoken specified by GUID
 *
 * @param {Object} opts object containing:
 *      - {String} guid: (required) the guid of the token to be destroyed.
 * @param {Function} cb: of the form f(err, res)
 */
KBMAPI.prototype.deleteToken = function deleteToken(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.guid, 'opts.guid');
    assert.func(cb, 'cb');


    var reqOpts = Object.assign(opts, {
        path: format('/pivtokens/%s', opts.guid),
        method: 'DELETE',
        authRequired: true
    });

    this._request(reqOpts, function reqCb(err, req, res) {
        cb(err, res);
    });
};

/**
 * List all tokens
 *
 * @param {Object} opts object containing any list filtering argument
 *          like `offset`, `limit` ...
 * @param {Function} cb: of the form f(err, tokens, res)
 */
KBMAPI.prototype.listTokens = function listTokens(opts, cb) {
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');


    var reqOpts = Object.assign(opts, {
        authRequired: false,
        method: 'GET',
        path: '/pivtokens',
        query: opts
    });

    this._request(reqOpts, function reqCb(err, req, res, body) {
        cb(err, body, res);
    });
};

// XXX No update for the moment

/**
 * Gets the public information about a token
 *
 * @param {Object} opts object containing:
 *      - {String} guid: (required) the guid of the token.
 * @param {Function} cb: of the form f(err, token, res)
 */
KBMAPI.prototype.getToken = function getToken(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.guid, 'opts.guid');
    assert.func(cb, 'cb');

    var reqOpts = Object.assign(opts, {
        authRequired: false,
        path: format('/pivtokens/%s', opts.guid),
        method: 'GET'
    });

    this._request(reqOpts, function reqCb(err, req, res, body) {
        cb(err, body, res);
    });
};

/**
 * Gets the token info including PIN.
 * This is a HTTP Signature authenticated request
 *
 * @param {Object} opts object containing:
 *      - {String} guid: (required) the guid of the token.
 * @param {Function} callback: of the form f(err, token, res)
 */
KBMAPI.prototype.getTokenPin = function getTokenPin(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.guid, 'opts.guid');
    assert.func(cb, 'cb');

    var reqOpts = Object.assign(opts, {
        authRequired: true,
        path: format('/pivtokens/%s/pin', opts.guid),
        method: 'GET'
    });

    this._request(reqOpts, function reqCb(err, req, res, body) {
        cb(err, body, res);
    });
};


/**
 * KBMAPI Recovery Configurations management
 */


/**
 * Creates a recovery configuration
 *
 * @param {Object} opts object containing:
 *      - {String} template: (required) the template for the recovery
 *        configuration to be created.
 * @param {Function} cb: of the form f(err, recovery_configuration, res)
 *
 */
KBMAPI.prototype.createRecoveryConfiguration =
function createRecoveryConfiguration(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.template, 'opts.template');
    assert.func(cb, 'cb');

    var reqOpts = Object.assign(opts, {
        path: '/recovery-configurations',
        data: {
            template: opts.template
        },
        method: 'POST',
        authRequired: false
    });

    this._request(reqOpts, function reqCb(err, req, res, body) {
        cb(err, body, res);
    });
};


/**
 * Deletes the recovery configuration specified by UUID
 *
 * @param {Object} opts object containing:
 *      - {String} uuid: (required) the uuid of the token to be destroyed.
 * @param {Function} cb: of the form f(err, res)
 */
KBMAPI.prototype.deleteRecoveryConfiguration =
function deleteRecoveryConfiguration(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.func(cb, 'cb');


    var reqOpts = Object.assign(opts, {
        path: format('/recovery-configurations/%s', opts.uuid),
        method: 'DELETE',
        authRequired: false
    });

    this._request(reqOpts, function reqCb(err, req, res) {
        cb(err, res);
    });
};

/**
 * List all recovery configurations
 *
 * @param {Object} opts object containing any list filtering argument
 *          like `offset`, `limit`, `filter` ...
 * @param {Function} cb: of the form f(err, recovery_configurations, res)
 */
KBMAPI.prototype.listRecoveryConfigurations =
function listRecoveryConfigurations(opts, cb) {
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    var reqOpts = Object.assign(opts, {
        authRequired: false,
        method: 'GET',
        path: '/recovery-configurations',
        query: opts
    });

    this._request(reqOpts, function reqCb(err, req, res, body) {
        cb(err, body, res);
    });
};

/**
 * Gets the public information about a recovery configuration
 *
 * @param {Object} opts object containing:
 *      - {String} uuid: (required) the uuid of the recovery configuration.
 * @param {Function} cb: of the form f(err, recovery_configuration, res)
 */
KBMAPI.prototype.getRecoveryConfiguration =
function getRecoveryConfiguration(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.func(cb, 'cb');

    var reqOpts = Object.assign(opts, {
        authRequired: false,
        path: format('/recovery-configurations/%s', opts.uuid),
        method: 'GET'
    });

    this._request(reqOpts, function reqCb(err, req, res, body) {
        cb(err, body, res);
    });
};


/**
 * Updates a recovery configuration
 *
 * @param {Object} opts object containing:
 *      - {String} uuid: (required) the uuid of the recovery configuration.
 *      - {String} action: (required) the transition to be performed by
 *        the recovery configuration or 'cancel' to abort the current one
 *        in progress.
 *      - {String} pivtoken: (optional) the GUID of a PIVToken to be
 *        activated standalone for testing purposes. Note this is valid
 *        only when action === 'activate'
 *      - {Boolean} force: (optional) required when we want to either use
 *        a single PIVToken for activation, or when we want to activate
 *        a given recovery configuration despite of some PIVTokens not being
 *        staged for this configuration.
 * @param {Function} cb: of the form f(err, recovery_configuration, res)
 *
 */
KBMAPI.prototype.updateRecoveryConfiguration =
function updateRecoveryConfiguration(opts, cb) {
    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');
    assert.string(opts.action, 'opts.action');
    assert.optionalString(opts.pivtoken, 'opts.pivtoken');
    assert.optionalBool(opts.force, 'opts.force');
    assert.func(cb, 'cb');

    var data = {
        action: opts.action
    };

    if (opts.force) {
        data.force = opts.force;
    }

    if (opts.pivtoken) {
        data.pivtoken = opts.pivtoken;
    }

    var reqOpts = Object.assign(opts, {
        path: format('/recovery-configurations/%s', opts.uuid),
        data: data,
        method: 'PUT',
        authRequired: false
    });

    this._request(reqOpts, function reqCb(err, req, res, body) {
        cb(err, body, res);
    });
};
/**
 * KBMAPI request wrapper - modeled after http.request.
 *
 * Pretty much the same thing used by node-triton's CloudAPI library
 * without users & roles information.
 *
 * @param {Object|String} opts - object or string for endpoint
 *      - {String} path - URL endpoint to hit
 *      - {String} method - HTTP(s) request method
 *      - {Object} data - data to be passed
 *      - {Object} headers - optional additional request headers
 * @param {Function} cb passed via the restify client

 */
KBMAPI.prototype._request = function _request(opts, cb) {
    var self = this;

    if (typeof (opts) === 'string') {
        opts = {
            path: opts
        };
    }
    assert.object(opts, 'opts');
    assert.optionalObject(opts.data, 'opts.data');
    assert.optionalString(opts.method, 'opts.method');
    assert.string(opts.path, 'opts.path');
    assert.optionalObject(opts.headers, 'opts.headers');
    assert.optionalString(opts.privkey, 'opts.privkey');
    assert.optionalString(opts.privtoken, 'opts.privtoken');
    assert.optionalString(opts.pubkey, 'opts.pubkey');
    assert.optionalString(opts.pivytool, 'opts.pivytool');
    assert.optionalString(opts.openssl, 'opts.openssl');
    assert.optionalBool(opts.authRequired, 'opts.authRequired');
    assert.func(cb, 'cb');

    const method = (opts.method || 'GET').toLowerCase();
    assert.ok(['get', 'post', 'put', 'delete', 'head'].indexOf(method) >= 0,
        'invalid HTTP method given');
    const clientFnName = (method === 'delete' ? 'del' : method);

    SIGNER = (opts.privkey || opts.privtoken) ? 'httpSignature' : 'pivytool';

    var reqOpts = {
        token: opts.data,
        method: method,
        path: opts.path
    };

    if (opts.headers) {
        reqOpts.headers = opts.headers;
    }

    if (opts.privkey) {
        PRIVKEY = opts.privkey;
    } else if (opts.privtoken) {
        PRIVTOKEN = opts.privtoken;
    } else {
        PIVYTOOL = process.env.PIVYTOOL ||
                    opts.pivytool ||
                    '/usr/sbin/pivy-tool';
        OPENSSL = process.env.OPENSSL ||
                    opts.openssl ||
                    '/usr/bin/openssl';
    }

    if (opts.pubkey) {
        PUBKEY = opts.pubkey;
    }

    if (opts.authRequired) {
        AUTH_REQUIRED = true;
    }

    if (opts.data) {
        self.client[clientFnName](reqOpts, opts.data, cb);
    } else {
        self.client[clientFnName](reqOpts, cb);
    }
};

// Get rid of any global variables set by a _request invocation
KBMAPI.prototype.clean = function clean() {
    SIGNER = null;
    PRIVKEY = null;
    PUBKEY = null;
    PRIVTOKEN = null;
    PIVYTOOL = null;
    OPENSSL = null;
    AUTH_REQUIRED = null;
};

module.exports = KBMAPI;
// vim: set softtabstop=4 shiftwidth=4:
