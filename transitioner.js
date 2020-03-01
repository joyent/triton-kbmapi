/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */
'use strict';

/*
 * KBMAPI service for periodically running recovery configurations transitions.
 *
 * - Connect to moray (dependency on kbmapi main service so we don't have a
 *   race trying to init the same buckets twice).
 * - Connect to CNAPI.
 * - Search for "queued" transitions. (Or "running", since the process may
 *   have been exited abnormally) and "RUN" them.
 * - In case there are no more "queued" transitions the process can do nothing
 *   and wait for a SIGHUP in order to perform a new search for queued
 *   transitions, or we could just exit it and boot the whole transitioner
 *   service again when needed (which may be a good fit, since we're not gonna
 *   transition recovery configurations daily).
 *
 *   "RUN" a transition means:
 *   - "Lock it" to our process (likely using zone uuid)
 *   - Check the type of transition. We're interested only in "stage" and
 *     "activate" for a first pass.
 *   - In case we have an "stage" transition, grab the recovery
 *     configuration template we want to spread across all the transition
 *     targets.
 *   - Create a cn-agent task for each one of the targets, with the given
 *     concurrency, awaiting for completion of the first batch of CNs before
 *     re-checking the recovery configuration transition for cancelation
 *     attempts. Save the tasksids into the transition backend. Save the
 *     uuids of the cns where the tasks are being executed as WIP.
 *   - Poll for tasks completion. Once a task is complete add the cn UUID
 *     to transition's completed member.
 *   - Check if the transition has been canceled and in such case finish it
 *     without moving into next batch.
 *   - Do the same until we have completed the whole set in batches of
 *     the given concurrency.
 *   - If the action is "activate" we also need to "expire" the previously
 *     active recovery configuration on completion, (and all the associated
 *     PIVTokens).
 *
 * Additionally, this service will also remove pivtoken-history records older
 * than KBMAPI_HISTORY_DURATION setting.
 *
 */

const EventEmitter = require('events');
const util = require('util');

const assert = require('assert-plus');
const bunyan = require('bunyan');
const jsprim = require('jsprim');
const moray = require('moray');
const restify = require('restify');
const vasync = require('vasync');
const VError = require('verror');
const CNAPI = require('sdc-clients').CNAPI;

const mod_apis_moray = require('./lib/apis/moray');
const models = require('./lib/models');

var log = bunyan.createLogger({
    name: 'kbmapi-transitioner',
    level: 'debug',
    serializers: restify.bunyan.serializers
});

const USAGE_PERIOD = 8 * 60 * 60 * 1000; // 8 hours
const CNAPI_WAIT_TASK_TIMEOUT = 60 * 5000;

function periodicUsageLog(alog) {
    alog.info({ memory: process.memoryUsage() },
        'Current memory usage');
}

function KbmApiTransitioner(opts) {
    this.log = opts.log;
    this.config = opts.config;
    this.cnapi = opts.cnapi || null;
    this.moray = opts.moray || null;

    if (opts.config && opts.config.testBucketPrefix) {
        mod_apis_moray.setTestPrefix(
            opts.config.testBucketPrefix.replace(/-/g, '_'));
    }

    EventEmitter.call(this);
}

util.inherits(KbmApiTransitioner, EventEmitter);

/**
 * Starts the transitioner service
 */
KbmApiTransitioner.prototype.start = function start() {
    const self = this;

    var context = {
        log: this.log,
        config: this.config
    };

    vasync.pipeline({
        arg: context,
        funcs: [
            function initMemlogger(ctx, next) {
                ctx.log.info({ period: USAGE_PERIOD },
                    'Starting periodic logging of memory usage');
                self.usageTimer = setInterval(periodicUsageLog,
                    USAGE_PERIOD, ctx.log);
                next();
            },

            function initMoray(ctx, next) {
                if (self.moray) {
                    next();
                    return;
                }

                var conf = jsprim.deepCopy(self.config.moray);

                ctx.log.debug(conf, 'Creating moray client');

                conf.log = ctx.log.child({
                    component: 'moray',
                    level: self.config.moray.logLevel || 'info'
                });

                self.moray = moray.createClient(conf);

                self.moray.once('connect', function onMorayConnect() {
                    ctx.log.info('moray: connected');
                    next();
                });

                self.moray.once('error', function onMorayError(err) {
                    self.initErr = new VError(err, 'moray: connection failed');
                    next(err);
                });
            },

            function initCnapi(ctx, next) {
                if (self.cnapi) {
                    next();
                    return;
                }
                var conf = jsprim.deepCopy(self.config.cnapi);
                ctx.log.debug(conf, 'Creating CNAPI client');

                conf.log = self.log.child({
                    component: 'cnapi',
                    level: ctx.config.logLevel || 'info'
                });

                self.cnapi = new CNAPI(conf);
                next();
            }

        ]
    }, function initDone(initErr) {
        if (!initErr) {
            self.emit('initialized');
        } else {
            self.stop(function () {
                throw initErr;
            });
        }
    });
};

/**
 * Stops the transitioner service
 */
KbmApiTransitioner.prototype.stop = function (callback) {
    var self = this;

    if (self.moray) {
        self.moray.close();
    }

    if (self.usageTimer) {
        clearInterval(self.usageTimer);
        self.usageTimer = null;
    }

    if (self.runTimeout) {
        clearTimeout(self.runTimeout);
        self.runTimeout = null;
    }

    if (self.pruneTimeout) {
        clearTimeout(self.pruneTimeout);
        self.pruneTimeout = null;
    }

    if (self.cnapi) {
        self.cnapi.close();
    }

    /* eslint-disable callback-return */
    if (callback) {
        callback();
    }
    /* eslint-enable callback-return */
};

KbmApiTransitioner.prototype.prune = function prune() {
    var self = this;
    function pruneHist() {
        self.pruneTimeout = null;

        // config.historyDuration is defined in seconds
        const durationMs = self.config.historyDuration * 1000;
        const dateLimit = new Date(Date.now() - durationMs).toISOString();

        const opts = {
            moray: self.moray,
            log: self.log
        };
        opts.filter = util.format('(active_range:overlaps:=[,%s])', dateLimit);
        // Delete from pivtoken-history:
        models.pivtoken_history.delMany(opts, function delCb(err) {
            if (err) {
                self.log.error({
                    err: err,
                    filter: opts.filter
                }, 'Error removing pivtoken history records');
            }

            self.log.debug({
                history_filter: opts.filter
            }, 'Prune run.');

            // We'll delete old recovery tokens too:
            opts.filter = util.format('(expired<=%s)', dateLimit);
            models.recovery_token.delMany(opts, function deCb(dErr) {
                if (dErr) {
                    self.log.error({
                        err: dErr,
                        filter: opts.filter
                    }, 'Error recovery token expired records');
                }

                self.pruneTimeout = setTimeout(pruneHist,
                    self.config.pollInterval * 1000);
            });
        });
    }
    pruneHist();
};

KbmApiTransitioner.prototype.run = function run() {
    var self = this;

    function runTransition() {
        if (self.runTimeout) {
            clearTimeout(self.runTimeout);
            self.runTimeout = null;
        }
        self.runTransition(function runTrCb(runTrErr, moreTrs) {
            if (runTrErr) {
                self.log.error({err: runTrErr}, 'Run transition error');
                if (self.currTr) {
                    models.recovery_configuration_transition.update({
                        moray: self.moray,
                        log: self.log,
                        key: self.currTr.key(),
                        val: {
                            aborted: true,
                            finished: new Date().toISOString()
                        }
                    }, function upCb(upErr) {
                        self.currTr = null;
                        if (upErr) {
                            self.log.error({err: upErr},
                                'Abort transition error');
                        }
                        self.runTimeout =
                            setTimeout(runTransition,
                                self.config.pollInterval * 1000);
                    });
                }
                return;
            }
            if (moreTrs) {
                runTransition();
                return;
            }
            self.runTimeout =
                setTimeout(runTransition, self.config.pollInterval * 1000);
        });
    }
    runTransition();
};

KbmApiTransitioner.prototype.runTransition = function runTransition(cb) {
    var self = this;
    var context = {};
    vasync.pipeline({
        arg: context,
        funcs: [
            function getPendingTransitions(ctx, next) {
                models.recovery_configuration_transition.ls({
                    moray: self.moray,
                    log: self.log,
                    params: {
                        filter: '(&(!(finished=*))(!(aborted=*)))'
                    }
                }, function lsCb(lsErr, lsItems) {
                    if (lsErr) {
                        next(lsErr);
                        return;
                    }
                    if (!lsItems.length) {
                        next(new VError({
                            name: 'NotFoundError',
                            info: {
                                'errno': 'ENOTFOUND'
                            }
                        }, 'No pending transitions found'));
                        return;
                    }
                    self.currTr = ctx.currTr = lsItems.shift();
                    ctx.pendingTrs = lsItems;
                    self.log.debug({
                        current_transition: ctx.currTr,
                        pending_transitions: ctx.pendingTrs
                    }, 'getPendingTransitions');
                    next();
                });
            },
            // If we picked an aborted but not yet finished transition we
            // should finish now and move forward:
            function finishAbortedTransition(ctx, next) {
                if (!ctx.currTr.aborted) {
                    next();
                    return;
                }

                self.log.debug({
                    transition: ctx.currTr
                }, 'Finishing aborted transition');

                models.recovery_configuration_transition.update({
                    moray: self.moray,
                    key: ctx.currTr.key(),
                    value: {
                        finished: new Date().toISOString()
                    },
                    etag: ctx.currTr.etag
                }, function upCb(upErr, upRes) {
                    if (upErr) {
                        next(upErr);
                        return;
                    }

                    self.log.debug({
                        transition: upRes
                    }, 'Canceled transition finished');

                    next(VError({
                        name: 'AlreadyDoneError',
                        info: {
                            'errno': 'ERRDONE'
                        }
                    }, 'Transition finished'));
                });
            },

            // - Get PIVTokens for the current tr pending targets
            // - Remove from pending targets those with recovery tokens in
            //   a transition state like the one requested for the currTr
            //
            function getPendingTargetsPIVTokens(ctx, next) {
                var params = ctx.currTr.params;
                params.completed = params.completed || [];
                ctx.pendingTargets = params.targets.filter(
                    function alreadyDone(item) {
                        return params.completed.indexOf(item) === -1;
                    });

                if (!ctx.pendingTargets.length) {
                    next();
                    return;
                }

                models.pivtoken.lsByCn({
                    moray: self.moray,
                    log: self.log,
                    cn_uuids: ctx.pendingTargets
                }, function lsCb(lsErr, lsPivtokens) {
                    if (lsErr) {
                        next(lsErr);
                        return;
                    }
                    ctx.targetPIVTokens = lsPivtokens;
                    ctx.pivtokensByCnUuid = {};
                    lsPivtokens.forEach(function (piv) {
                        ctx.pivtokensByCnUuid[piv.params.cn_uuid] = piv;
                    });

                    next();
                });
            },
            // Note that if the action is "stage" it would be expected
            // to not have any RecoveryTokens associated with the
            // current recovery configuration. Otherwise, we should have
            // such RecoveryTokens and would need to check at their props.
            function getPendingTargetsRecoveryTokens(ctx, next) {
                if (!ctx.pendingTargets.length) {
                    next();
                    return;
                }

                const filter = util.format('(&(recovery_configuration=%s)(|',
                    ctx.currTr.params.recovery_config_uuid) +
                    ctx.targetPIVTokens.map(function (p) {
                        return util.format('(pivtoken=%s)', p.guid);
                    }).join('') + '))';

                models.recovery_token.ls({
                    moray: self.moray,
                    log: self.log,
                    params: {
                        filter: filter
                    }
                }, function lsCb(lsErr, lsTokens) {
                    if (lsErr) {
                        next(lsErr);
                        return;
                    }
                    ctx.targetRecoveryTokens = lsTokens;
                    ctx.recTokensByGuid = {};
                    lsTokens.forEach(function (tk) {
                        ctx.recTokensByGuid[tk.params.pivtoken] = tk;
                    });

                    self.log.debug({
                        filter: filter,
                        recovery_tokens: ctx.recTokensByGuid
                    }, 'getPendingTargetsRecoveryTokens');

                    next();
                });
            },

            function createRecoveryTokens(ctx, next) {
                if (ctx.targetRecoveryTokens &&
                    ctx.targetRecoveryTokens.length ===
                    ctx.pendingTargets.length) {
                    next();
                    return;
                }

                const pivtokensGuids = ctx.targetPIVTokens.map(function (p) {
                    return p.guid;
                });

                const existingGuids = Object.keys(ctx.recTokensByGuid);

                const missingGuids = pivtokensGuids.filter(function (id) {
                    return existingGuids.indexOf(id) === -1;
                });

                if (!ctx.targetRecoveryTokens) {
                    ctx.targetRecoveryTokens = [];
                }

                vasync.forEachParallel({
                    inputs: missingGuids,
                    func: function createMissingToken(id, nextToken) {
                        models.recovery_token.create({
                            moray: self.moray,
                            params: {
                                pivtoken: id,
                                recovery_configuration:
                                    ctx.currTr.params.recovery_config_uuid
                            }
                        }, function createCb(createErr, createRes) {
                            if (createErr) {
                                next(createErr);
                                return;
                            }
                            ctx.recTokensByGuid[id] = createRes;
                            ctx.targetRecoveryTokens.push(createRes);
                            nextToken();
                        });
                    }
                }, function paraCb(paraErr, _paraRes) {
                    if (paraErr) {
                        next(paraErr);
                        return;
                    }

                    self.log.debug({
                        recovery_tokens: ctx.recTokensByGuid
                    }, 'createRecoveryTokens');
                    next();
                });
            },

            function getRecoveryConfiguration(ctx, next) {
                models.recovery_configuration.get({
                    moray: self.moray,
                    params: {
                        uuid: ctx.currTr.params.recovery_config_uuid
                    }
                }, function getCb(getErr, recCfg) {
                    if (getErr) {
                        next(getErr);
                        return;
                    }
                    ctx.recoveryConfig = recCfg;
                    self.log.debug({
                        recovery_configuration: recCfg
                    }, 'getRecoveryConfiguration');
                    next();
                });
            },

            // It's possible to have a successful transition for a recovery
            // token while the transitioner service is down and, therefore,
            // unable to update the recovery configuration transition object.
            // Just make sure we're not expending extra http requests to CNAPI
            // on such cases.
            function skipAlreadyTransitionedTokens(ctx, next) {
                const trAction = ctx.currTr.name;
                const alreadyDoneRecTokens = ctx.targetRecoveryTokens.filter(
                    function filterTokens(tk) {
                    var done = false;
                    switch (trAction) {
                        case 'stage':
                            done = tk.staged || false;
                            break;
                        case 'activate':
                            done = tk.staged && tk.activated;
                            break;
                        case 'deactivate':
                            done = tk.staged && !tk.activated;
                            break;
                        default:
                            done = !tk.staged;
                            break;
                    }
                    return done;
                }).map(function toPivtoken(tk) {
                    return tk.pivtoken;
                });

                const doneTargets = ctx.targetPIVTokens.filter(
                    function filterPivtokens(p) {
                    return alreadyDoneRecTokens.indexOf(p.guid) !== -1;
                }).map(function pivtokenToCN(p) {
                    return p.cn_uuid;
                });

                ctx.pendingTargets = ctx.pendingTargets.filter(
                    function doneTr(cn) {
                    return doneTargets.indexOf(cn) === -1;
                });

                self.log.debug({
                    done_tokens: alreadyDoneRecTokens,
                    done_targets: doneTargets
                }, 'Already done tokens');

                next();
            },

            function lockBeforeRun(ctx, next) {
                var params = ctx.currTr.params;
                // If we already have WIP CNs we need to check for completion,
                // otherwise we need to begin transitioning a new batch of CNs.
                // Also, when we need to lock the transition so no other
                // locker attempts to run it.
                var val = {
                    locked_by: self.config.instanceUuid
                };

                if (!params.started) {
                    val.started = new Date().toISOString();
                }

                if (!ctx.pendingTargets.length) {
                    val.finished = new Date().toISOString();
                }

                models.recovery_configuration_transition.update({
                    moray: self.moray,
                    key: ctx.currTr.key(),
                    val: val,
                    etag: ctx.currTr.etag
                }, function upCb(upErr, upTr) {
                    if (upErr) {
                        next(upErr);
                        return;
                    }

                    self.log.debug({
                        val: val,
                        updated_transition: upTr,
                        pending: ctx.pendingTargets
                    }, 'lockBeforeRun');

                    // Refresh ETAG:
                    ctx.currTr = upTr;
                    if (!ctx.pendingTargets.length) {
                        next(VError({
                            name: 'AlreadyDoneError',
                            info: {
                                'errno': 'ERRDONE'
                            }
                        }, 'Transition finished'));
                        return;
                    }
                    next();
                });
            },
            // Now, we need to repeat this in bacthes of ctx.currTr.concurrency
            // items as many times as needed to process every item into
            // ctx.pendingTargets, including an update of ctx.currTr record
            // every time we're done with a batch.
            function processPendingTargets(ctx, next) {
                var errs = ctx.currTr.params.errs || [];
                // Cleanup empty (`{}`) values from this list:
                if (errs.length) {
                    errs = errs.filter(function dropEmptyObjects(anErr) {
                        return (Object.keys(anErr).length !== 0);
                    });
                }
                var tasks = ctx.currTr.params.taskids || [];
                // Function to process a batch of N items
                function doBatch(items, nextBatch) {
                    self.log.debug({
                        cns: items
                    }, 'doBatch');
                    vasync.forEachParallel({
                        inputs: items,
                        // Function to process one of the items (CN)
                        // including task creation and waiting for
                        // completion. We assume that the cn-agent
                        // task will be in charge to update the
                        // recovery token (b/c it should also do when the
                        // cn-agent reboots and verifies changes against
                        // the expected recovery configuration in KBMAPI).
                        func: function doTask(item, nextTask) {
                            self.log.debug({
                                cn_uuid: item
                            }, 'doTask begin');
                            vasync.pipeline({arg: {
                                cn_uuid: item
                            }, funcs: [
                                function createTask(arg, nextStep) {
                                    const pivGuid = ctx.pivtokensByCnUuid[item]
                                        .guid;
                                    const trParams = {
                                        action: ctx.currTr.params.name,
                                        pivtoken: pivGuid,
                                        recovery_uuid:
                                            ctx.recoveryConfig.params.uuid,
                                        template:
                                            ctx.recoveryConfig.params.template,
                                        token:
                                            ctx.recTokensByGuid[pivGuid].params
                                                .token
                                    };
                                    self.log.debug({
                                        tr_params: trParams
                                    }, 'CNAPI Task params');

                                    // We may want to add a proper method to
                                    // CNAPI client in the future:
                                    const rPath = util.format(
                                        '/servers/%s/recovery-config', item);
                                    self.cnapi.post(rPath, trParams,
                                        function taskCb(taskErr, task) {
                                            if (taskErr) {
                                                self.log.error({
                                                    err: taskErr,
                                                    path: rPath,
                                                    params: trParams
                                                }, 'Error creating Task');
                                                nextStep(taskErr);
                                                return;
                                            }

                                            arg.taskid = task.id;
                                            tasks.push(task.id);
                                            self.log.debug({
                                                cn_uuid: arg.item,
                                                taskid: arg.taskid
                                            }, 'doTask create task');
                                            nextStep();
                                        });
                                },
                                function waitForTask(arg, nextStep) {
                                    self.cnapi.waitTask(arg.taskid, {
                                        timeout: CNAPI_WAIT_TASK_TIMEOUT
                                    }, function checkTask(taskErr, task) {
                                        if (taskErr) {
                                            nextStep(taskErr);
                                            return;
                                        }
                                        if (task.status !== 'complete') {
                                            nextStep(new Error(
                                                'Unexpected task status: ' +
                                                task.status));
                                            return;
                                        }
                                        nextStep();
                                    });
                                }
                            ]}, function taskCb(taskErr) {
                                if (taskErr) {
                                    errs.push(taskErr);
                                }
                                nextTask();
                            });
                        }
                    }, function batchCb(batchErr) {
                        if (batchErr) {
                            self.log.error({
                                err: batchErr
                            }, 'Unexpected batch error');
                        }
                        var val = {
                            taskids: tasks,
                            completed: (ctx.currTr.params.completed || [])
                            .concat(items),
                            errs: errs
                        };

                        self.log.debug({
                            val: val
                        }, 'doBatch batchCb');

                        models.recovery_configuration_transition.update({
                            moray: self.moray,
                            key: ctx.currTr.key(),
                            val: val
                        }, function upCb(upErr, upTr) {
                            if (upErr) {
                                nextBatch(upErr);
                                return;
                            }

                            self.log.debug({
                                val: val,
                                updated_transition: upTr,
                                pending: ctx.pendingTargets
                            }, 'doBatch');

                            if (upTr.params.aborted) {
                                nextBatch(VError({
                                    name: 'AlreadyDoneError',
                                    info: {
                                        'errno': 'ERRDONE'
                                    }
                                }, 'Transition finished'));
                                return;
                            }
                            // Refresh ETAG:
                            ctx.currTr = upTr;
                            nextBatch();
                        });
                    });
                }

                assert.ok(ctx.currTr.params.concurrency, 'concurrency');
                const concurrency = ctx.currTr.params.concurrency;
                var batches = [];
                var i;
                var pending = ctx.pendingTargets;

                for (i = 0; i < pending.length; i += concurrency) {
                    batches.push(pending.slice(i, i + concurrency));
                }

                vasync.forEachPipeline({inputs: batches, func: doBatch}, next);
            },

            function completeTransition(ctx, next) {
                var val = {
                    finished: new Date().toISOString()
                };
                models.recovery_configuration_transition.update({
                    moray: self.moray,
                    key: ctx.currTr.key(),
                    val: val
                }, function upCb(upErr, upTr) {
                    if (upErr) {
                        next(upErr);
                        return;
                    }
                    ctx.currTr = upTr;
                    next();
                });
            },

            function changeRecoveryConfigurationState(ctx, next) {
                if (ctx.currTr.params.standalone) {
                    next();
                    return;
                }
                var trErrs = ctx.currTr.params.errs;
                // Do not change recovery configuration state if we had errors:
                if (trErrs && trErrs.length) {
                    trErrs = trErrs.filter(function dropEmptyObjects(anErr) {
                        return (Object.keys(anErr).length !== 0);
                    });
                    if (trErrs.length) {
                        self.log.info({
                            errors: trErrs
                        }, 'not modifying recovery configuration state' +
                            'due to existing errors');
                        next();
                        return;
                    }
                }

                var val = {};
                var del = false;

                switch (ctx.currTr.params.name) {
                    case 'stage':
                        val.staged = new Date().toISOString();
                        break;
                    case 'activate':
                        val.activated = new Date().toISOString();
                        break;
                    case 'deactivate':
                        val.activated = new Date().toISOString();
                        del = true;
                        break;
                    default:
                        val.staged = new Date().toISOString();
                        del = true;
                        break;
                }
                models.recovery_configuration.update({
                    moray: self.moray,
                    key: ctx.recoveryConfig.key(),
                    val: val,
                    remove: del
                }, function upCb(upErr, _upTr) {
                    if (upErr) {
                        next(upErr);
                        return;
                    }
                    next();
                });
            },

            function expireUnusedRecoveryConfigs(_ctx, next) {
                models.expireUnusedRecoveryConfigs({
                    moray: self.moray,
                    log: self.log
                }, next);
            }
        ]
    }, function pipeCb(pipeErr, pipeRes) {
        self.log.trace({pipelineResults: pipeRes}, 'Pipeline results');

        if (pipeErr) {
            if (VError.hasCauseWithName(pipeErr, 'NotFoundError') ||
                VError.hasCauseWithName(pipeErr, 'AlreadyDoneError')) {
                cb(null, context.pendingTrs || null);
                return;
            }
            cb(pipeErr);
            return;
        }
        cb(null, context.pendingTrs);
    });
};

function exitOnError(err) {
    if (err) {
        var errs = err.hasOwnProperty('ase_errors') ? err.ase_errors : [err];
        for (var e in errs) {
            log.error(errs[e]);
        }
        process.exit(1);
    }
}

if (require.main === module) {
    try {
        const mod_config = require('./lib/config');
        const config = mod_config.load(__dirname + '/config.json');
        var transitioner = new KbmApiTransitioner({
            config: config,
            log: log
        });

        transitioner.on('initialized', function started() {
            transitioner.prune();
            transitioner.run();
        });

        process.on('SIGINT', function () {
            console.log('Got SIGINT. Waiting for transitioner to finish.');
            transitioner.stop(function stoped() {
                process.exit(0);
            });
        });

        process.on('SIGHUP', function () {
            console.log('Got SIGHUP. Running next transition immediately.');
            // If there's no timeout set, it's already running transitions,
            // otherwise, let's run:
            if (transitioner.runTimeout) {
                transitioner.run();
            }
        });

        transitioner.start();
    } catch (err) {
        exitOnError(err);
    }
}

module.exports = {
    KbmApiTransitioner: KbmApiTransitioner
};
// vim: set softtabstop=4 shiftwidth=4:
