/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Common test helpers shared between (future) integration and unit tests
 */

'use strict';

var KBMAPI = require('../../client/');
var assert = require('assert-plus');
var fmt = require('util').format;
var jsprim = require('jsprim');
var mod_uuid = require('node-uuid');
var util = require('util');

var CREATED = {};

function requestHeaders(opts) {
    var headers = opts.headers || {};

    headers['x-request-id'] = mod_uuid.v4();

    if (opts.etag) {
        headers['If-Match'] = opts.etag;
    }

    return headers;
}

/**
 * Adds the given object to:
 * - CREATED[type]
 * - opts.state (if opts and opts.state are present)
 * - opts.state[opts.stateProp]
 *   (if opts, opts.state and opts.stateProp are present)
 */
function addToState(opts, type, obj) {
    if (!CREATED.hasOwnProperty(type)) {
        CREATED[type] = [];
    }

    CREATED[type].push(obj);

    if (!opts.state || !obj) {
        return;
    }

    if (!opts.state.hasOwnProperty(type)) {
        opts.state[type] = [];
    }

    var newObj = jsprim.deepCopy(obj);
    if (opts.hasOwnProperty('stateProp')) {
        if (!opts.state.hasOwnProperty(opts.stateProp)) {
            opts.state[opts.stateProp] = [];
        }

        opts.state[opts.stateProp].push(newObj);
    }

    opts.state[type].push(newObj);
}

/**
 * Shared test code for after API methods are called
 */
function afterAPIcall(t, opts, callback, err, obj, res) {
    var desc = opts.desc ? (' ' + opts.desc) : '';
    assert.string(opts.reqType, 'opts.reqType');
    assert.string(opts.type, 'opts.type');
    var type = opts.reqType + ' ' + opts.type + ': ';

    if (opts.expErr) {
        t.ok(err, type + 'expected error' + desc);
        if (err) {
            var code = opts.expCode || 422;
            t.equal(err.statusCode, code, type + 'status code' + desc);
            t.deepEqual(err.body, opts.expErr, type + 'error body' + desc);
        } else if (obj) {
            t.deepEqual(obj, {}, 'body (error expected)' + desc);
        }

        done(err, null, res, opts, t, callback);
        return;
    }

    if (ifErr(t, err, type + desc)) {
        done(err, null, res, opts, t, callback);
        return;
    }

    t.ok([200, 201].indexOf(res.statusCode) !== -1, 'status code ' + desc);

    if (opts.hasOwnProperty('idKey')) {
        t.ok(true, fmt('created %s "%s"', opts.type, obj[opts.idKey]));
    }

    if (opts.exp) {
        // For creates, the server will generate an ID (usually a UUID) if
        // it's not set in the request.  Copy this over to the expected
        // object so that we don't have to set it manually:
        if (opts.hasOwnProperty('idKey') &&
                !opts.exp.hasOwnProperty(opts.idKey)) {
            opts.exp[opts.idKey] = obj[opts.idKey];
        }

        // Allow filling in values that might be generated before doing the
        // deepEqual below:
        if (opts.hasOwnProperty('fillIn')) {
            opts.fillIn.forEach(function (prop) {
                if (!opts.exp.hasOwnProperty(prop) &&
                    obj.hasOwnProperty(prop)) {
                    opts.exp[prop] = obj[prop];
                }
            });
        }

        var actual = obj;
        var expected = opts.exp;

        if (opts.hasOwnProperty('ignore')) {
            var objClone = jsprim.deepCopy(obj);
            var expClone = jsprim.deepCopy(opts.exp);

            opts.ignore.forEach(function (ign) {
                delete objClone[ign];
                delete expClone[ign];
            });

            actual = objClone;
            expected = expClone;
        }

        t.deepEqual(actual, expected, type + 'full result' + desc);
    }

    if (opts.partialExp) {
        var partialRes = {};
        for (var p in opts.partialExp) {
            partialRes[p] = obj[p];
        }

        t.deepEqual(partialRes, opts.partialExp,
            type + 'partial result' + desc);
    }

    if (opts.reqType === 'create') {
        // We take plural names elsewhere, but expect the singular here:
        assert.notEqual('s', opts.type.slice(-1));
        addToState(opts, opts.type + 's', obj);
    }

    done(null, obj, res, opts, t, callback);
}

/**
 * Shared test code for after API delete methods are called
 */
function afterAPIdelete(t, opts, callback, err, res) {
    var desc = opts.desc ? (' ' + opts.desc) : '';
    assert.string(opts.type, 'opts.type');
    assert.string(opts.id, 'opts.id');
    var type = util.format('delete %s %s: ', opts.type, opts.id);

    if (opts.expErr) {
        t.ok(err, 'expected error');
        if (err) {
            var code = opts.expCode || 422;
            t.equal(err.statusCode, code, 'status code');
            t.deepEqual(err.body, opts.expErr, 'error body');
        }

        done(err, null, res, opts, t, callback);
        return;
    }

    // mightNotExist allows for calling mod_whatever.dellAllCreated() when
    // some of the created objects were actually deleted during the test:
    if (opts.mightNotExist && err && err.restCode === 'ResourceNotFound') {
        done(null, null, res, opts, t, callback);
        return;
    }

    if (ifErr(t, err, type + desc)) {
        done(err, null, res, opts, t, callback);
        return;
    }

    t.equal(res.statusCode, 204, type + 'status code' + desc);

    done(null, null, res, opts, t, callback);
}

/**
 * Shared test code for after API list methods are called
 */
function afterAPIlist(t, opts, callback, err, obj, res) {
    assert.string(opts.type, 'opts.type');
    assert.string(opts.id, 'opts.id');
    assert.optionalArray(opts.present, 'opts.present');

    var desc = opts.desc ? (' ' + opts.desc) : '';
    var id = opts.id;
    var type = opts.type;

    if (opts.expErr) {
        t.ok(err, type + 'expected error' + desc);
        if (err) {
            var code = opts.expCode || 422;
            t.equal(err.statusCode, code, type + 'status code' + desc);
            t.deepEqual(err.body, opts.expErr, type + 'error body' + desc);
        }

        done(err, null, res, opts, t, callback);
        return;
    }

    if (ifErr(t, err, type + desc)) {
        done(err, null, res, opts, t, callback);
        return;
    }

    t.equal(res.statusCode, 200, 'status code' + desc);
    t.ok(true, obj.length + ' results returned' + desc);

    if (opts.present) {
        var left = jsprim.deepCopy(opts.present);
        var ids = left.map(function (o) { return o[id]; });
        var present = jsprim.deepCopy(ids);
        var notInPresent = [];

        jsprim.forEachKey(obj, function (_key, resObj) {
            var idx = ids.indexOf(resObj[id]);
            if (idx !== -1) {
                var expObj = left[idx];
                var partialRes = {};
                for (var p in expObj) {
                    partialRes[p] = resObj[p];
                }

                var tsOpts = {
                    id: opts.id,
                    type: opts.type,
                    reqType: opts.reqType,
                    exp: expObj,
                    ignore: jsprim.deepCopy(opts.ignore)
                };

                if (opts.ts && opts.ts[idx]) {
                    tsOpts.ts = opts.ts[idx];
                }

                if (opts.deepEqual) {
                    // ignore doesn't really make sense in the context of a
                    // partial response
                    if (tsOpts.ignore) {
                        var resClone = jsprim.deepCopy(resObj);
                        var expClone = jsprim.deepCopy(expObj);

                        tsOpts.ignore.forEach(function (ign) {
                            delete resClone[ign];
                            delete expClone[ign];
                        });

                        resObj = resClone;
                        expObj = expClone;
                    }

                    t.deepEqual(resObj, expObj,
                        'full result for ' + resObj[id] + desc);
                } else {
                    t.deepEqual(partialRes, expObj,
                        'partial result for ' + resObj[id] + desc);
                }

                ids.splice(idx, 1);
                left.splice(idx, 1);
            } else {
                notInPresent.push(resObj);
            }
        });

        t.deepEqual(ids, [],
            'found ' + type + 's not specified in opts.present ' + desc);

        if (ids.length !== 0) {
            t.deepEqual(present, [], 'IDs in present list');
        }

        if (opts.deepEqual) {
            t.deepEqual(notInPresent, [], 'IDs not in present list');
        }
    }

    done(null, obj, res, opts, t, callback);
}

/**
 * Assert the arguments to one of the helper functions are correct
 */
function assertArgs(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.optionalObject(opts.exp, 'opts.exp');
    assert.optionalObject(opts.expErr, 'opts.expErr');
    assert.optionalObject(opts.partialExp, 'opts.partialExp');
    assert.ok(opts.exp || opts.partialExp || opts.expErr,
        'one of exp, expErr, partialExp required');
    assert.optionalString(opts.etag, 'opts.etag');
    assert.optionalObject(opts.params, 'opts.params');
    assert.optionalObject(opts.state, 'opts.state');
    assert.optionalFunc(callback, 'callback');
}


/**
 * Assert the arguments to one of the list helper functions are correct
 */
function assertArgsList(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.optionalObject(opts.params, 'opts.params');
    assert.optionalObject(opts.expErr, 'opts.expErr');
    assert.optionalBool(opts.deepEqual, 'opts.deepEqual');
    assert.optionalArrayOfObject(opts.present, 'opts.present');
    assert.optionalFunc(callback, 'callback');
}

/**
 * Finish a test
 */
function done(err, obj, res, opts, t, callback) {
    if (callback) {
        callback(opts.continueOnErr ? null : err, obj, res);
        return;
    }

    t.end();
}


/**
 * Finish a test with an error
 */
function doneErr(err, t, callback) {
    if (callback) {
        return callback(err);
    }

    return t.end();
}


/**
 * Finish a test with a result
 */
function doneRes(res, t, callback) {
    if (callback) {
        return callback(null, res);
    }

    return t.end();
}

/**
 * Calls t.ifError, outputs the error body for diagnostic purposes, and
 * returns true if there was an error
 */
function ifErr(t, err, desc) {
    t.ifError(err, desc);
    if (err) {
        t.deepEqual(err.body, {}, desc + ': error body');
        return true;
    }

    return false;
}

function requestOpts(t, opts) {
    assert.object(t, 't');

    var desc;
    if (typeof (opts) === 'undefined') {
        desc = '';
        opts = {};
    } else if (typeof (opts) === 'string') {
        desc = ': ' + opts;
        opts = {};
    } else {
        assert.object(opts, 'opts');
        desc = opts.desc ? ': ' + opts.desc : '';
    }

    var headers = requestHeaders(opts);
    var reqId = headers['x-request-id'];

    t.ok(reqId, fmt('req ID: %s%s', reqId, desc));
}

function resetCreated() {
    CREATED = {};
}

function createClient(url, t) {
    var reqID = mod_uuid.v4();
    var opts = {
        agent: false,
        headers: { 'x-request-id': reqID },
        url: url
    };

    var client = new KBMAPI(opts);
    client.req_id = reqID;

    if (t) {
        t.ok(client, 'created client with req_id=' + client.req_id);
    }

    return client;
}

module.exports = {
    afterAPIcall: afterAPIcall,
    afterAPIdelete: afterAPIdelete,
    afterAPIlist: afterAPIlist,
    assertArgs: assertArgs,
    assertArgsList: assertArgsList,
    createClient: createClient,
    doneErr: doneErr,
    doneRes: doneRes,
    ifErr: ifErr,
    resetCreated: resetCreated,
    reqOpts: requestOpts
};
