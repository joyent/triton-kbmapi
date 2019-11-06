/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * The kbmapi PIVTokens endpoints
 */

'use strict';

const util = require('util');

const models = require('../models');
const mod_pivtoken = models.pivtoken;
const mod_recovery_token = models.recovery_token;
const mod_pivtoken_history = models.pivtoken_history;
const mod_auth = require('../auth');

const assert = require('assert-plus');
const restify = require('restify');

/*
 * Pre-load a pivtoken, given req.params.guid. This will be used to verify auth
 * using http signature against pivtoken's pubkeys 9E for the methods requiring
 * this kind of authentication.
 */
function preloadPivtoken(req, res, next) {
    if (!req.params || !req.params.guid &&
        (!req.params.token || !req.params.token.guid)) {
        next();
        return;
    }

    mod_pivtoken.getPin({
        moray: req.app.moray,
        log: req.log,
        params: {
            guid: req.params.guid || req.params.token.guid
        }
    }, function getPivtokenCb(err, token) {
        if (err) {
            if (err.statusCode === 404) {
                next();
                return;
            }
            next(err);
            return;
        }

        req.pivtoken = token.serialize();
        req.rawToken = token.raw();
        next();
    });
}


/*
 * Archive and then remove the given pivtoken from pivtokens bucket.
 * Used either to directly delete an existing pivtoken or during
 * pivtoken recovery for a given CN.
 *
 * @param {Object} moray connection object
 * @param {Object} log Bunyan instance logger object
 * @param {Object} token Raw pivtoken object
 * @param {Function} cb of the form f(err)
 */

function archiveAndDeletePivtoken(moray, log, token, cb) {
    assert.object(moray, 'moray');
    assert.object(log, 'log');
    assert.object(token, 'token');
    assert.func(cb, 'cb');
    assert.string(token.guid, 'token.guid');

    mod_pivtoken_history.create({
        moray: moray,
        log: log,
        params: token
    }, function createTkHistoryCb(historyErr) {
        if (historyErr) {
            cb(historyErr);
            return;
        }

        mod_pivtoken.del({
            moray: moray,
            log: log,
            params: token
        }, function delPivtokenCb(err) {
            if (err) {
                cb(err);
                return;
            }

            cb();
        });
    });
}
/**
 * GET /pivtokens: List all pivtokens
 *
 * This is not an authenticated request. Only "public" fields are listed.
 */
function listPivtokens(req, res, next) {
    mod_pivtoken.list({
        moray: req.app.moray,
        log: req.log,
        params: req.params
    }, function listPivtokenCb(err, tokens) {
        if (err) {
            next(err);
            return;
        }

        res.send(200, tokens.map(function serialize(token) {
            return token.serialize();
        }));
        next();
    });
}

/**
 * GET /pivtokens/:guid: get a specific token
 *
 * This is not an authenticated request. Only "public" fields are retrieved.
 */
function getPivtoken(req, res, next) {
    mod_pivtoken.get({
        moray: req.app.moray,
        log: req.log,
        params: req.params
    }, function getPivtokenCb(err, token) {
        if (err) {
            next(err);
            return;
        }

        if (!token) {
            next(new restify.ResourceNotFoundError('pivtoken not found'));
            return;
        }

        res.send(200, token.serialize());
        next();
    });
}

/**
 * GET /pivtokens/:guid/pin: get the pin for a specific pivtoken
 *
 * This is a HTTP Signature Authenticated request.
 */
function getPivtokenPin(req, res, next) {
    if (!req.pivtoken) {
        next(new restify.ResourceNotFoundError('pivtoken not found'));
        return;
    }

    res.send(200, req.pivtoken);
    next();
}

/**
 * POST /pivtokens: Add a new pivtoken.
 *
 * In order to allow the client to retrieve the create request response
 * in case it was lost, if we find that the pivtoken already exists, we'll
 * just return it.
 *
 * This is a HTTP Signature Authenticated request if the Pivtoken already
 * exists. Otherwise, a new Pivtoken can be created w/o Authentication.
 *
 * _Anyway_, to be able to retrieve a lost response, it's recommended
 * to always use HTTP Signature.
 */
function createPivtoken(req, res, next) {
    var latestToken;
    if (req.pivtoken) {
        latestToken = req.pivtoken.recovery_tokens[
            req.pivtoken.recovery_tokens.length - 1];
        const tokenCreated = new Date(latestToken.created).getTime();
        const now = new Date().getTime();
        if ((tokenCreated - now < req.config.recoveryTokenDuration * 1000) &&
            req.params.recovery_configuration ===
            latestToken.recovery_configuration) {
            res.send(200, req.pivtoken);
            next();
            return;
        }
    }

    var createOpts = {
        moray: req.app.moray,
        log: req.log
    };

    if (req.pivtoken) {
        mod_recovery_token.create(Object.assign({ params: {
            pivtoken: req.pivtoken.guid,
            recovery_configuration: req.params.recovery_configuration ||
            latestToken.recovery_configuration
        }}, createOpts), function createRecoveryTokenCb(err, rec) {
            if (err) {
                next(err);
                return;
            }
            req.pivtoken.recovery_tokens.push(rec.serialize());
            res.send(200, req.pivtoken);
            next();
        });
    } else {
        mod_pivtoken.create(Object.assign(createOpts, {
            params: req.params
        }), function (err, token) {
            if (err) {
                next(err);
                return;
            }

            res.send(201, token.serialize());
            next();
        });
    }
}

/**
 * DELETE /pivtokens/:guid: delete a pivtoken
 *
 * This is a HTTP Signature Authenticated request.
 */
function deletePivtoken(req, res, next) {
    if (!req.pivtoken) {
        next(new restify.ResourceNotFoundError('pivtoken not found'));
        return;
    }

    archiveAndDeletePivtoken(req.app.moray, req.log, req.rawToken,
        function delCb(err) {
        if (err) {
            next(err);
            return;
        }
        res.send(204);
        next();
    });
}


/**
 * POST /pivtokens/:guid/replace: replace the given pivtoken :guid with a new
 * (provided) token.
 *
 * This is a request authenticated using HMAC and original pivtoken's
 * recovery_token.
 *
 * TODO: Modify to use moray batches instead.
 */
function replacePivtoken(req, res, next) {
    if (!req.pivtoken) {
        next(new restify.ResourceNotFoundError('pivtoken not found'));
        return;
    }

    archiveAndDeletePivtoken(req.app.moray, req.log, req.rawToken,
        function delCb(err) {
        if (err) {
            next(err);
            return;
        }

        mod_pivtoken.create({
            moray: req.app.moray,
            log: req.log,
            params: req.params.token
        }, function (createErr, token) {
            if (createErr) {
                next(createErr);
                return;
            }

            res.send(201, token.serialize());
            next();
        });
    });
}

// XXX: to-do:
// UpdatePivtoken (PUT /pivtokens/:guid)
// Currently, the only field that can be altered is the cn_uuid field
// (e.g. during a chassis swap). If the new cn_uuid field is already
// associated with an assigned token, or if any of the remaining fields differ,
// the update fails.

// This request is authenticated by signing the Date header with the token's 9e
// key (same as CreatePivtoken). This however does not return the recovery token
// in it's response.



function listRecoveryTokens(req, res, next) {
    if (!req.pivtoken) {
        next(new restify.ResourceNotFoundError('pivtoken not found'));
        return;
    }

    mod_recovery_token.ls({
        moray: req.app.moray,
        log: req.log,
        params: {
            filter: util.format('(&(pivtoken=%s))', req.pivtoken.guid)
        }
    }, function lsCb(lsErr, recTokens) {
        if (lsErr) {
            next(lsErr);
            return;
        }

        res.send(200, recTokens.map(function serialize(token) {
            return token.serialize();
        }));
        next();
    });
}

function createRecoveryToken(req, res, next) {
    if (!req.pivtoken) {
        next(new restify.ResourceNotFoundError('pivtoken not found'));
        return;
    }

    const latestToken = req.pivtoken.recovery_tokens[
            req.pivtoken.recovery_tokens.length - 1];
    mod_recovery_token.create({
        moray: req.app.moray,
        params: {
            pivtoken: req.pivtoken.guid,
            recovery_configuration: req.params.recovery_configuration ||
                latestToken.recovery_configuration
        }
    }, function createCb(createErr, recTk) {
        if (createErr) {
            next(createErr);
            return;
        }

        res.send(201, recTk.serialize());
        next();
    });
}

function preloadRecoveryToken(req, res, next) {
    if (!req.params || !req.params.uuid) {
        next();
        return;
    }

    mod_recovery_token.get({
        moray: req.app.moray,
        log: req.log,
        params: {
            uuid: req.params.uuid
        }
    }, function getRecTokenCb(err, token) {
        if (err) {
            if (err.statusCode === 404) {
                next();
                return;
            }
            next(err);
            return;
        }

        req.recovery_token = token.serialize();
        next();
    });
}

function getRecoveryToken(req, res, next) {
    if (!req.pivtoken) {
        next(new restify.ResourceNotFoundError('pivtoken not found'));
        return;
    }

    if (!req.recovery_token) {
        next(new restify.ResourceNotFoundError('recovery token not found'));
        return;
    }

    res.send(200, req.recovery_token);
    next();
}

function updateRecoveryToken(req, res, next) {
    if (!req.pivtoken) {
        next(new restify.ResourceNotFoundError('pivtoken not found'));
        return;
    }

    if (!req.recovery_token) {
        next(new restify.ResourceNotFoundError('recovery token not found'));
        return;
    }

    var val = {};
    ['staged', 'activated', 'expired'].forEach(function (p) {
        if (req.params[p]) {
            val[p] = req.params[p];
        }
    });

    mod_recovery_token.update({
        moray: req.app.moray,
        key: req.recovery_token.uuid,
        val: val
    }, function (upErr, recTk) {
        if (upErr) {
            next(upErr);
            return;
        }
        res.send(200, recTk.serialize());
        next();
    });
}

function deleteRecoveryToken(req, res, next) {
    if (!req.pivtoken) {
        next(new restify.ResourceNotFoundError('pivtoken not found'));
        return;
    }

    if (!req.recovery_token) {
        next(new restify.ResourceNotFoundError('recovery token not found'));
        return;
    }

    mod_recovery_token.del({
        moray: req.app.moray,
        uuid: req.recovery_token.uuid
    }, function (delErr) {
        if (delErr) {
            next(delErr);
            return;
        }
        res.send(204);
        next();
    });
}

function registerEndpoints(http, before) {
    http.get({
        path: '/pivtokens',
        name: 'listpivtokens'
    }, before, listPivtokens);
    http.post({
        path: '/pivtokens',
        name: 'createpivtoken'
    }, before, preloadPivtoken, mod_auth.signatureAuth, createPivtoken);
    http.get({
        path: '/pivtokens/:guid',
        name: 'getpivtoken'
    }, before, getPivtoken);
    http.del({
        path: '/pivtokens/:guid',
        name: 'delpivtoken'
    }, before, preloadPivtoken, mod_auth.signatureAuth, deletePivtoken);
    http.get({
        path: '/pivtokens/:guid/pin',
        name: 'getpivtokenpin'
    }, before, preloadPivtoken, mod_auth.signatureAuth, getPivtokenPin);
    http.post({
        path: '/pivtokens/:guid/replace',
        name: 'replacepivtoken'
    }, before, preloadPivtoken, mod_auth.signatureAuth, replacePivtoken);
    http.get({
        path: '/pivtokens/:guid/recovery-tokens',
        name: 'listtokens'
    }, before, preloadPivtoken, mod_auth.signatureAuth, listRecoveryTokens);
    http.post({
        path: '/pivtokens/:guid/recovery-tokens',
        name: 'createtoken'
    }, before, preloadPivtoken, mod_auth.signatureAuth, createRecoveryToken);
    http.get({
        path: '/pivtokens/:guid/recovery-tokens/:uuid',
        name: 'gettoken'
    }, before, preloadPivtoken, mod_auth.signatureAuth,
        preloadRecoveryToken, getRecoveryToken);
    http.put({
        path: '/pivtokens/:guid/recovery-tokens/:uuid',
        name: 'updatetoken'
    }, before, preloadPivtoken, mod_auth.signatureAuth,
        preloadRecoveryToken, updateRecoveryToken);
    http.del({
        path: '/pivtokens/:guid/recovery-tokens/:uuid',
        name: 'deltoken'
    }, before, preloadPivtoken, mod_auth.signatureAuth,
        preloadRecoveryToken, deleteRecoveryToken);
}

module.exports = {
    registerEndpoints: registerEndpoints
};
// vim: set softtabstop=4 shiftwidth=4:
