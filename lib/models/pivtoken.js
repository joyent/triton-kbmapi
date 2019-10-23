/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * PIVToken model and associated functions
 */
'use strict';

const assert = require('assert-plus');
const util = require('util');
const vasync = require('vasync');
const VError = require('verror');

const errors = require('../util/errors');
const mod_moray = require('../apis/moray');
const validate = require('../util/validate');
const model = require('./model');
const mod_recovery_configuration = require('./recovery-configuration');
const mod_recovery_token = require('./recovery-token');
// The assumption is that a token can only be associated with a single server
// however it seems possible (at least for now) that there might be multiple
// tokens on a given server.
const BUCKET = {
    desc: 'piv tokens',
    name: 'kbmapi_piv_token',
    schema: {
        index: {
            guid: { type: 'string', unique: true },
            cn_uuid: { type: 'uuid' },
            serial: { type: 'string', unique: true }
        }
    },
    version: 0
};

// Names that are allowed to be used in the fields filter
const VALID_FIELDS = [
    'guid',
    'cn_uuid',
    'serial',
    'model',
    'attestation',
    'pin',
    'pubkeys'
];

// Fields that are removed from GET /pivtoken/:guid requests (but left
// in in GET /pivtoken/:guid/pin
const SENSITIVE_FIELDS = [
    'pin',
    'recovery_tokens'
];

const CREATE_SCHEMA = {
    required: {
        guid: validate.GUID,
        cn_uuid: validate.UUID,
        pubkeys: validate.pubKeys,
        pin: validate.isPresent,
        created: validate.iso8601
    },
    optional: {
        attestation: validate.pubKeys
    }
};

var GET_SCHEMA = {
    required: {
        guid: validate.GUID
    }
};

var DELETE_SCHEMA = {
    required: {
        guid: validate.GUID
    }
};

function stripSensitiveFields(token) {
    SENSITIVE_FIELDS.forEach(function stripField(f) {
        delete token.params[f];
    });
}

/**
 * PIVToken model constructor
 */
function PIVToken(params) {
    model.Model.call(this, params);
    this.params = {
        guid: params.guid,
        cn_uuid: params.cn_uuid,
        pubkeys: params.pubkeys,
        model: params.model,
        serial: params.serial,
        attestation: params.attestation,
        pin: params.pin,
        created: params.created
    };
    this.etag = params.etag || null;
}

util.inherits(PIVToken, model.Model);

Object.defineProperty(PIVToken.prototype, 'guid', {
    get: function getGuid() { return this.params.guid; }
});

Object.defineProperty(PIVToken.prototype, 'serial', {
    get: function getSerial() { return this.params.serial; }
});

/**
 * Returns the moray key for storing this PIVToken object
 */
PIVToken.prototype.key = function key() {
    return this.params.guid;
};


PIVToken.prototype.batch = function batch() {
    return {
        bucket: BUCKET.name,
        key: this.params.guid,
        operation: 'put',
        value: this.raw(),
        options: {
            etag: this.etag
        }
    };
};


PIVToken.prototype.serialize = function tokenSerialize() {
    return {
        guid: this.params.guid,
        cn_uuid: this.params.cn_uuid,
        pubkeys: this.params.pubkeys,
        model: this.params.model,
        serial: this.params.serial,
        attestation: this.params.attestation,
        pin: this.params.pin,
        created: this.params.created,
        recovery_tokens: this.params.recovery_tokens
    };
};


PIVToken.prototype.raw = function raw() {
    return {
        guid: this.params.guid,
        cn_uuid: this.params.cn_uuid,
        pubkeys: this.params.pubkeys,
        model: this.params.model,
        serial: this.params.serial,
        attestation: this.params.attestation,
        pin: this.params.pin,
        created: this.params.created,
        v: BUCKET.version
    };
};

/*
 * @param opts {Object} including the following members:
 * - @param moray {Object} moray client instance
 * - @param log {Object} bunyan logger instance
 * - @param params {Object} required for PIVToken creation. Will include
 *   some of the following parameters:
 *   - @param guid {String} required PIVToken GUID
 *   - @param recovery_configuration {String} UUID of the Recovery
 *     Configuration to be used in order to create the first Recovery Token
 *     associated with the PIVToken. If not provided, the currently active
 *     recovery configuration will be used.
 *   - @param cn_uuid {String} required UUID of the Compute Node for this
 *     PIVToken
 *   - @param pin {String} required PIN code to unlock PIVToken
 *   - @param pubkeys {Object} required collection of public SSH
 *     keys stored by the PIVToken indexed by their usual '9a', '9b', '9e'
 *     keys. Note the '9e' member is required
 *   - @param model {String} the manufacturer model name for the PIVToken
 *   - @param serial {String} the manufacturer serial number for the PIVToken
 *   - @param attestation {Object} collection of attestation objects (similar
 *     to pubkeys).
 *   - @param created {String} ISO 8601 date time
 * @params callback {Function} of the form f(err, pivtoken)
 */
function createPIVToken(opts, callback) {
    // model.create will assert for all the expected stuff in opts
    assert.object(opts, 'opts');
    // This is needed for listing recovery configs:
    assert.object(opts.log, 'opts.log');
    assert.func(callback, 'callback');

    if (!opts.params.created) {
        opts.params.created = new Date().toISOString();
    }

    var arg = {};
    vasync.pipeline({
        arg: arg,
        funcs: [
            function validateParams(_ctx, next) {
                validate.params(CREATE_SCHEMA, null, opts.params,
                    function validateCb(err) {
                    if (err) {
                        next(err);
                        return;
                    }
                    next();
                });
            },
            function getActiveRecoveryConfig(ctx, next) {
                if (opts.params.recovery_configuration) {
                    next();
                    return;
                }

                mod_recovery_configuration.ls({
                    params: { filter: '(&(activated=*)(!(expired=*)))' },
                    moray: opts.moray,
                    log: opts.log
                }, function listCb(lsErr, configs) {
                    if (lsErr) {
                        next(new errors.InvalidParamsError('missing parameter',
                            [errors.missingParam('recovery_configuration',
                                'cannot create a PIVToken' +
                                ' without an active recovery configuration')]));
                        return;
                    }

                    if (!configs.length) {
                        next(new errors.InvalidParamsError('missing parameter',
                            [errors.missingParam('recovery_configuration',
                                'cannot create a PIVToken' +
                                ' without an active recovery configuration')]));

                        return;
                    }

                    ctx.recoveryConfig = configs[0];
                    next();
                });
            },

            function getRecoveryConfig(ctx, next) {
                if (!opts.params.recovery_configuration) {
                    next();
                    return;
                }

                mod_recovery_configuration.get({
                    moray: opts.moray,
                    uuid: opts.params.recovery_configuration
                }, function getCfgCb(err, cfg) {
                    if (err) {
                        next(new errors.InvalidParamsError('invalid parameter',
                            [errors.invalidParam('recovery_configuration',
                                'cannot create a PIVToken' +
                                ' without a valid recovery configuration')]));
                        return;
                    }
                    ctx.recoveryConfig = cfg;
                    delete opts.params.recovery_configuration;
                    next();
                });
            },
            // FIXME: If we have an already existing token, we only need to
            // create a recovery token here
            // TODO: Figure out how to wrap the next two functions in a moray
            // batch operation _but_ perform validation before:
            function createPIVTokenRecord(ctx, next) {
                var createOpts = Object.assign(opts, {
                    createSchema: CREATE_SCHEMA,
                    bucket: BUCKET,
                    model: PIVToken
                });

                model.create(createOpts, function (err, pivtoken) {
                    if (err) {
                        next(err, null);
                        return;
                    }
                    ctx.pivtoken = pivtoken;
                    next();
                });
            },
            function createRecoveryToken(ctx, next) {
                mod_recovery_token.create({
                    moray: opts.moray,
                    params: {
                        recovery_configuration: ctx.recoveryConfig.params.uuid,
                        pivtoken: ctx.pivtoken.guid
                    }
                }, function recTokenCb(err, aToken) {
                    if (err) {
                        next(new VError(err,
                            'Problem creating a recovery token for PIVToken'));
                        // XXX: Shall we also delete the PIVToken?
                        return;
                    }
                    ctx.recoveryToken = aToken;
                    next();
                });
            }
        ]
    }, function pipeCb(pipeErr) {
        if (pipeErr) {
            callback(pipeErr);
            return;
        }
        var pivtoken = arg.pivtoken;
        var recoveryToken = arg.recoveryToken.serialize();
        // Instead of the recovery configuration uuid, we rather provide
        // the template and save a GET HTTP call to /recovery-configurations:
        recoveryToken.template = arg.recoveryConfig.params.template;
        pivtoken.params.recovery_tokens = [recoveryToken];
        callback(null, pivtoken);
    });
}

/*
 * Deletes a PIVToken and all the recovery tokens associated with it.
 */
function deletePIVToken(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.params, 'opts.params');
    assert.optionalString(opts.etag, 'opts.etag');
    assert.func(callback, 'callback');

    opts.log.debug(opts.params, 'deletePIVToken: entry');

    function deleteCb(err) {
        if (err) {
            callback(err);
            return;
        }

        var delPivOpts = {
            bucket: BUCKET.name,
            operation: 'delete',
            key: opts.params.guid
        };

        if (opts.etag) {
            delPivOpts.options = {
                etag: opts.etag
            };
        }

        opts.moray.batch([delPivOpts, {
            bucket: mod_recovery_token.bucket().name,
            operation: 'deleteMany',
            filter: util.format('(pivtoken=%s)', opts.params.guid)
        }], function delBatchCb(delErr, delMeta) {
            if (delErr) {
                callback(delErr);
                return;
            }
            opts.log.debug(delMeta, 'batch delete metadata');
            callback(null);
        });
    }
    validate.params(DELETE_SCHEMA, null, opts.params, deleteCb);
}

function listPIVTokens(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.params, 'opts.params');
    assert.func(callback, 'callback');

    opts.log.debug({ params: opts.params }, 'listTokens: entry');

    model.list(Object.assign(opts, {
        bucket: BUCKET,
        validFields: VALID_FIELDS,
        sort: {
            attribute: 'guid',
            order: 'ASC'
        },
        model: PIVToken,
        defaultFilter: '(guid=*)',
        listCb: function listObjsCb(mErr, pivtokens) {
            if (mErr) {
                callback(mErr);
                return;
            }

            if (!pivtokens.length) {
                callback(null, []);
                return;
            }

            // Fetch all the recovery tokens associated with the PIVTokens
            // retrieved by the previous call:
            var pivGuids = pivtokens.map(function (p) {
                return '(pivtoken=' + p.guid + ')';
            }).join('');
            var multiFilter = '(|' + pivGuids + ')';
            mod_recovery_token.ls({
                params: {
                    filter: multiFilter
                },
                moray: opts.moray,
                log: opts.log
            }, function (lErr, tokens) {
                if (lErr) {
                    callback(lErr);
                    return;
                }

                pivtokens = pivtokens.map(function addTokens(aPiv) {
                    stripSensitiveFields(aPiv);
                    var ownedTokens = tokens.filter(function filterTk(t) {
                        return t.params.pivtoken === aPiv.params.guid;
                    });
                    aPiv.recovery_tokens = ownedTokens.map(function ser(t) {
                        delete t.params.pivtoken;
                        return t.serialize();
                    });
                    return aPiv;
                });

                callback(null, pivtokens);
            });
        }
    }), callback);
}

function _getTokenImpl(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.params, 'opts.params');
    assert.bool(opts.removeFields, 'opts.removeFields');
    assert.func(callback, 'callback');

    var params = opts.params;
    validate.params(GET_SCHEMA, null, params, function getTokenValidateCb(err) {
        if (err) {
            callback(err);
            return;
        }

        mod_moray.getObj(opts.moray, BUCKET, params.guid,
            function getTokenMorayCb(mErr, token) {
                if (mErr) {
                    callback(mErr);
                    return;
                }

                // Cheesy, but for the prototype just delete the pin unless
                // GET /pivtoken/:guid/pin has been called
                var tokenObj = new PIVToken(token.value);
                tokenObj.etag = token._etag;

                if (opts.removeFields) {
                    stripSensitiveFields(tokenObj);
                    // No need to fetch recovery tokens if we plan to remove
                    // them anyway:
                    callback(null, tokenObj);
                    return;
                }

                getRecoveryTokens({
                    guid: tokenObj.guid,
                    log: opts.log,
                    moray: opts.moray
                }, function recoveryTokensCb(recErr, recTokens) {
                    if (recErr) {
                        callback(recErr);
                        return;
                    }
                    tokenObj.params.recovery_tokens = recTokens.map(
                        function serializeRecTokens(rTk) {
                        return rTk.serialize();
                    });
                    callback(null, tokenObj);
                    return;
                });
            });
    });
}

/*
 * Get recovery tokens associated with the provided PIVToken GUID
 * @param opts {Object}
 * - `moray` {MorayClient}
 * - `guid` {String} : guid of the PIVToken
 * - `log` {Object} : bunuyan log object
 * @param callback {Function} `function (err, RecoveryTokens)`
 */
function getRecoveryTokens(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.guid, 'opts.guid');
    assert.func(callback, 'callback');

    mod_recovery_token.ls({
        params: {
            filter: util.format('(pivtoken=%s)', opts.guid)
        },
        moray: opts.moray,
        log: opts.log
    }, function (lErr, tokens) {
        if (lErr) {
            callback(lErr);
            return;
        }
        tokens.forEach(function removePIVToken(tk) {
            delete tk.pivtoken;
        });
        callback(null, tokens);
    });
}

function getPIVToken(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.params, 'opts.params');
    assert.func(callback, 'callback');

    opts.log.debug(opts.params, 'getToken: entry');

    _getTokenImpl({
        moray: opts.moray,
        log: opts.log,
        params: opts.params,
        removeFields: true
    }, callback);
}

function getPIVTokenPin(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.params, 'opts.params');
    assert.func(callback, 'callback');

    opts.log.debug(opts.params, 'getTokenPin: entry');

    _getTokenImpl({
        moray: opts.moray,
        log: opts.log,
        params: opts.params,
        removeFields: false
    }, callback);
}

function initPIVTokenBucket(moray, cb) {
    mod_moray.initBucket(moray, BUCKET, cb);
}

/*
 * @param opts {Object}
 * - `moray` {MorayClient}
 * - `key` {String} : guid of the PIVToken to update
 * - `etag` {String}: The etag for the original Moray object
 * - `remove` {Boolean} : remove all keys in val from the object (optional)
 * - `val` {Object} : keys to update in the object
 * @param callback {Function} `function (err, new PIVToken())`
 */
function updatePIVToken(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.val, 'opts.val');
    const changeableProps = ['cn_uuid'];
    const invalid = Object.keys(opts.val).some(function isNotAllowed(k) {
        return changeableProps.indexOf(k) === -1;
    });

    if (invalid) {
        callback(new VError('Only \'' + changeableProps.join('\',\'') +
            '\' can be modified for a PIVToken'));
        return;
    }

    _getTokenImpl({
        moray: opts.moray,
        log: opts.log,
        params: opts.params,
        removeFields: false
    }, function getCb(getErr, pivToken) {
        if (getErr) {
            callback(getErr);
            return;
        }

        var updateOpts = Object.assign(opts, {
            bucket: BUCKET,
            original: pivToken.raw(),
            etag: opts.etag || pivToken.etag,
            key: pivToken.guid
        });


        model.update(updateOpts, function updateCb(updateErr, updatedVal) {
            if (updateErr) {
                callback(updateErr);
                return;
            }

            const etag = updatedVal.value.etag;
            delete updatedVal.value.etag;

            var obj = new PIVToken(updatedVal.value);
            obj.etag = etag;
            obj.params.recovery_tokens = pivToken.recovery_tokens;
            callback(null, obj);
        });
    });
}

module.exports = {
    bucket: function () { return BUCKET; },
    create: createPIVToken,
    del: deletePIVToken,
    PIVToken: PIVToken,
    get: getPIVToken,
    getPin: getPIVTokenPin,
    init: initPIVTokenBucket,
    list: listPIVTokens,
    update: updatePIVToken
};
// vim: set softtabstop=4 shiftwidth=4:
