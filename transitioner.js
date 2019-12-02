/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
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
 *   - Check the type of transition. We're interested only on "stage" and
 *     "activate" for a first pass.
 *   - In case we have an "stage" transition, grab the recovery
 *     configuration template we want to spread across all the transition
 *     targets.
 *   - Create a cn-agent task for each one of the targets, with the given
 *     concurrency, awaiting for completion of the first batch of CNs before
 *     re-checking the recovery configuration transition for cancelation
 *     attempts. Save the tasksids into the transition backend. Save the
 *     uuids of the cns where the taksks are being executed as WIP.
 *   - Poll for tasks completion. Once a task is complete add the cn UUID
 *     to transition's completed member.
 *   - Check if the transition has been canceled and in such case finish it
 *     without moving into next batch.
 *   - Do the same until we have completed the whole set targets in batches of
 *     the given concurrency.
 *   - If the action is "activate" we also need to "expire" the previously
 *     active recovery configuration on completion, (and all the associated
 *     PIVTokens).
 *
 * Additionally, this service will also remove pivtoken-history records older
 * than KBMAPI_HISTORY_DURATION setting.
 *
 */
const util = require('util');

const assert = require('assert-plus');
const bunyan = require('bunyan');
const jsprim = require('jsprim');
const mooremachine = require('mooremachine');
const moray = require('moray');
const restify = require('restify');
const vasync = require('vasync');
const VError = require('verror');

const mod_apis_moray = require('./lib/apis/moray');
const models = require('./lib/models');

var log = bunyan.createLogger({
    name: 'kbmapi-transitioner',
    level: 'debug',
    serializers: restify.bunyan.serializers
});

const USAGE_PERIOD = 8 * 60 * 60 * 1000; // 8 hours

function periodicUsageLog(alog) {
    alog.info({ memory: process.memoryUsage() },
        'Current memory usage');
}

function KbmApiTransitioner(opts) {
    this.log = opts.log;
    this.config = opts.config;
    this.cnapi = opts.cnapi || null;
    this.moray = opts.moray || null;

    if (opts.config && opts.config.bucketPrefix) {
        mod_apis_moray.setTestPrefix(
            opts.config.bucketPrefix.replace(/-/g, '_'));
    }

    mooremachine.FSM.call(this, 'waiting');
}

util.inherits(KbmApiTransitioner, mooremachine.FSM);

/**
 * Starts the transitioner service
 */
KbmApiTransitioner.prototype.start = function start() {
    this.emit('startAsserted');
};

/**
 * Stops the transitioner service
 */
KbmApiTransitioner.prototype.stop = function stop(callback) {
    assert.ok(this.isInState('running'));
    this.emit('stopAsserted', callback);
};


KbmApiTransitioner.prototype.state_waiting = function (S) {
    S.validTransitions(['init']);

    S.on(this, 'startAsserted', function () {
        S.gotoState('init');
    });
};

KbmApiTransitioner.prototype.state_init = function (S) {
    S.gotoState('init.memlogger');
};

KbmApiTransitioner.prototype.state_init.memlogger = function (S) {
    this.log.info({ period: USAGE_PERIOD },
        'Starting periodic logging of memory usage');
    this.usageTimer = setInterval(periodicUsageLog, USAGE_PERIOD, this.log);
    S.gotoState('init.cnapi');
};

KbmApiTransitioner.prototype.state_init.cnapi = function (S) {
    var self = this;
    S.validTransitions(['failed', 'init.moray']);

    if (self.cnapi) {
        S.gotoState('init.moray');
        return;
    }

    var conf = jsprim.deepCopy(self.config.cnapi);
    self.log.debug(conf, 'Creating CNAPI client');

    conf.log = self.log.child({
        component: 'cnapi',
        level: self.config.logLevel || 'info'
    });

    self.cnapi = restify.createJsonClient(conf);

    S.gotoState('init.moray');
};

KbmApiTransitioner.prototype.state_init.moray = function (S) {
    var self = this;

    S.validTransitions([ 'failed', 'running' ]);

    if (self.moray) {
        S.gotoState('running');
        return;
    }

    var conf = jsprim.deepCopy(self.config.moray);

    self.log.debug(conf, 'Creating moray client');

    conf.log = self.log.child({
        component: 'moray',
        level: self.config.moray.logLevel || 'info'
    });

    self.moray = moray.createClient(conf);

    S.on(self.moray, 'connect', function onMorayConnect() {
        self.log.info('moray: connected');
        S.gotoState('running');
    });

    S.on(self.moray, 'error', function onMorayError(err) {
        self.initErr = new VError(err, 'moray: connection failed');
        S.gotoState('failed');
    });
};


KbmApiTransitioner.prototype.state_running = function (S) {
    var self = this;

    S.validTransitions([ 'stopping' ]);

    S.on(self, 'stopAsserted', function (callback) {
        self.stopcb = callback;
        S.gotoState('stopping');
    });

    S.immediate(function () {
        self.emit('initialized');
    });
};

KbmApiTransitioner.prototype.state_failed = function (S) {
    var self = this;

    S.validTransitions([]);

    self._cleanup(function () {
        self.emit('error', self.initErr);
    });
};

KbmApiTransitioner.prototype.state_stopping = function (S) {
    var self = this;

    S.validTransitions([ 'stopped' ]);

    self._cleanup(function cleanupCb(err) {
        self.stoperr = err;
        S.gotoState('stopped');
    });
};

KbmApiTransitioner.prototype.state_stopped = function (S) {
    S.validTransitions([]);
    setImmediate(this.stopcb, this.stoperr);
};

KbmApiTransitioner.prototype._cleanup = function (callback) {
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

    if (callback) {
        callback();
        return;
    }
};

KbmApiTransitioner.prototype.prune = function prune() {
    var self = this;
    function pruneHist() {
        if (self.pruneTimeout) {
            clearTimeout(self.pruneTimeout);
            self.pruneTimeout = null;
        }

        // Expected to be in seconds
        const duration = self.config.historyDuration * 1000;
        const dateLimit = new Date(Date.now() - duration).toISOString();

        const filter = util.format('(active_range:overlaps:=[,%s])', dateLimit);
        const bucket = models.pivtoken_history.bucket().name;
        // Delete from pivtoken-history:
        self.moray.deleteMany(bucket, filter, function delCb(err) {
            if (err) {
                self.log.error({
                    err: err,
                    filter: filter
                }, 'Error removing pivtoken history records');
            }
            // We'll delete old recovery tokens too:
            const b = models.recovery_token.bucket().name;
            const f = util.format('(expired<=%s)', dateLimit);
            self.moray.deleteMany(b, f, function deCb(dErr) {
                if (dErr) {
                    self.log.error({
                        err: err,
                        filter: f
                    }, 'Error recovery token expired records');
                }

                self.log.debug({
                    history_filter: filter,
                    token_filter: f
                }, 'Prune run.');

                setTimeout(pruneHist, self.config.pollInterval * 1000);
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
                        self.log.error({err: upErr}, 'Abort transition error');
                    }
                    self.runTimeout =
                        setTimeout(runTransition,
                            self.config.pollInterval * 1000);
                });
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

                const filter = '(|' + ctx.pendingTargets.map(function (t) {
                    return util.format('(cn_uuid=%s)', t);
                }).join('') + ')';

                models.model.list({
                    moray: self.moray,
                    log: self.log,
                    bucket: models.pivtoken.bucket(),
                    params: { filter: filter },
                    validFields: ['guid', 'cn_uuid'],
                    model: models.pivtoken.PIVToken
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

                    self.log.debug({
                        filter: filter,
                        pivtokens: ctx.pivtokensByCnUuid
                    }, 'getPendingTargetsPIVTokens');

                    next();
                });
            },
            // Note that if the action is "stage" it would be expected
            // to do not have any RecoveryTokens associated with the
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
                // Also, when we do we need to lock the transition so no other
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
                // Function to process a batch of N items
                function doBatch(items, nextBatch) {
                    self.log.debug({
                        cns: items
                    }, 'doBatch');
                    var errs = [];
                    var tasks = [];
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
                                    // Should make this a constant
                                        timeout: 60 * 5000
                                    }, nextStep);
                                }
                            ]}, function taskCb(taskErr, _taskRes) {
                                if (taskErr) {
                                    errs.push(taskErr);
                                }
                                nextTask();
                            });
                        }
                    }, function batchCb(batchErr, _batchRes) {
                        if (batchErr) {
                            self.log.error({
                                err: batchErr
                            }, 'Unexpected batch error');
                        }
                        var val = {
                            taskids: (ctx.currTr.params.taskids || [])
                                .concat(tasks)
                        };

                        if (errs) {
                            val.errs = errs.concat(
                                ctx.currTr.params.errs || []);
                        }

                        val.completed = (ctx.currTr.params.completed || [])
                            .concat(items);
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
                                next(VError({
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

                const concurrency = ctx.currTr.params.concurrency;
                var pending = ctx.pendingTargets;
                var numBatches = Math.floor(pending.length /
                    concurrency);
                if ((pending.length % concurrency) !== 0) {
                    numBatches += 1;
                }
                var batches = [];

                var i, items;
                for (i = 0; i < numBatches; i += 1) {
                    items = pending.slice(i * concurrency,
                        (i * concurrency) + concurrency);
                    batches.push(items);
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

                // Run transitions.
                // Then stop the transitioner until something else makes it
                // run again.
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
