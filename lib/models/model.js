/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Generic methods shared across the different KBMAPI's models
 */

'use strict';
const crypto = require('crypto');
const assert = require('assert-plus');

const mod_moray = require('../apis/moray');
const validate = require('../util/validate');

/*
 * Generic model constructor.
 *
 */
function Model(params) {
    this.params = {
        uuid: params.uuid
    };
    this.etag = params.etag || null;
}

/*
 * Required by moray client implementation in use.
 */
Model.prototype.key = function key() {
    return this.params.uuid;
};

Model.prototype.batch = function batch(bucket) {
    return {
        bucket: bucket.name,
        key: this.params.uuid,
        operation: 'put',
        value: this.raw(),
        options: {
            etag: this.etag
        }
    };
};

Model.prototype.serialize = function serialize() {
    return {
        uuid: this.params.uuid
    };
};

/*
 * Required by moray client implementation in use.
 */
Model.prototype.raw = function raw(bucket) {
    var self = this;
    return (Object.assign(self.serialize(), {v: bucket.version}));
};


function createModel(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.params, 'opts.params');
    assert.func(opts.model, 'opts.model');
    assert.object(opts.bucket, 'opts.bucket');
    assert.object(opts.createSchema, 'opts.createSchema');
    assert.func(callback, 'callback');

    function validCb(err) {
        if (err) {
            callback(err);
            return;
        }

        var obj = new opts.model(opts.params);

        mod_moray.putObj(opts.moray, opts.bucket, obj, function putCb(pErr) {
            if (pErr) {
                callback(pErr);
                return;
            }

            callback(null, obj);
        });
    }

    validate.params(opts.createSchema, null, opts.params, validCb);
}


function updateModel(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.bucket, 'opts.bucket');
    assert.string(opts.key, 'opts.key');
    assert.object(opts.original, 'opts.original');
    assert.string(opts.etag, 'opts.etag');
    assert.object(opts.val, 'opts.val');
    assert.optionalBool(opts.remove, 'opts.remove');
    assert.func(callback, 'callback');

    mod_moray.updateObj({
        moray: opts.moray,
        bucket: opts.bucket,
        key: opts.key,
        original: opts.original,
        etag: opts.etag,
        val: opts.val,
        remove: opts.remove || false
    }, callback);
}


function getModel(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.string(opts.key, 'opts.key');
    assert.func(opts.model, 'opts.model');
    assert.object(opts.bucket, 'opts.bucket');
    assert.func(callback, 'callback');

    mod_moray.getObj(opts.moray, opts.bucket, opts.key,
        function getCb(mErr, rec) {
            if (mErr) {
                callback(mErr);
                return;
            }

            var obj = new opts.model(rec.value);
            obj.etag = rec._etag;
            callback(null, obj);
    });
}


function deleteModel(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.string(opts.key, 'opts.key');
    assert.object(opts.bucket, 'opts.bucket');
    assert.optionalString(opts.etag, 'opts.etag');
    assert.func(callback, 'callback');

    mod_moray.delObj(opts, callback);
}


function repeatableUUIDFromString(str) {
    const hash = crypto.createHash('sha512');
    hash.update(str);
    var buf = hash.digest();
    // variant:
    buf[8] = buf[8] & 0x3f | 0xa0;
    // version:
    buf[6] = buf[6] & 0x0f | 0x50;
    var hex = buf.toString('hex', 0, 16);
    const uuid = [
        hex.substring(0, 8),
        hex.substring(8, 12),
        hex.substring(12, 16),
        hex.substring(16, 20),
        hex.substring(20, 32)
    ].join('-');
    return uuid;
}


function listModel(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.params, 'opts.params');
    assert.object(opts.validFields, 'opts.validFields');
    assert.object(opts.bucket, 'opts.bucket');
    assert.func(opts.model, 'opts.model');
    assert.optionalString(opts.defaultFilter, 'opts.defaultFilter');
    assert.optionalObject(opts.sort, 'opts.sort');
    assert.optionalFunc(opts.listCb, 'opts.listCb');
    assert.func(cb, 'cb');

    if (!opts.defaultFilter) {
        opts.defaultFilter = '(uuid=*)';
    }

    if (!opts.sort) {
        opts.sort = { attribute: '_id', order: 'ASC'};
    }

    if (!opts.listCb) {
        opts.listCb = cb;
    }

    const LIST_SCHEMA = {
        optional: {
            fields: validate.fieldsArray(opts.validFields),
            offset: validate.offset,
            limit: validate.limit
        }
    };

    function validateCb(err, validated) {
        if (err) {
            cb(err);
            return;
        }

        var lim, off;

        if (validated.hasOwnProperty('limit')) {
            lim = validated.limit;
            delete validated.limit;
        }

        if (validated.hasOwnProperty('offset')) {
            off = validated.offset;
            delete validated.offset;
        }
        mod_moray.listObjs({
            defaultFilter: opts.defaultFilter,
            filter: validated,
            limit: lim,
            log: opts.log,
            offset: off,
            bucket: opts.bucket,
            model: opts.model,
            moray: opts.moray,
            sort: opts.sort
        }, opts.listCb);
    }

    if (opts.params.filter) {
        validateCb(null, opts.params.filter);
    } else {
        validate.params(LIST_SCHEMA, null, opts.params, validateCb);
    }
}


/*
 * @param opts {Object}
 * - `moray` {MorayClient}
 * - `filter` {String}: the filter to be used to count records
 * - `bucket` {String}: name of the bucket from where we want to count objects
 * @param callback {Function} `function (err, Number(counter))`
 */
function countModel(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.string(opts.bucket, 'opts.bucket');
    assert.string(opts.filter, 'opts.filter');
    assert.func(cb, 'cb');

    var req = opts.moray.findObjects(opts.bucket, opts.filter, {
        limit: 1,
        offset: 0,
        noBucketCache: true
    });
    var count = 0;

    req.on('record', function (r) {
        if (r && r['_count']) {
            count = Number(r['_count']);
        }
    });

    req.once('error', function (error) {
        cb(error);
    });

    req.once('end', function () {
        cb(null, count);
    });
}

module.exports = {
    Model: Model,
    get: getModel,
    del: deleteModel,
    create: createModel,
    update: updateModel,
    list: listModel,
    count: countModel,
    uuid: repeatableUUIDFromString
};

// vim: set softtabstop=4 shiftwidth=4:
