/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Recovery Token model and associated functions
 */
'use strict';
const assert = require('assert-plus');
const crypto = require('crypto');
const util = require('util');
const vasync = require('vasync');
const VError = require('verror');

const errors = require('../util/errors');
const mod_moray = require('../apis/moray');
const validate = require('../util/validate');
const model = require('./model');

delete require.cache[require.resolve('./recovery-configuration')];
const mod_recovery_configuration = require('./recovery-configuration');
delete require.cache[require.resolve('./pivtoken')];
const mod_pivtoken = require('./pivtoken');

const BUCKET = {
    desc: 'Recovery tokens',
    name: 'kbmapi_recovery_tokens',
    schema: {
        index: {
            uuid: { type: 'uuid', unique: true },
            pivtoken: { type: 'string' },
            recovery_configuration: { type: 'uuid' },
            token: { type: 'string' },
            created: { type: 'string' },
            staged: { type: 'string' },
            activated: { type: 'string' },
            expired: { type: 'string' }
        }
    },
    version: 0
};

const CREATE_SCHEMA = {
    required: {
        uuid: validate.UUID,
        pivtoken: validate.GUID,
        recovery_configuration: validate.UUID,
        token: validate.isPresent
    },
    optional: {
        created: validate.iso8601
    }
};

function RecoveryToken(params) {
    params.bucket = BUCKET;
    model.Model.call(this, params);
    // Override Model's default to just setting params.uuid:
    this.params = {
        uuid: params.uuid,
        recovery_configuration: params.recovery_configuration,
        pivtoken: params.pivtoken,
        token: params.token,
        created: params.created,
        staged: params.staged,
        activated: params.activated,
        expired: params.expired
    };
}

util.inherits(RecoveryToken, model.Model);

RecoveryToken.prototype.serialize = function serialize() {
    var self = this;
    var obj = {
        token: this.params.token,
        created: this.params.created,
        staged: this.params.staged,
        activated: this.params.activated,
        expired: this.params.expired,
        pivtoken: this.params.pivtoken,
        recovery_configuration: this.params.recovery_configuration,
        uuid: this.params.uuid
    };

    if (self.template) {
        obj.template = self.template;
    }

    return obj;
};

RecoveryToken.prototype.raw = function raw() {
    var self = this;
    return (Object.assign(self.serialize(), {
        v: self.bucket.version
    }));
};


/*
 * See model.create for required parameters
 */
function createRecoveryToken(opts, cb) {
    // model.create will assert for all the expected stuff in opts
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    // If no token has been provided, just create a random one:
    if (!opts.params.token) {
        opts.params.token = crypto.randomBytes(40).toString('hex');
    }
    // Ditto for the UUID. Let's just create a repeatable one:
    if (!opts.params.uuid) {
        opts.params.uuid = model.uuid(opts.params.token);
    }
    if (!opts.params.created) {
        opts.params.created = new Date().toISOString();
    }

    var context = {};
    if (opts.params.pivtoken) {
        context.pivtoken = opts.params.pivtoken;
    }

    vasync.pipeline({
        arg: context,
        funcs: [
            function validateParams(ctx, next) {
                validate.params(CREATE_SCHEMA, null, opts.params,
                    function valCb(validationErr, validatedTk) {
                    if (validationErr) {
                        next(validationErr);
                        return;
                    }
                    ctx.validatedTk = validatedTk;
                    next();
                });
            },
            function fetchConfig(ctx, next) {
                mod_recovery_configuration.get({
                    moray: opts.moray,
                    uuid: opts.params.recovery_configuration
                }, function getCfgCb(cfgErr, cfg) {
                    if (cfgErr) {
                        next(cfgErr);
                        return;
                    }

                    if (cfg.params.expired) {
                        next(new errors.InvalidParamsError(
                            'Cannot create a recovery token with an expired' +
                            ' recovery configuration', [
                                errors.invalidParam('recovery_configuration')
                            ]));
                        return;
                    }
                    ctx.cfg = cfg;
                    next();
                });
            },
            function fetchPivtoken(ctx, next) {
                if (ctx.pivtoken) {
                    next();
                    return;
                }
                mod_pivtoken.get({
                    moray: opts.moray,
                    guid: ctx.validatedTk.pivtoken
                }, function getPivCb(err, piv) {
                    if (err) {
                        next(err);
                        return;
                    }
                    ctx.pivtoken = piv;
                });
            },
            function batchQuery(ctx, next) {
                if (ctx.cfg.params.staged) {
                    ctx.validatedTk.staged = new Date().toISOString();
                }

                if (ctx.cfg.params.activated) {
                    ctx.validatedTk.activated = new Date().toISOString();
                }

                opts.moray.batch([{
                    bucket: BUCKET.name,
                    operation: 'update',
                    filter: util.format(
                        '(&(pivtoken=%s)(!(expired=*))(!(activated=*))' +
                        '(!(staged=*)))',
                        ctx.validatedTk.pivtoken),
                    fields: {
                        expired: opts.params.created
                    }
                }, {
                    bucket: BUCKET.name,
                    operation: 'put',
                    key: ctx.validatedTk.uuid,
                    value: ctx.validatedTk,
                    options: {
                        etag: null
                    }
                }], function batchCb(bErr, bMeta) {
                    if (bErr) {
                        cb(bErr);
                        return;
                    }

                    var recoveryToken = new RecoveryToken(ctx.validatedTk);
                    recoveryToken.template = ctx.cfg.params.template;
                    recoveryToken.etag = bMeta.etags[1].etag;
                    ctx.recoveryToken = recoveryToken;
                    next();
                });
            }
        ]
    }, function pipeCb(pipeErr) {
        cb(pipeErr, context.recoveryToken);
    });
}


/*
 * @param opts {Object}
 * - `moray` {MorayClient}
 * - `key` {String} : uuid of the recovery configuration to update
 * - `etag` {String}: The etag for the original Moray object
 * - `remove` {Boolean} : remove all keys in val from the object (optional)
 * - `val` {Object} : keys to update in the object
 * @param callback {Function} `function (err, new RecoveryConfiguration())`
 */
function updateRecoveryToken(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.val, 'opts.val');
    assert.optionalBool(opts.remove, 'opts.remove');
    // On a recovery configuration, the only thing we can do is either remove
    // a value or add new values to staged, activated and expired.
    // Everything else should be forbidden.
    const invalid = Object.keys(opts.val).some(function isNotAllowed(k) {
        return ['staged', 'activated', 'expired'].indexOf(k) === -1;
    });

    if (invalid) {
        callback(new VError('Only  \'staged\', \'activated\' and ' +
            '\'expired\'can be modified for a Recovery Token'));
        return;
    }

    getRecoveryToken({
        uuid: opts.key,
        moray: opts.moray,
        model: RecoveryToken
    }, function getCb(getErr, recTk) {
        if (getErr) {
            callback(getErr);
            return;
        }

        const action = (opts.val.expired) ? 'expire' :
            (opts.val.activated) ? 'activate' : 'stage';

        var requests = [];

        const filter_str = (action === 'stage') ?
                '(&(pivtoken=%s)(!(expired=*))(!(activated=*))(!(uuid=%s)))' :
                (action === 'activate') ?
                '(&(pivtoken=%s)(!(expired=*))(!(uuid=%s)))' : null;

        if (filter_str) {
            requests.push({
                bucket: BUCKET.name,
                operation: 'update',
                filter: util.format(
                    filter_str, recTk.params.pivtoken, recTk.key()),
                fields: {
                    expired: new Date().toISOString()
                }
            });
        }

        var updatedVal = Object.assign(recTk.raw(), opts.val);

        requests.push({
            bucket: BUCKET.name,
            operation: 'put',
            key: recTk.key(),
            value: updatedVal,
            options: {
                etag: opts.etag || recTk.etag
            }
        });

        opts.moray.batch(requests, function batchCb(batchErr, batchMeta) {
            if (batchErr) {
                callback(batchErr);
                return;
            }

            var recoveryToken = new RecoveryToken(updatedVal);
            recoveryToken.etag = batchMeta.etags[1].etag;
            callback(null, recoveryToken);
        });
    });
}


function getRecoveryToken(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');

    var getOpts = Object.assign(opts, {
        bucket: BUCKET,
        model: RecoveryToken,
        key: opts.uuid || (opts.params && opts.params.uuid)
    });
    model.get(getOpts, callback);
}


function deleteRecoveryToken(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');

    var delOpts = Object.assign(opts, {
        bucket: BUCKET,
        key: opts.uuid || (opts.params && opts.params.uuid)
    });
    model.del(delOpts, callback);
}


const VALID_FIELDS = [
    'uuid',
    'recovery_configuration',
    'pivtoken',
    'created',
    'activated',
    'staged',
    'expired',
    'token'
];

// Need to list recovery tokens either by pivtoken (guid) or by
// recovery configuration (uuid)
function listRecoveryTokens(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.params, 'opts.params');
    assert.func(cb, 'cb');

    model.list(Object.assign(opts, {
        bucket: BUCKET,
        validFields: VALID_FIELDS,
        sort: {
            attribute: 'created',
            order: 'ASC'
        },
        model: RecoveryToken
    }), cb);
}

function initRecoveryTokensBucket(moray, cb) {
    mod_moray.initBucket(moray, BUCKET, cb);
}

function deleteRecoveryTokens(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.filter, 'opts.filter');
    assert.func(cb, 'cb');
    model.delMany(Object.assign(opts, {
        bucket: BUCKET
    }), cb);
}

function setActiveRecoveryToken(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.active_recovery_config_uuid,
        'opts.active_recovery_config_uuid');

    _setActiveAndOrStaged(opts, cb);
}

function setStagedRecoveryToken(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.staged_recovery_config_uuid,
        'opts.staged_recovery_config_uuid');
    assert.string(opts.recovery_token_uuid, 'opts.recovery_token_uuid');

    _setActiveAndOrStaged(opts, cb);
}

function setActiveAndStagedRecoveryToken(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.active_recovery_config_uuid,
        'opts.active_recovery_config_uuid');
    assert.string(opts.recovery_token_uuid, 'opts.recovery_token_uuid');
    assert.string(opts.staged_recovery_config_uuid,
        'opts.staged_recovery_config_uuid');

    _setActiveAndOrStaged(opts, cb);
}

function _setActiveAndOrStaged(opts, cb) {
    const when = new Date().toISOString();
    let requests = [];

    if (opts.staged_recovery_config_uuid) {
        requests = requests.concat({
            bucket: BUCKET.name,
            operation: 'update',
            fields: {
                staged: when
            },
            filter: util.format(
                '(&(recovery_configuration=%s)(uuid=%s)' +
                '(!(staged=*))(!(expired=*)))',
                opts.staged_recovery_config_uuid, opts.recovery_token_uuid)
        }, {
            bucket: BUCKET.name,
            operation: 'update',
            fields: {
                expired: when
            },
            filter: util.format(
                '(&(!(uuid=%s))(staged=*)(!(expired=*)))',
                opts.recovery_token_uuid)
        });
    }

    if (opts.active_recovery_config_uuid) {
        requests = requests.concat({
            bucket: BUCKET.name,
            operation: 'update',
            fields: {
                activated: when
            },
            filter: util.format(
                '(&(recovery_configuration=%s)(staged=*)(!(activated=*)))',
                opts.active_recovery_config_uuid)
        }, {
            bucket: BUCKET.name,
            operation: 'update',
            fields: {
                expired: when
            },
            filter: '(&(staged=*)(activated=*)(!(expired=*)))'
        });
    }

    opts.moray.batch(requests, function batchCb(batchErr, batchMeta) {
        if (batchErr) {
            opts.log.error({
                error: batchErr,
                staged_recovery_config_uuid: opts.staged_recovery_config_uuid,
                recovery_token_uuid: opts.recovery_token_uuid
            }, 'Error setting staged recovery token');
        }
        cb(batchErr, batchMeta);
    });
}

module.exports = {
    bucket: function () { return BUCKET; },
    createSchema: function () { return CREATE_SCHEMA; },
    create: createRecoveryToken,
    del: deleteRecoveryToken,
    get: getRecoveryToken,
    update: updateRecoveryToken,
    ls: listRecoveryTokens,
    delMany: deleteRecoveryTokens,
    RecoveryToken: RecoveryToken,
    init: initRecoveryTokensBucket,
    setActive: setActiveRecoveryToken,
    setStaged: setStagedRecoveryToken,
    setActiveAndStaged: setActiveAndStagedRecoveryToken
};
// vim: set softtabstop=4 shiftwidth=4:
