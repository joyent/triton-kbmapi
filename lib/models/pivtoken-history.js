
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * PIVTokens history: PIVTokens that have been removed from the system
 * but will be kept around for historical inventory reasons.
 *
 * Note that this model is different from PIVToken because the RecoveryTokens
 * associated with each PIVToken at the moment of deleting it are also included
 * into the PIVToken history.
 */

'use strict';
const assert = require('assert-plus');

const mod_moray = require('../apis/moray');
const validate = require('../util/validate');
const model = require('./model');

const BUCKET = {
    desc: 'PIVPIVToken history',
    name: 'kbmapi_pivtoken_history',
    schema: {
        index: {
            guid: { type: 'string' },
            cn_uuid: { type: 'uuid' },
            active_range: { type: 'daterange' }
        }
    },
    version: 0
};

const CREATE_SCHEMA = {
    required: {
        guid: validate.GUID,
        cn_uuid: validate.UUID,
        active_range: validate.isPresent
    }
};

const GET_SCHEMA = {
    required: {
        guid: validate.GUID
    }
};

const DELETE_SCHEMA = {
    required: {
        guid: validate.GUID
    }
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

/**
 * PIVToken model constructor
 */
function PIVToken(params) {
    this.params = {
        guid: params.guid,
        cn_uuid: params.cn_uuid,
        pubkeys: params.pubkeys,
        recovery_tokens: params.recovery_tokens,
        model: params.model,
        serial: params.serial,
        attestation: params.attestation,
        pin: params.pin,
        active_range: params.active_range
    };
    this.etag = params.etag || null;
}

/**
 * Returns the moray key for storing this PIVToken object
 */
PIVToken.prototype.key = function tokenKey() {
    return this.params.guid;
};

PIVToken.prototype.batch = function tokenBatch() {
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
        recovery_tokens: this.params.recovery_tokens,
        model: this.params.model,
        serial: this.params.serial,
        attestation: this.params.attestation,
        pin: this.params.pin
    };
};

PIVToken.prototype.raw = function tokenRaw() {
    var self = this;
    return (Object.assign(self.serialize(), {v: BUCKET.version}));
};

function createPIVToken(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.params, 'opts.params');
    assert.func(callback, 'callback');

    opts.log.debug({ params: opts.params }, 'createPIVToken: history entry');
    if (!opts.params.active_range && opts.params.created) {
        opts.params.active_range =
            [opts.params.created, new Date().toISOString()];
        delete opts.params.created;
    }


    function createPIVTokenCb(err) {
        if (err) {
            callback(err);
            return;
        }

        var token = new PIVToken(opts.params);

        mod_moray.putObj(opts.moray, BUCKET, token,
            function morayPutPIVTokenCb(pErr) {
            if (pErr) {
                callback(pErr);
                return;
            }

            callback(null, token);
        });
    }

    validate.params(CREATE_SCHEMA, null, opts.params, createPIVTokenCb);
}


function getPIVToken(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.params, 'opts.params');
    assert.func(callback, 'callback');

    opts.log.debug(opts.params, 'getPIVToken: history entry');

    validate.params(GET_SCHEMA, null, opts.params,
        function getPIVTokenValidateCb(err) {
        if (err) {
            callback(err);
            return;
        }

        mod_moray.getObj(opts.moray, BUCKET, opts.params.guid,
            function getPIVTokenMorayCb(mErr, token) {
                if (mErr) {
                    callback(mErr);
                    return;
                }

                var tokenObj = new PIVToken(token.value);
                tokenObj.etag = token._etag;

                callback(null, tokenObj);
        });
    });
}


function deletePIVToken(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.params, 'opts.params');
    assert.func(callback, 'callback');

    opts.log.debug(opts.params, 'deletePIVToken: history entry');

    function deletePIVTokenCb(err) {
        if (err) {
            callback(err);
            return;
        }

        opts.moray.delObject(BUCKET.name, opts.params.guid, callback);
    }

    validate.params(DELETE_SCHEMA, null, opts.params, deletePIVTokenCb);
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
        defaultFilter: '(guid=*)'
    }), callback);
}

function initPIVTokenHistoryBucket(moray, cb) {
    mod_moray.initBucket(moray, BUCKET, cb);
}

module.exports = {
    bucket: function () { return BUCKET; },
    create: createPIVToken,
    del: deletePIVToken,
    PIVToken: PIVToken,
    get: getPIVToken,
    list: listPIVTokens,
    init: initPIVTokenHistoryBucket
};

// vim: set softtabstop=4 shiftwidth=4:
