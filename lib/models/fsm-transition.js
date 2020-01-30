/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Generate a FSM transition for a given RecoveryConfiguration.
 */

'use strict';

const assert = require('assert-plus');
const UUID = require('node-uuid');
const util = require('util');
const format = util.format;
const vasync = require('vasync');
const VError = require('verror');

const errors = require('../util/errors');

const mod_pivtoken = require('./pivtoken');
const mod_recovery_configuration = require('./recovery-configuration');
const mod_recovery_token = require('./recovery-token');
const mod_rec_cfg_tr = require('./recovery-configuration-transition');
const model = require('./model');

/*
 * Valid transitions for the different recovery configuration
 * (recCfg) states.
 *
 * This includes the existence or not of recCfg transition records
 * associated with the current recCfg.
 *
 * The following is a list of the different recCfg statuses based
 * into the different properties of recCfg itself and the associated
 * recCfgTransition object created each time a transition from one
 * state to another begins.
 *
 * - "NEW": Only the recCfg exists. None of 'staged', 'activated',
 *   'created' or 'expired' exists. This state together with 'destroyed'
 *   are used only to make sure all our functions work
 *   for object instances not yet added to the backend or just removed
 *   from it.
 * - "CREATED": The recCfg object has been saved into persistent storage
 *   and the value for 'created' has been added.
 * - "STAGING": The field 'staged' hasn't been set yet, but there's
 *   a recCfgTransition with name set to "stage", which may or not
 *   have been started yet.
 * - "STAGED": The aforementioned recCfg transition has finished (and
 *   the proper 'finished' timestamp has been added to it) and the
 *   'staged' timestamp has been set for the recovery config itself.
 * - "UNSTAGING": A new recCfgTransition has been created with name
 *   "unstage". It's not 'finished' yet. (When this transition finishes
 *   the 'staged' value will be removed from the recovery config
 *   object).
 * - "ACTIVATING": The field 'activated' hasn't been set yet, but
 *   there is a recCfgTranstion with name set to "activate", which
 *   may or not have been started yet
 * - "ACTIVE": The aforementioned recCfg transition has finished (and
 *   the proper 'finished' timestamp has been added to it) and the
 *   'activated' timestamp has been set for the recovery config itself.
 * - "DEACTIVATING": A new recCfgTransition has been created with name
 *   "deactivate". It's not 'finished' yet. (When this transition
 *   finishes the 'activated' value will be removed from the recovery
 *   config object).
 * - "EXPIRED": A given recovery configuration will enter the 'expired'
 *   state when another one enters the 'active' state. There's no
 *   transition for this state change. The 'expired' recCfg will reach
 *   that state straight from 'active'. The 'expired' field will be
 *   added to the recovery configuration record.
 * - "REACTIVATED": There's no such 'reactivated' state, but 'created',
 *   which can be reached by a recovery configuration in 'expired' state.
 *   Again, there's no recCfgTransition for this state change. The values
 *   for 'staged', 'activated' and 'expired' will be removed from the
 *   recovery configuration record, together with any recCfgTransitions
 *   associated with a previous life cycle.
 * - "REMOVED": There's no such recovery configuration record any more.
 *   The recovery configuration and all the recCfgTransitions associated
 *   with the recovery configuration during its lifetime will be removed.
 *
 *   When we got a WIP transition, the only supported operation is to "CANCEL"
 *
 *   It's not allowed to try to "activate" a recovery configuration into
 *   a single CN if the activation is taking place into another CN (i.e,
 *   if there's an unfinished transition of the same type) even if the
 *   --force option is provided.
 *
 *
 *   Note that `--force` applies only to activation of already staged recovery
 *   configuration. It doesn't apply to any other transitions.
 *
 */
const RECOVERY_CONFIGURATION_STATIC_STATES = {
    'new': {
        validTransitions: ['create']
    },
    'created': {
        validTransitions: ['stage', 'destroy']
    },
    'staged': {
        validTransitions: ['unstage', 'activate']
    },
    'active': {
        validTransitions: ['expire', 'deactivate']
    },
    'expired': {
        validTransitions: ['reactivate', 'destroy']
    },
    'removed': {
        validTransitions: []
    }
};


function getRecCfgState(recCfg) {
    const p = recCfg.params;
    if (!p.created) {
        return 'new';
    }

    if (p.created && !p.staged) {
        return 'created';
    }

    if (p.staged && !p.activated) {
        return 'staged';
    }

    if (p.activated && !p.expired) {
        return 'active';
    }

    if (p.expired) {
        return 'expired';
    }

    return 'removed';
}


/*
 * Creates a RecoveryConfigurationTransition object, used to help during
 * the changes required across a Triton DC to stage or activate a
 * RecoveryConfiguration.
 *
 * This RecoveryConfigurationTransition object will track progress of
 * this process, provide information regarding VM running the transition
 * main process, keep details regarding any possible errors, ...
 *
 * @param opts {Object} including the following members:
 * - @param moray {Object} moray client instance
 * - @param log {Object} bunyan logger instance
 * - @param action {String} the name of the transition. One of 'stage',
 *   'unstage', 'activate', 'deactivate', 'expire' or 'reactivate'.
 * - @param params {Object} required for transition creation. Will include
 *   some of the following parameters:
 *   - @param uuid {UUID} Optional recovery configuration UUID
 *   - @param recoveryConfiguration {Object} Optional the Recovery Configuration
 *     we will transition into a different state. If not provided, the uuid
 *     param is mandatory and will be used to find the recovery configuration.
 *   - @param pivtoken {String} pivtoken's GUIDs for which the recovery config
 *     transition will take place.
 *   - @param force {Boolean} force an activate transition despite of some CNs
 *     which may have not the required recovery configuration staged. Note that
 *     when the transition is finished, the RecoveryConfiguration will remain
 *     into the same state, since it's assumed that the final state is aquired
 *     only after a "complete" transition for all the CNs.
 * @params callback {Function} of the form f(err, result)
 *
 * The result will be an object including a recovery configuration and a
 * recovery configuration transition object but for the cases where we don't
 * need to create it ('expire', 'reactivate', 'cancel')
 *
 * Note that in the case where a transition of the same type has been created
 * for the given recovery configuration, and such transition hasn't been
 * finished (or aborted), an error will be returned and, together with the
 * error, all the information about the recovery configuration and the pending
 * transition.
 */
function transition(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.action, 'opts.action');
    assert.object(opts.params, 'opts.params');
    assert.optionalObject(opts.params.recoveryConfiguration,
        'opts.params.recoveryConfiguration');
    assert.optionalUuid(opts.params.uuid, 'opts.params.uuid');
    assert.optionalBool(opts.params.force, 'opts.params.force');
    assert.optionalBool(opts.params.standalone, 'opts.params.standalone');
    assert.optionalString(opts.params.pivtoken, 'opts.params.pivtoken');
    assert.func(cb, 'cb');

    if (!opts.params.uuid && !opts.params.recoveryConfiguration) {
        cb(new errors.InvalidParamsError(
            'Missing parameter',
            [new VError('Either a recovery configuration ' +
            'object or uuid is required')]));
        return;
    }

    opts.params.force = opts.params.force || false;
    opts.params.standalone = opts.params.standalone || false;

    const validActions = [
        'stage', 'unstage', 'activate',
        'deactivate', 'expire', 'reactivate',
        'cancel'
    ];

    if (validActions.indexOf(opts.action) === -1) {
        cb(new errors.InvalidParamsError(
            'Invalid action=\'' + opts.action + '\' parameter',
            [new VError('%s is not a valid transition name', opts.action)]));
        return;
    }

    const action = opts.action;

    var context = {
        recoveryConfiguration: opts.params.recoveryConfiguration,
        uuid: opts.params.uuid,
        transitioning: false,
        targets: opts.params.targets,
        pivtoken: opts.params.pivtoken,
        standalone: opts.params.standalone,
        force: opts.params.force
    };

    vasync.pipeline({arg: context, funcs: [
        function getCfg(ctx, next) {
            if (ctx.recoveryConfiguration) {
                next();
                return;
            }

            mod_recovery_configuration.get({
                moray: opts.moray,
                params: {
                    uuid: ctx.uuid
                }
            }, function getCb(getErr, recCfg) {
                if (getErr) {
                    next(getErr);
                    return;
                }

                ctx.recoveryConfiguration = recCfg;
                next();
            });
        },

        function getPivtoken(ctx, next) {
            if (!ctx.pivtoken) {
                next();
                return;
            }
            mod_pivtoken.get({
                moray: opts.moray,
                log: opts.log,
                params: {
                    guid: ctx.pivtoken
                }
            }, function getCb(getErr, getRes) {
                if (getErr) {
                    next(getErr);
                    return;
                }
                if (getRes) {
                    ctx.targets = [getRes.raw().cn_uuid];
                }
                // Silently ignoring if the provided GUID is invalid
                next();
                return;
            });
        },

        /*
         * We cannot transition a recovery configuration unless it has
         * reached the required state across the whole set of CN's using EDAR.
         * This means we need to count PIVTokens and make sure we have the
         * same number of targets for our transition, unless we're using
         * the `--force` option and we're trying to activate a single CN for
         * testing purposes.
         */
        function countPIVTokens(ctx, next) {
            model.count({
                moray: opts.moray,
                bucket: mod_pivtoken.bucket().name,
                filter: '(guid=*)'
            }, function (err, count) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.pivtokensCount = count;
                // Note we don't care if no targets are given, since we'll
                // fetch all the PIVTokens in such case
                const transitionPIVTokensSubSet = ctx.targets &&
                    ctx.targets.length &&
                    ctx.targets.length !== ctx.pivtokensCount;
                if (transitionPIVTokensSubSet &&
                    (action !== 'activate' || !opts.params.force)) {
                    var msg = format('Cannot %s a RecoveryConfiguration for ' +
                            'a subset of PIVTokens %s ', action,
                            getRecCfgState(ctx.recoveryConfiguration));
                    if (action === 'activate') {
                        msg += 'unless `--force` option is specified';
                    }
                    next(new errors.InvalidParamsError(
                        'Invalid \'targets\' parameter', [new VError(msg)]
                    ));
                    return;
                }
                next();
            });
        },
        function countStagedRecoveryTokens(ctx, next) {
            if (action !== 'activate') {
                next();
                return;
            }
            model.count({
                moray: opts.moray,
                bucket: mod_recovery_token.bucket().name,
                filter: format(
                    '(&(recovery_configuration=%s)(staged=*))',
                    ctx.recoveryConfiguration.key())
            }, function (err, count) {
                if (err) {
                    next(err);
                    return;
                }

                if (count < ctx.pivtokensCount) {
                    opts.log.debug({
                        pivtokens: ctx.pivtokensCount,
                        staged_recovery_tokens: count,
                        force: opts.params.force
                    }, 'Unstaged recovery tokens');

                    if (!opts.params.force) {
                        next(new errors.InvalidParamsError('Missing parameter',
                            [new VError('There are %d recovery tokens which ' +
                            'need to be staged before the recovery ' +
                            'configuration can be activated, unless the ' +
                            '--force option is specified.',
                            ctx.pivtokensCount - count)]));
                        return;
                    }
                }
                next();
            });
        },
        function checkValidTransition(ctx, next) {
            const state = getRecCfgState(ctx.recoveryConfiguration);
            const validTrs = RECOVERY_CONFIGURATION_STATIC_STATES[state]
                .validTransitions;
            if (action !== 'cancel' && validTrs.indexOf(action) === -1) {
                next(new errors.InvalidParamsError(
                    'Invalid action=\'' + action + '\' parameter',
                    [new VError(
                    'Cannot \'%s\' a RecoveryConfiguration on state \'%s\'',
                    action, state)]
                ));
                return;
            }
            next();
        },
        /*
         * It's perfectly possible to have more than one transition of the same
         * type when picking up batches of different CNs to activate.
         * What is not possible is to have more than one of these transitions
         * which is not finished.
         * This simplifies the rules of which targets can be scheduled to
         * transition each time without having giving any room for the same
         * transition to run twice at once for the same CN.
         */
        function getTransitions(ctx, next) {
            const filter = (action === 'cancel') ?
                format(
                    '(&(name=*)(recovery_config_uuid=%s)' +
                    '(!(aborted=true))(!(finished=*)))',
                    ctx.recoveryConfiguration.key()) :
                format(
                    '(&(name=%s)(recovery_config_uuid=%s)' +
                    '(!(aborted=true))(!(finished=*)))',
                    action, ctx.recoveryConfiguration.key());

            mod_rec_cfg_tr.ls({
                moray: opts.moray,
                log: opts.log,
                params: {
                    filter: filter
                }
            }, function lsCb(lsErr, lsItems) {
                if (lsErr) {
                    next(lsErr);
                    return;
                }
                if (lsItems.length) {
                    ctx.transitioning = true;
                }

                if (!lsItems.length && action === 'cancel') {
                    next(new errors.InvalidParamsError(
                        'Invalid action=\'cancel\' parameter',
                        [new VError('There are no transitions to be canceled ' +
                            'for recovery configuration %s',
                            ctx.recoveryConfiguration.key())]));
                    return;
                }

                ctx.transitions = lsItems;
                next();
            });
        },
        function getAllTargets(ctx, next) {
            if (ctx.targets || ctx.transitioning) {
                next();
                return;
            }
            model.list({
                moray: opts.moray,
                log: opts.log,
                bucket: mod_pivtoken.bucket(),
                params: { filter: '(guid=*)' },
                validFields: ['guid', 'cn_uuid'],
                model: mod_pivtoken.PIVToken
            }, function (err, pivtokens) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.targets = pivtokens.map(function getGuid(p) {
                    return p.params.cn_uuid;
                });
                next();
            });
        },
        /*
         * We can skip this for 'reactivate' and 'expire'
         */
        function createTransition(ctx, next) {
            if (ctx.transitioning ||
                action === 'reactivate' ||
                action === 'expire' ||
                // This should not be reached but in case we tried to cancel
                // something already finished. Still, we don't want to create
                // anything on such case.
                action === 'cancel'
            ) {
                next();
                return;
            }
            const params = {
                recovery_config_uuid: ctx.recoveryConfiguration.key(),
                name: action,
                uuid: UUID.v4(),
                targets: ctx.targets,
                standalone: ctx.standalone,
                forced: ctx.force
            };
            // In case we have no targets the transition is already completed:
            if (!ctx.targets.length) {
                params.started = new Date().toISOString();
                params.finished = new Date().toISOString();
            }

            mod_rec_cfg_tr.create({
                moray: opts.moray,
                params: params
            }, function createTr(trErr, trObj) {
                if (trErr) {
                    next(trErr);
                    return;
                }
                ctx.transitions = [trObj];
                next();
            });
        },
        function updateCfgWhenThereAreNoTargets(ctx, next) {
            if (ctx.transitioning ||
                action === 'reactivate' ||
                action === 'expire' ||
                action === 'cancel' ||
                ctx.targets.length
            ) {
                next();
                return;
            }

            const params = {};
            if (action === 'stage') {
                params.staged = new Date().toISOString();
            } else {
                params.activated = new Date().toISOString();
            }

            mod_recovery_configuration.update({
                moray: opts.moray,
                key: ctx.recoveryConfiguration.key(),
                val: params
            }, function (upErr, _recCfg) {
                if (upErr) {
                    next(upErr);
                    return;
                }
                next();
            });
        },
        /*
         * In case we're calling 'reactivate', we need to cleanup
         * some of the associated transitions, so we don't have dupes
         */
        function removeTransitions(ctx, next) {
            if (action !== 'reactivate') {
                next();
                return;
            }

            mod_recovery_token.ls({
                moray: opts.moray,
                log: opts.log,
                params: {
                    filter: format('(recovery_configuration=%s)',
                    ctx.recoveryConfiguration.key())
                }
            }, function tkCb(tkErr, tkItems) {
                if (tkErr) {
                    next(tkErr);
                    return;
                }

                var newCfg = ctx.recoveryConfiguration.raw();
                delete newCfg.staged;
                delete newCfg.activated;
                delete newCfg.expired;

                var requests = [{
                    bucket: mod_recovery_configuration.bucket().name,
                    operation: 'put',
                    key: ctx.recoveryConfiguration.key(),
                    options: {
                        etag: ctx.recoveryConfiguration.etag
                    },
                    value: newCfg
                }, {
                    bucket: mod_rec_cfg_tr.bucket().name,
                    operation: 'deleteMany',
                    filter: format('(recovery_config_uuid=%s)',
                        ctx.recoveryConfiguration.key())
                }];

                tkItems.forEach(function putTk(t) {
                    var val = t.raw();
                    delete val.expired;
                    delete val.activated;
                    delete val.staged;

                    requests.push({
                        bucket: mod_recovery_token.bucket().name,
                        operation: 'put',
                        key: t.params.uuid,
                        value: val
                    });
                });

                opts.moray.batch(requests,
                    function batchCb(batchErr, batchMeta) {
                    if (batchErr) {
                        next(batchErr);
                        return;
                    }
                    opts.log.debug(batchMeta, 'moray.batch metadata');
                    next();
                });
            });
        },
        /*
         * Both 'reactivate' and 'expire' will result in straight
         * modifications of the recovery config record, while these
         * modifications will happen during recCfgTransition execution
         * for the other possible actions.
         */
        function upConfig(ctx, next) {
            if (action !== 'expire') {
                next();
                return;
            }

            var newCfg = ctx.recoveryConfiguration.raw();
            const expired = new Date().toISOString();
            newCfg.expired = expired;
            opts.moray.batch([{
                bucket: mod_recovery_configuration.bucket().name,
                operation: 'put',
                key: ctx.recoveryConfiguration.key(),
                value: newCfg
            }, {
                bucket: mod_recovery_token.bucket().name,
                operation: 'update',
                filter: format('(&(recovery_configuration=%s)(!(expired=*)))',
                    ctx.recoveryConfiguration.key()),
                fields: {
                    expired: expired
                }
            }], function batchCb(batchErr, batchMeta) {
                if (batchErr) {
                    next(batchErr);
                    return;
                }
                opts.log.debug(batchMeta, 'moray.batch update metadata');
                ctx.recoveryConfiguration.params.expired = expired;
                next();
            });
        },
        /*
         * In case we're trying to cancel something, we need to have a WIP
         * transition to cancel. Otherwise, we can also return no error.
         */
        function cancelTransition(ctx, next) {
            if (action !== 'cancel' || !ctx.transitioning) {
                next();
                return;
            }
            mod_rec_cfg_tr.update({
                moray: opts.moray,
                key: ctx.transitions[0].key(),
                val: { aborted: true }
            }, function upCb(upErr, upRes) {
                if (upErr) {
                    next(upErr);
                    return;
                }
                ctx.transitions[0] = upRes;
                next();
            });
        }
    ]}, function pipeCb(pipeErr, _pipeRes) {
        if (pipeErr) {
            cb(pipeErr);
            return;
        }
        if (context.transitioning && action !== 'cancel') {
            cb(new errors.InvalidParamsError('Transition already exists', [
                new VError('There is a transition for this recovery ' +
                    'configuration which has not been finished yet')
            ]), {
                recoveryConfiguration: context.recoveryConfiguration,
                transition: context.transitions[0] || null
            });
            return;
        }
        cb(null, {
            recoveryConfiguration: context.recoveryConfiguration,
            transition: context.transitions[0] || null
        });
    });
}

module.exports = transition;
// vim: set softtabstop=4 shiftwidth=4:
