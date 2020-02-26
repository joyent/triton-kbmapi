/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * The kbmapi PIVTokens endpoints
 */

'use strict';

const util = require('util');

const mod_auth = require('../auth');
const errors = require('../util/errors');

const models = require('../models');
const mod_pivtoken = models.pivtoken;
const mod_recovery_token = models.recovery_token;
const mod_pivtoken_history = models.pivtoken_history;

const assert = require('assert-plus');
const restify = require('restify');

/*
 * Pre-load a pivtoken, given req.params.guid. This will be used to verify auth
 * using http signature against pivtoken's pubkeys 9E for the methods requiring
 * this kind of authentication.
 */
function preloadPivtoken(req, res, next) {
    if (!req.params || (!req.params.guid && !req.params.replaced_guid)) {
        next();
        return;
    }

    mod_pivtoken.getPin({
        moray: req.app.moray,
        log: req.log,
        params: {
            guid: req.params.replaced_guid || req.params.guid
        }
    }, function getPivtokenCb(err, token) {
        if (err) {
            if (err.statusCode === 404) {
                next();
                return;
            }

            req.log.error({
                error: err,
                params: req.params
            }, 'Error sent');

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
    assert.string(token.guid, 'token.guid');
    assert.func(cb, 'cb');

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
            req.log.error({
                error: err,
                params: req.params
            }, 'Error sent');
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
            req.log.error({
                error: err,
                params: req.params
            }, 'Error sent');
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
        if (((now - tokenCreated) < req.config.recoveryTokenDuration * 1000) &&
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
                req.log.error({
                    error: err,
                    params: req.params
                }, 'Error sent');
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
                req.log.error({
                    error: err,
                    params: req.params
                }, 'Error sent');
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
            req.log.error({
                error: err,
                params: req.params
            }, 'Error sent');
            next(err);
            return;
        }
        res.send(204);
        next();
    });
}


/**
 * POST /pivtokens/:replaced_guid/replace: replace the given pivtoken :guid with
 * a new (provided) token.
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
            req.log.error({
                error: err,
                params: req.params
            }, 'Error sent');
            next(err);
            return;
        }

        mod_pivtoken.create({
            moray: req.app.moray,
            log: req.log,
            params: req.params
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


/*
 * Get the information about currently staged and active recovery configurations
 * into the CN of a given PIV Token, and update associated recovery tokens
 * accordingly.
 *
 * Parameters:
 *
 * @param {String} guid of the PIV Token. Required.
 * @param {String} cn_uuid UUID of the server where the PIV Token is. Optional.
 * @param {Object} zpool_recovery with the form:
 *      {
 *         "active": "${ACTIVE_RECOVERY_CONFIG_UUID}",
 *         "staged": "${STAGED_RECOVERY_CONFIG_UUID}"
 *      }
 *  where STAGED_RECOVERY_CONFIG_UUID & ACTIVE_RECOVERY_CONFIG_UUID can be the
 *  same. Required.
 * @param {String} recovery_token UUID of the staged recovery token, in case
 *  we just staged a new one. (This param is not needed for the active recovery
 *  token since only the previously staged one can be activated, but is needed
 *  if we stage a new one, since we'll need to expire a previously staged and
 *  not activated one, if that's the case). Optional.
 */
function updateRecoveryTokens(req, res, next) {
    if (!req.pivtoken) {
        next(new restify.ResourceNotFoundError('pivtoken not found'));
        return;
    }

    if (!req.params.zpool_recovery) {
        next(new errors.InvalidParamsError('missing parameter',
            [errors.missingParam('zpool_recovery', 'cannot update ' +
            'recovery tokens without Zpool Recovery information.')]));
        return;
    }

    // 1. Flag active recovery token if not already done.
    // 2. Expire the previously active recovery token if not the same.
    // 3. Flag the staged recovery token if not already done.
    // 4. Expire the previously staged recovery token if not the same.
    // 1 & 2 only when zpool_recovery.active is present.
    // 3 & 4 only when zpool_recovery.staged & recovery_token are present.
    const opts = {
        pivtoken_guid: req.pivtoken.guid
    };

    if (req.params.zpool_recovery.active) {
        opts.active_recovery_config_uuid = req.params.zpool_recovery.active;
    }

    if (req.params.recovery_token && req.params.zpool_recovery.staged) {
        opts.staged_recovery_config_uuid = req.params.zpool_recovery.staged;
        opts.recovery_token_uuid = req.params.recovery_token;
    }

    req.log.debug({
        params: req.params,
        opts: opts
    }, 'updateRecoveryTokens');

    if (!opts.active_recovery_config_uuid &&
        !opts.staged_recovery_config_uuid) {
        res.send(200);
        next();
        return;
    }

    opts.moray = req.app.moray;
    opts.log = req.log;

    // If `staged` is present, `active` will be different, which means we've
    // just staged a new recovery config and we still have the originally
    // active one.
    // When we activate a recovery configuration, it must be already staged and
    // from the cn-agent, we'll then remove the `staged` member from
    // `Zpool Recovery` sysinfo property. Therefore, if `staged` is not present,
    // we are doing an activation.
    const func = opts.staged_recovery_config_uuid ? 'setStaged' : 'setActive';

    mod_recovery_token[func](opts, function (batchErr, _batchMeta) {
        if (batchErr) {
            next(batchErr);
            return;
        }

        res.send(200);
        next();
    });
}

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
            req.log.error({
                error: lsErr,
                params: req.params
            }, 'Error sent');
            next(lsErr);
            return;
        }

        res.send(200, recTokens.map(function serialize(token) {
            return token.serialize();
        }));
        next();
    });
}

/*
 * Creating/updating recovery tokens have some rules regarding existing
 * recovery tokens for a given PIV Token:
 *
 * - When a new recovery token is "created", if there are any existing recovery
 *   token for the same PIV Token which hasn't been yet staged or activated,
 *   it will be immediately expired.
 * - When a new recovery token is "staged", if there are any existing recovery
 *   token which hasn't yet been staged, it'll be immediately expired.
 * - When a new recovery token is "activated", if there are any existing
 *   recovery token which was active, it'll be immediately expired.
 *
 */
function createRecoveryToken(req, res, next) {
    if (!req.pivtoken) {
        next(new restify.ResourceNotFoundError('pivtoken not found'));
        return;
    }

    const latestToken = req.pivtoken.recovery_tokens[
            req.pivtoken.recovery_tokens.length - 1];
    const params = {
        pivtoken: req.pivtoken.guid,
        recovery_configuration: req.params.recovery_configuration ||
            latestToken.recovery_configuration
    };

    if (req.params.token) {
        params.token = Buffer.from(req.params.token, 'base64').toString();
    }

    if (req.params.created) {
        params.created = Date.parse(req.params.created);
        if (isNaN(params.created)) {
            next(new errors.InvalidParamsError('invalid parameter',
                [errors.invalidParam('created', 'is not a valid date')]));
            return;
        }
    }

    mod_recovery_token.create({
        moray: req.app.moray,
        params: params
    }, function createCb(createErr, recTk) {
        if (createErr) {
            req.log.error({
                error: createErr,
                params: req.params
            }, 'Error sent');
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
            req.log.error({
                error: err,
                params: req.params
            }, 'Error sent');
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
            req.log.error({
                error: upErr,
                params: req.params
            }, 'Error sent');
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
            req.log.error({
                error: delErr,
                params: req.params
            }, 'Error sent');
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
        path: '/pivtokens/:replaced_guid/replace',
        name: 'replacepivtoken'
    }, before, preloadPivtoken, mod_auth.signatureAuth, replacePivtoken);
    http.get({
        path: '/pivtokens/:guid/recovery-tokens',
        name: 'listtokens'
    }, before, preloadPivtoken, mod_auth.signatureAuth, listRecoveryTokens);
    http.put({
        path: '/pivtokens/:guid/recovery-tokens',
        name: 'updatetokensstate'
    }, before, preloadPivtoken, updateRecoveryTokens);
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
