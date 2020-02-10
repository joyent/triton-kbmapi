/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Moray API convenience wrappers
 */

'use strict';

const assert = require('assert-plus');
const constants = require('../util/constants');
const jsprim = require('jsprim');
const restify = require('restify');
const util = require('util');
const VError = require('verror');



// --- Globals



// Allow setting this to prefix all created buckets (generally used for
// testing):
var BUCKET_PFX = '';



// --- Exports


/**
 * Set the bucket prefix to point at the test versions of the buckets
 */
function setTestPrefix(pfx) {
    BUCKET_PFX = pfx;
}

/**
 * Return a bucket name based on BUCKET_PFX
 */
function bucketName(name) {
    return BUCKET_PFX + name;
}


/**
 * Creates an LDAP filter based on the parameters in inObj, only allowing
 * searching by indexes in bucket.schema.index
 *
 * @param inObj {Object}
 * @param bucket {Bucket schema object}
 */
function ldapFilter(inObj, bucket) {
    if (!inObj) {
        return '';
    }

    if (typeof (inObj) === 'string') {
        return inObj;
    }

    if (jsprim.isEmpty(inObj)) {
        return '';
    }

    if (inObj.hasOwnProperty('filter') && typeof (inObj.filter === 'string')) {
        return inObj.filter;
    }

    var filterBy = Object.keys(inObj).reduce(function (arr, i) {
        if (bucket && !bucket.schema.index.hasOwnProperty(i)) {
            return arr;
        }

        // Comma-separated values: turn them into a list
        if (typeof (inObj[i]) === 'string' &&
            inObj[i].indexOf(',') !== -1) {
            /* JSSTYLED */
            inObj[i] = inObj[i].split(/\s*,\s*/);
        }

        if (typeof (inObj[i]) === 'object') {
            arr.push('(|');
            for (var j in inObj[i]) {
                if (typeof (inObj[i][j]) === 'number') {
                    arr.push(util.format('(%s=%d)', i, inObj[i][j]));
                } else {
                    if (inObj[i][j].substr(0, 1) === '!') {
                        arr.push(util.format('(!(%s=%s))', i,
                            inObj[i][j].substr(1)));
                    } else {
                        arr.push(util.format('(%s=%s)', i, inObj[i][j]));
                    }
                }
            }
            arr.push(')');
        } else if (typeof (inObj[i]) === 'boolean') {
            if (inObj[i]) {
                arr.push(util.format('(%s=true)', i));
            } else {
                arr.push(util.format('(!(%s=true))', i));
            }
        } else {
            arr.push(util.format('(%s=%s)', i, inObj[i]));
        }

        return arr;
    }, []);

    if (filterBy.length > 1) {
        filterBy.unshift('(&');
        filterBy.push(')');
    }

    return filterBy.join('');
}


/**
 * Initializes a bucket in moray
 *
 * @param moray {MorayClient}
 * @param bucket {Bucket schema object}
 * @param callback {Function} `function (err, netObj)`
 */
function initBucket(moray, bucket, callback) {
    assert.object(moray, 'moray');
    assert.object(bucket, 'bucket');
    assert.string(bucket.desc, 'bucket.desc');
    assert.string(bucket.name, 'bucket.name');
    assert.object(bucket.schema, 'bucket.schema');

    var name = bucket.name;
    var schema = jsprim.deepCopy(bucket.schema);

    /*
     * If we have a bucket prefix set and this is the first time looking at this
     * bucket config, then update it to use the prefixed version so that any
     * consumers in its model will use the correct prefixed name.
     */
    if (BUCKET_PFX !== '' && !bucket.name_prefixed) {
        name = bucketName(bucket.name);

        moray.log.warn({ oldBucketName: bucket.name, newBucketName: name },
            'initBucket: bucket prefix set: overriding name');

        bucket.name = name;
        bucket.name_prefixed = true;
    }

    moray.getBucket(name, function (err, prevBucket) {
        if (err) {
            if (VError.hasCauseWithName(err, 'BucketNotFoundError')) {
                // If this is a new creation and we have a bucket
                // version, use it, since we don't need to migrate.
                if (bucket.hasOwnProperty('version')) {
                    schema.options = { version: bucket.version };
                }

                moray.log.info({ schema: schema, bucketName: name },
                    'initBucket: creating bucket');

                return moray.createBucket(name, schema,
                    function (err2, res) {
                        if (err2) {
                            moray.log.error(err2,
                                'initBucket: error creating bucket %s',
                                name);
                        } else {
                            moray.log.info({ schema: schema },
                                'initBucket: successfully created bucket %s',
                                name);
                        }

                        return callback(err2, res);
                });
            }

            moray.log.error(err, 'initBucket: error getting bucket %s',
                name);
            return callback(err);
        }

        moray.log.debug({ bucket: prevBucket }, 'bucket exists');

        return callback();
    });
}


/**
 * Deletes an object from moray
 * @param opts {Object} including the following properties
 * - @param moray {MorayClient}
 * - @param bucket {Bucket schema object}
 * - @param key {String}
 * - @param etag {String} Optional
 * @param callback {Function} `function (err)`
 */
function delObj(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.bucket, 'opts.bucket');
    assert.string(opts.key, 'opts.key');
    assert.optionalString(opts.etag, 'opts.etag');
    assert.func(callback, 'callback');
    var morayOpts = {};
    if (opts.etag) {
        morayOpts.etag = opts.etag;
    }

    opts.moray.delObject(opts.bucket.name, opts.key, morayOpts,
        function morayDelCb(err) {
        if (err && VError.hasCauseWithName(err, 'ObjectNotFoundError')) {
            return callback(new restify.ResourceNotFoundError(err,
                '%s not found', opts.bucket.desc));
        }

        return callback(err);
    });
}


/**
 * Gets an object from moray
 *
 * @param moray {MorayClient}
 * @param bucket {Bucket schema object}
 * @param key {String}
 * @param callback {Function} `function (err, netObj)`
 */
function getObj(moray, bucket, key, callback) {
    moray.getObject(bucket.name, key, function (err, res) {
        if (err) {
            if (VError.hasCauseWithName(err, 'ObjectNotFoundError')) {
                return callback(new restify.ResourceNotFoundError(err,
                    '%s not found', bucket.desc));
            }

            return callback(err);
        }

        return callback(null, res);
    });
}


/**
 * Puts an object into Moray, using its current etag, and updating it with
 * the new one afterwards.
 *
 * @param moray {MorayClient}
 * @param bucket {Bucket schema object}
 * @param obj {Object}
 * @param callback {Function} `function (err, obj)`
 */
function putObj(moray, bucket, obj, callback) {
    assert.object(moray, 'moray');
    assert.object(bucket, 'bucket');
    assert.object(obj, 'obj');
    assert.func(callback, 'callback');

    moray.putObject(bucket.name, obj.key(), obj.raw(), {
        etag: obj.etag
    }, function (err, res) {
        if (err) {
            callback(err);
            return;
        }

        obj.etag = res.etag;

        callback(null, obj);
    });
}


/**
 * Lists objects in moray
 *
 * @param opts {Object}
 * - `bucket` {Bucket schema object}
 * - `filter` {String}
 * - `limit` {Integer}
 * - `log` {Bunyan Logger}
 * - `offset` {Integer}
 * - `moray` {MorayClient}
 * - `sort` {Object} (optional)
 * - `model` {Object} (optional)
 * - `noBucketCache` {Boolean} (optional)
 * - `extra` {Object} (optional) extra params to pass to constructor
 * @param callback {Function} `function (err, netObj)`
 */
function listObjs(opts, callback) {
    var listOpts = {};
    var results = [];

    if (opts.sort) {
        listOpts.sort = opts.sort;
    }

    assert.optionalNumber(opts.limit);
    if (opts.limit) {
        listOpts.limit = opts.limit;
    } else {
        listOpts.limit = constants.DEFAULT_LIMIT;
    }

    assert.optionalNumber(opts.offset);
    if (opts.offset) {
        listOpts.offset = opts.offset;
    } else {
        listOpts.offset = constants.DEFAULT_OFFSET;
    }

    if (opts.noBucketCache) {
        listOpts.noBucketCache = true;
    }

    var filter = ldapFilter(opts.filter, opts.bucket) || opts.defaultFilter;
    opts.log.debug({ params: opts.filter }, 'LDAP filter: "%s"', filter);

    var req = opts.moray.findObjects(opts.bucket.name,
        filter, listOpts);

    req.on('error', function _onListErr(err) {
        return callback(err);
    });

    req.on('record', function _onListRec(rec) {
        opts.log.debug({ record: rec }, 'record from moray');
        rec.value.etag = rec._etag;
        if (opts.model) {
            if (opts.extra) {
                Object.keys(opts.extra).forEach(function (k) {
                    rec.value[k] = opts.extra[k];
                });
            }
            results.push(new opts.model(rec.value, {
                // Optionally pass moray and log to the model
                // constructor so it can search for other associated models:
                moray: opts.moray,
                log: opts.log
            }));
        } else {
            results.push(rec);
        }
    });

    req.on('end', function _endList() {
        return callback(null, results);
    });
}


/**
 * Updates an object in moray
 *
 * @param opts {Object}
 * - `moray` {MorayClient}
 * - `bucket` {Bucket schema object}
 * - `key` {String} : bucket key to update
 * - `original` {Object}: The original value stored in Moray
 * - `etag` {String}: The etag for the original Moray object
 * - `remove` {Boolean} : remove all keys in val from the object (optional)
 * - `val` {Object} : keys to update in the object
 * @param callback {Function} `function (err, morayObj)`
 */
function updateObj(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.bucket, 'opts.bucket');
    assert.string(opts.key, 'opts.key');
    assert.object(opts.original, 'opts.original');
    assert.string(opts.etag, 'opts.etag');
    assert.object(opts.val, 'opts.val');
    assert.optionalBool(opts.remove, 'opts.remove');
    assert.func(callback, 'callback');

    var value = jsprim.deepCopy(opts.original);
    for (var k in opts.val) {
        if (opts.remove) {
            delete value[k];
        } else {
            value[k] = opts.val[k];
        }
    }

    opts.moray.putObject(opts.bucket.name, opts.key, value, {
        etag: opts.etag
    }, function (pErr, info) {
        if (pErr) {
            callback(pErr);
            return;
        }

        value.etag = info.etag;

        callback(null, { value: value });
    });
}


/**
 * Converts an array to a scalar value suitable for indexed fields in
 * moray, since array types can't be indexed on properly.
 */
function arrayToVal(arr) {
    return ',' + arr.join(',') + ',';
}


function arrayify(obj) {
    if (typeof (obj) === 'object') {
        return obj;
    }

    if (obj === '') {
        return [];
    }

    return obj.split(',');
}

/**
 * Converts an moray indexed array value as returned by arraytoVal() to a
 * real array object.
 */
function valToArray(params, key) {
    if (!params.hasOwnProperty(key)) {
        return;
    }

    if (typeof (params[key]) === 'object') {
        return;
    }

    if (params[key] === ',,') {
        delete params[key];
        return;
    }
    params[key] =
        /* JSSTYLED */
        arrayify(params[key].replace(/^,/, '').replace(/,$/, ''));
}



module.exports = {
    arrayToVal: arrayToVal,
    bucketName: bucketName,
    delObj: delObj,
    filter: ldapFilter,
    getObj: getObj,
    putObj: putObj,
    initBucket: initBucket,
    listObjs: listObjs,
    setTestPrefix: setTestPrefix,
    updateObj: updateObj,
    valToArray: valToArray
};
