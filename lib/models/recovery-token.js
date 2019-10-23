/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Recovery Token model and associated functions
 */
'use strict';
const assert = require('assert-plus');
const crypto = require('crypto');
const util = require('util');
const VError = require('verror');

const mod_moray = require('../apis/moray');
const validate = require('../util/validate');
const model = require('./model');

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
    }
};

function RecoveryToken(params) {
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
    return {
        token: this.params.token,
        created: this.params.created,
        staged: this.params.staged,
        activated: this.params.activated,
        expired: this.params.expired,
        pivtoken: this.params.pivtoken,
        recovery_configuration: this.params.recovery_configuration
    };
};

RecoveryToken.prototype.raw = function raw() {
    var self = this;
    return (Object.assign(self.serialize(), {
        uuid: this.params.uuid,
        v: BUCKET.version
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

    var createOpts = Object.assign(opts, {
        createSchema: CREATE_SCHEMA,
        bucket: BUCKET,
        model: RecoveryToken
    });

    model.create(createOpts, cb);
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

        var updateOpts = Object.assign(opts, {
            bucket: BUCKET,
            original: recTk.raw(),
            etag: opts.etag || recTk.etag
        });

        model.update(updateOpts, function updateCb(updateErr, updatedVal) {
            if (updateErr) {
                callback(updateErr);
                return;
            }

            const etag = updatedVal.value.etag;
            delete updatedVal.value.etag;

            var obj = new RecoveryToken(updatedVal.value);
            obj.etag = etag;
            callback(null, obj);
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

module.exports = {
    bucket: function () { return BUCKET; },
    createSchema: function () { return CREATE_SCHEMA; },
    create: createRecoveryToken,
    del: deleteRecoveryToken,
    get: getRecoveryToken,
    update: updateRecoveryToken,
    ls: listRecoveryTokens,
    RecoveryToken: RecoveryToken,
    init: initRecoveryTokensBucket
};
// vim: set softtabstop=4 shiftwidth=4:
