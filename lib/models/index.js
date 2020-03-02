/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Handles initializing all models and methods involving more than one model.
 */

'use strict';
const assert = require('assert-plus');
const util = require('util');
const vasync = require('vasync');

const mod_model = require('./model');
const mod_pivtoken = require('./pivtoken');
const mod_pivtoken_history = require('./pivtoken-history');
const mod_recovery_token = require('./recovery-token');
const mod_recovery_configuration = require('./recovery-configuration');
const mod_recovery_configuration_transition =
    require('./recovery-configuration-transition');
const mod_fsm_transition = require('./fsm-transition');

function initializeModels(app, callback) {
    vasync.forEachParallel({
        inputs: [
            mod_pivtoken,
            mod_pivtoken_history,
            mod_recovery_token,
            mod_recovery_configuration,
            mod_recovery_configuration_transition
        ],
        func: function _initModel(mod, cb) {
            mod.init(app.moray, cb);
        }
    }, callback);
}


function expireUnusedRecoveryConfigs(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    opts.params = {};

    const context = {
        recoveryConfigs: []
    };
    vasync.pipeline({
        funcs: [
            function lsConfigs(ctx, nextFunc) {
                mod_recovery_configuration.ls(Object.assign({}, opts, {
                    filter: '(&(activated=*)(!(expired=*)) )'
                }), function lsCb(lsErr, lsItems) {
                    if (lsErr) {
                        nextFunc(lsErr);
                        return;
                    }
                    if (lsItems.length) {
                        ctx.recoveryConfigs = lsItems;
                    }
                    nextFunc();
                });
            },
            function lsConfigTokens(ctx, nextFunc) {
                if (!ctx.recoveryConfigs.length) {
                    nextFunc();
                    return;
                }

                vasync.forEachParallel({
                    inputs: ctx.recoveryConfigs,
                    func: function fetchTokens(arg, next) {
                        mod_recovery_token.ls({
                            moray: opts.moray,
                            log: opts.log,
                            params: Object.assign({}, opts.params, {
                                filter: util.format(
                                    '(recovery_configuration=%s)',
                                    arg.params.uuid)
                            })
                        }, function lsCb(listErr, tokens) {
                            if (listErr) {
                                next(listErr);
                                return;
                            }
                            arg.tokens = tokens;
                            next();
                        });
                    }
                }, function paraCb(paraErr) {
                    if (paraErr) {
                        opts.log.error({
                            err: paraErr
                        }, 'List recovery configuration tokens error');
                        nextFunc(paraErr);
                        return;
                    }
                    nextFunc();
                });
            },
            function filterEmptyConfigs(ctx, nextFunc) {
                if (!ctx.recoveryConfigs.length) {
                    nextFunc();
                    return;
                }

                ctx.recoveryConfigs = ctx.recoveryConfigs.filter(
                    function filterCfg(cfg) {
                    cfg.expired_tokens = 0;
                    if (cfg.tokens && cfg.tokens.length) {
                        cfg.expired_tokens = cfg.tokens.filter(
                            function filterTk(tk) {
                            return (tk.params.expired !== undefined);
                        }).length;
                    }

                    return (cfg.tokens && cfg.tokens.length &&
                        (cfg.expired_tokens === cfg.tokens.length));
                });
                nextFunc();
            },
            function expireEmptyConfigs(ctx, nextFunc) {
                if (!ctx.recoveryConfigs.length) {
                    nextFunc();
                    return;
                }
                const requests = [];
                const expired = new Date().toISOString();
                ctx.recoveryConfigs.forEach(function addReq(cfg) {
                    cfg.params.expired = expired;
                    requests.push({
                        bucket: mod_recovery_configuration.bucket().name,
                        operation: 'put',
                        key: cfg.params.uuid,
                        value: cfg.raw()
                    });
                });
                opts.moray.batch(requests,
                    function batchCb(batchErr, batchMeta) {
                    opts.log.debug({
                        requests: requests,
                        batchErr: batchErr,
                        batchMeta: batchMeta
                    }, 'expireEmptyConfigs batch');

                    if (batchErr) {
                        opts.log.error({
                            error: batchErr,
                            configs: ctx.recoveryConfigs
                        }, 'Error expiring unused recovery configs');
                    }
                    nextFunc(batchErr, batchMeta);
                });
            }
        ], arg: context
    }, function pipeCb(pipeErr) {
        if (pipeErr) {
            cb(pipeErr);
            return;
        }
        cb(null, context.recoveryConfigs);
    });
}

module.exports = {
    init: initializeModels,
    pivtoken: mod_pivtoken,
    pivtoken_history: mod_pivtoken_history,
    recovery_configuration: mod_recovery_configuration,
    recovery_configuration_transition: mod_recovery_configuration_transition,
    recovery_token: mod_recovery_token,
    fsm_transition: mod_fsm_transition,
    model: mod_model,
    uuid: mod_model.uuid,
    expireUnusedRecoveryConfigs: expireUnusedRecoveryConfigs
};
// vim: set softtabstop=4 shiftwidth=4:
