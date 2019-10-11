/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Model for Recovery Configuration Transitions and associated functions
 */


'use strict';
const assert = require('assert-plus');
const util = require('util');
const VError = require('verror');
const UUID = require('node-uuid');

const mod_moray = require('../apis/moray');
const validate = require('../util/validate');
const model = require('./model');
const errors = require('../util/errors');

const TRANSITION_CN_CONCURRENCY = 10;

const BUCKET = {
    desc: 'Recovery configuration transitions',
    name: 'kbmapi_recovery_config_transitions',
    schema: {
        index: {
            uuid: { type: 'uuid', unique: true },
            recovery_config_uuid: { type: 'uuid'},
            name: { type: 'string' },
            targets: { type: '[string]'},
            completed: { type: '[string]'},
            wip: { type: '[string]'},
            taskids: { type: '[string]'},
            concurrency: { type: 'number' },
            locked_by: { type: 'uuid' },
            created: { type: 'date' },
            aborted: { type: 'boolean' },
            forced: { type: 'boolean' },
            // If we use a type 'date' here, using a filter like
            // '(!(finished=*))' will not work.
            started: { type: 'string' },
            finished: { type: 'string' }
        }
    },
    version: 0
};

const CREATE_SCHEMA = {
    required: {
        uuid: validate.UUID,
        recovery_config_uuid: validate.UUID,
        name: validate.enum(['stage', 'unstage', 'activate', 'deactivate']),
        // It would be desirable to validate each one of
        // the values to be a UUID
        targets: validate.arrayOfUuid,
        concurrency: validate.isPresent,
        forced: validate.bool,
        created: validate.iso8601
    }
};

// These are the values to be modified. All the values in CREATE_SCHEMA
// cannot be modified after initial creation.
const UPDATE_SCHEMA = {
    optional: {
        completed: validate.arrayOfUuid,
        taskids: validate.arrayOfUuid,
        wip: validate.arrayOfUuid,
        aborted: validate.bool,
        started: validate.iso8601,
        finished: validate.iso8601
    }
};

// These are used for listing filters:
const VALID_FIELDS = [
    'uuid',
    'recovery_config_uuid',
    'name',
    'targets',
    'completed',
    'wip',
    'taskids',
    'concurrency',
    'locked_by',
    'aborted',
    'forced',
    'started',
    'finished',
    'created'
];

function RecoveryConfigurationTransition(params) {
    model.Model.call(this, params);
    this.params = {
        uuid: params.uuid,
        recovery_config_uuid: params.recovery_config_uuid,
        name: params.name,
        targets: params.targets,
        completed: params.completed,
        wip: params.wip,
        taskids: params.taskids,
        concurrency: params.concurrency,
        locked_by: params.locked_by,
        aborted: params.aborted,
        forced: params.forced,
        started: params.started,
        finished: params.finished,
        created: params.created
    };
}

util.inherits(RecoveryConfigurationTransition, model.Model);

/*
 * Required by moray client implementation in use.
 */
RecoveryConfigurationTransition.prototype.key = function key() {
    return this.params.uuid;
};

RecoveryConfigurationTransition.prototype.batch = function batch() {
    return {
        bucket: BUCKET.name,
        key: this.params.uuid,
        operation: 'put',
        value: this.raw(),
        options: {
            etag: this.etag
        }
    };
};

RecoveryConfigurationTransition.prototype.serialize = function serialize() {
    return {
        uuid: this.params.uuid,
        recovery_config_uuid: this.params.recovery_config_uuid,
        name: this.params.name,
        targets: this.params.targets,
        completed: this.params.completed,
        wip: this.params.wip,
        taskids: this.params.taskids,
        concurrency: this.params.concurrency,
        locked_by: this.params.locked_by,
        aborted: this.params.aborted,
        forced: this.params.forced,
        started: this.params.started,
        finished: this.params.finished,
        created: this.params.created
    };
};

/*
 * Required by moray client implementation in use.
 */
RecoveryConfigurationTransition.prototype.raw = function tokenRaw() {
    var self = this;
    return (Object.assign(self.serialize(), {v: BUCKET.version}));
};

/*
 * See model.create for required parameters
 */
function createRecoveryConfigurationTransition(opts, cb) {
    // model.create will assert for all the expected stuff in opts
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    if (!opts.params.concurrency) {
        opts.params.concurrency = TRANSITION_CN_CONCURRENCY;
    }

    if (!opts.params.uuid) {
        opts.params.uuid = UUID.v4();
    }

    if (typeof (opts.params.forced) === 'undefined') {
        opts.params.forced = false;
    }

    if (!opts.params.created) {
        opts.params.created = new Date().toISOString();
    }

    var createOpts = Object.assign(opts, {
        createSchema: CREATE_SCHEMA,
        bucket: BUCKET,
        model: RecoveryConfigurationTransition
    });

    model.create(createOpts, cb);
}

function getRecoveryConfigurationTransition(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');

    var getOpts = Object.assign(opts, {
        bucket: BUCKET,
        model: RecoveryConfigurationTransition,
        key: opts.uuid || (opts.params && opts.params.uuid)
    });
    model.get(getOpts, callback);
}

/*
 * @param opts {Object}
 * - `moray` {MorayClient}
 * - `key` {String} : uuid of the recovery configuration transition to update
 * - `etag` {String}: The etag for the original Moray object
 * - `remove` {Boolean} : remove all keys in val from the object (optional)
 * - `val` {Object} : keys to update in the object
 * @param cb {Function} `function (err, new RecoveryConfigurationTransition())`
 */
function updateRecoveryConfigurationTransition(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.val, 'opts.val');
    assert.optionalBool(opts.remove, 'opts.remove');
    assert.func(callback, 'callback');

    // None of the initially required properties of the object
    // can be modified. Let's ensure it:
    const fixedProps = Object.keys(CREATE_SCHEMA.required);
    const disallowedValues = Object.keys(opts.val).filter(function isDisal(p) {
        return (fixedProps.indexOf(p) !== -1);
    });

    if (disallowedValues.length) {
        callback(new errors.InvalidParamsError('invalid parameters', [
            new VError(disallowedValues.join(', ') + ' cannot be modified.')
        ]));
        return;
    }

    function validCb(validationErr) {
        if (validationErr) {
            callback(validationErr);
            return;
        }
        getRecoveryConfigurationTransition({
            uuid: opts.key,
            moray: opts.moray,
            model: RecoveryConfigurationTransition
        }, function getCb(getErr, recCfgTr) {
            if (getErr) {
                callback(getErr);
                return;
            }

            var updateOpts = Object.assign(opts, {
                bucket: BUCKET,
                original: recCfgTr.raw(),
                etag: opts.etag || recCfgTr.etag
            });

            model.update(updateOpts, function updateCb(updateErr, updatedVal) {
                if (updateErr) {
                    callback(updateErr);
                    return;
                }

                const etag = updatedVal.value.etag;
                delete updatedVal.value.etag;

                var obj = new RecoveryConfigurationTransition(updatedVal.value);
                obj.etag = etag;
                callback(null, obj);
            });
        });
    }

    validate.params(UPDATE_SCHEMA, null, opts.val, validCb);
}


function deleteRecoveryConfigurationTransition(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');

    var delOpts = Object.assign(opts, {
        bucket: BUCKET,
        key: opts.uuid || (opts.params && opts.params.uuid)
    });

    model.del(delOpts, callback);
}




function listRecoveryConfigurationsTransitions(opts, cb) {
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
        model: RecoveryConfigurationTransition,
        defaultFilter: '(recovery_config_uuid=*)'
    }), cb);
}


function initRecoveryConfigurationsTransitionsBucket(moray, cb) {
    mod_moray.initBucket(moray, BUCKET, cb);
}

module.exports = {
    bucket: function () { return BUCKET; },
    create: createRecoveryConfigurationTransition,
    update: updateRecoveryConfigurationTransition,
    del: deleteRecoveryConfigurationTransition,
    get: getRecoveryConfigurationTransition,
    ls: listRecoveryConfigurationsTransitions,
    RecoveryConfigurationTransition: RecoveryConfigurationTransition,
    init: initRecoveryConfigurationsTransitionsBucket
};
// vim: set softtabstop=4 shiftwidth=4:
