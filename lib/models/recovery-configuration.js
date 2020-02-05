/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Recovery Configuration model and associated functions
 */

// PENDING: Validate provided eBox template?


'use strict';
const assert = require('assert-plus');
const util = require('util');
const vasync = require('vasync');
const VError = require('verror');

const mod_moray = require('../apis/moray');
const validate = require('../util/validate');
const model = require('./model');

delete require.cache[require.resolve('./pivtoken')];
const mod_pivtoken = require('./pivtoken');

const BUCKET = {
    desc: 'Recovery configuration templates',
    name: 'kbmapi_recovery_configs',
    schema: {
        index: {
            uuid: { type: 'uuid', 'unique': true},
            template: { type: 'string' },
            // Not using 'date' type here since it does not work properly
            // for presence/absence filters like the following:
            // '(&(activated=*)(!(expired=*)))'
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
        template: validate.isPresent
    }
};


function RecoveryConfiguration(params) {
    params.bucket = BUCKET;
    model.Model.call(this, params);
    this.params = {
        uuid: params.uuid,
        template: params.template,
        created: params.created,
        staged: params.staged,
        activated: params.activated,
        expired: params.expired
    };
}


util.inherits(RecoveryConfiguration, model.Model);

/*
 * Required by moray client implementation in use.
 */
RecoveryConfiguration.prototype.key = function key() {
    return this.params.uuid;
};

RecoveryConfiguration.prototype.serialize = function serialize() {
    return {
        uuid: this.params.uuid,
        template: this.params.template,
        created: this.params.created,
        staged: this.params.staged,
        activated: this.params.activated,
        expired: this.params.expired
    };
};

/*
 * Required by moray client implementation in use.
 */
RecoveryConfiguration.prototype.raw = function tokenRaw() {
    var self = this;
    return (Object.assign(self.serialize(), {v: self.bucket.version}));
};

/*
 * See model.create for required parameters
 */
function createRecoveryConfiguration(opts, cb) {
    // model.create will assert for all the expected stuff in opts
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');
    assert.object(opts.params, 'opts.params');
    assert.string(opts.params.template, 'opts.params.template');

    opts.params.template = opts.params.template.replace(/\n/g, '');
    // Ditto for the UUID. Let's just create a repeatable one:
    if (!opts.params.uuid) {
        opts.params.uuid = model.uuid(opts.params.template);
    }

    if (!opts.params.created) {
        opts.params.created = new Date().toISOString();
    }

    var context = {
        createOpts: Object.assign(opts, {
            createSchema: CREATE_SCHEMA,
            bucket: BUCKET,
            model: RecoveryConfiguration
        })
    };
    vasync.pipeline({funcs: [
        function countCfgs(ctx, next) {
            model.count({
                moray: opts.moray,
                bucket: BUCKET.name,
                filter: '(uuid=*)'
            }, function (err, count) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.countConfigs = count;
                next();
            });
        },
        function countPIVTokens(ctx, next) {
            if (ctx.countConfigs !== 0) {
                next();
                return;
            }

            model.count({
                moray: opts.moray,
                bucket: mod_pivtoken.bucket().name,
                filter: '(guid=*)'
            }, function (err, count) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.countPIVTokens = count;
                next();
            });
        },
        function createCfg(ctx, next) {
            if (ctx.countConfigs === 0 && ctx.countPIVTokens === 0) {
                ctx.createOpts.params.staged = new Date().toISOString();
                ctx.createOpts.params.activated = new Date().toISOString();
            }
            model.create(ctx.createOpts, function createCb(err, obj) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.recoveryConfig = obj;
                next();
            });
        }
    ], arg: context }, function pipeCb(pipeErr) {
        if (pipeErr) {
            cb(pipeErr);
            return;
        }
        cb(null, context.recoveryConfig);
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
function updateRecoveryConfiguration(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.val, 'opts.val');
    // On a recovery configuration, the only thing we can do is either remove
    // a value or add new values to staged, activated and expired.
    // Everything else should be forbidden.
    const invalid = Object.keys(opts.val).some(function isNotAllowed(k) {
        return ['staged', 'activated', 'expired'].indexOf(k) === -1;
    });

    if (invalid) {
        callback(new VError('Only  \'staged\', \'activated\' and ' +
            '\'expired\'can be modified for a Recovery Configuration'));
        return;
    }

    getRecoveryConfiguration({
        uuid: opts.key,
        moray: opts.moray,
        model: RecoveryConfiguration
    }, function getCb(getErr, recCfg) {
        if (getErr) {
            callback(getErr);
            return;
        }

        var updateOpts = Object.assign(opts, {
            bucket: BUCKET,
            original: recCfg.raw(),
            etag: opts.etag || recCfg.etag
        });

        model.update(updateOpts, function updateCb(updateErr, updatedVal) {
            if (updateErr) {
                callback(updateErr);
                return;
            }

            const etag = updatedVal.value.etag;
            delete updatedVal.value.etag;

            var obj = new RecoveryConfiguration(updatedVal.value);
            obj.etag = etag;
            callback(null, obj);
        });
    });
}

function getRecoveryConfiguration(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');
    var getOpts = Object.assign(opts, {
        bucket: BUCKET,
        model: RecoveryConfiguration,
        key: opts.uuid || (opts.params && opts.params.uuid)
    });
    model.get(getOpts, callback);
}

function deleteRecoveryConfiguration(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');
    var delOpts = Object.assign(opts, {
        bucket: BUCKET,
        key: opts.uuid || (opts.params && opts.params.uuid)
    });

    getRecoveryConfiguration(delOpts, function (getErr, rec) {
        if (getErr) {
            callback(getErr);
            return;
        }
        if ((rec.params.staged || rec.params.activated) &&
            !rec.params.expired) {
            callback(new VError({
                name: 'InvalidConfigurationState'
            }, 'When a recovery configuration has been' +
                '\'staged\' or \'activated\' it is mandatory ' +
                'to expire it before it can be removed'));
            return;
        }
        model.del(delOpts, callback);
    });
}


const VALID_FIELDS = [
    'uuid',
    'created',
    'activated',
    'staged',
    'expired',
    'template'
];


function listRecoveryConfigurations(opts, cb) {
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
        model: RecoveryConfiguration
    }), cb);
}

function initRecoveryConfigurationsBucket(moray, cb) {
    mod_moray.initBucket(moray, BUCKET, cb);
}

module.exports = {
    bucket: function () { return BUCKET; },
    create: createRecoveryConfiguration,
    del: deleteRecoveryConfiguration,
    get: getRecoveryConfiguration,
    update: updateRecoveryConfiguration,
    ls: listRecoveryConfigurations,
    RecoveryConfiguration: RecoveryConfiguration,
    init: initRecoveryConfigurationsBucket
};
// vim: set softtabstop=4 shiftwidth=4:
