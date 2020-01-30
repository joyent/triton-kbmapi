
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * The kbmapi Recovery Configurations endpoints
 */

'use strict';
const util = require('util');
const jsprim = require('jsprim');
const VError = require('verror');

const models = require('../models');
const mod_recovery_configuration = models.recovery_configuration;
const mod_recovery_token = models.recovery_token;
const transition = models.fsm_transition;

const restify = require('restify');

function preloadRecoveryConfiguration(req, res, next) {
    if (!req.params.uuid) {
        next();
        return;
    }
    mod_recovery_configuration.get({
        moray: req.app.moray,
        params: {
            uuid: req.params.uuid
        }
    }, function getCb(err, recoveryConfig) {
        if (err) {
            if (err.statusCode === 404) {
                next();
                return;
            }
            req.log.error({
                error: err,
                params: req.params
            }, 'Error sent');
            next(err);
            return;
        }
        req.recoveryConfig = recoveryConfig.serialize();
        next();
    });
}

function listRecoveryConfigurations(req, res, next) {
    mod_recovery_configuration.ls({
        moray: req.app.moray,
        log: req.log,
        params: req.params
    }, function listCb(err, recoveryConfigs) {
        if (err) {
            req.log.error({
                error: err,
                params: req.params
            }, 'Error sent');
            next(err);
            return;
        }

        res.send(200, recoveryConfigs.map(function serialize(recCfg) {
            return recCfg.serialize();
        }));
        next();
    });
}

function createRecoveryConfiguration(req, res, next) {
    mod_recovery_configuration.create({
        moray: req.app.moray,
        params: {
            template: req.params.template
        }
    }, function createCb(err, recoveryConfig) {
        if (err) {
            req.log.error({
                err: err
            }, 'Create recovery configuration error');
            if (VError.hasCauseWithName(err, 'EtagConflictError')) {
                const error = VError.findCauseByName(err, 'EtagConflictError');
                const uuid = error.context.key;
                if (uuid) {
                    req.params.uuid = uuid;
                    preloadRecoveryConfiguration(req, res, function (getErr) {
                        if (getErr) {
                            next(getErr);
                            return;
                        }
                        res.send(202, req.recoveryConfig);
                        next();
                    });
                    return;
                }
                next();
                return;
            }
            req.log.error({
                error: err,
                params: req.params
            }, 'Error sent');
            next(err);
            return;
        }

        res.send(201, recoveryConfig.serialize());
        next();
    });
}

function getRecoveryConfiguration(req, res, next) {
    if (!req.recoveryConfig) {
        next(new restify.ResourceNotFoundError(
            'recovery configuration not found'));
        return;
    }

    res.send(200, req.recoveryConfig);
    next();
}

/*
 * Retrieve the recovery tokens associated with a given recovery configuration.
 * Just public fields, since this is a non authenticated request.
 */
function listRecoveryConfigurationTokens(req, res, next) {
    if (!req.recoveryConfig) {
        next(new restify.ResourceNotFoundError(
            'recovery configuration not found'));
        return;
    }

    mod_recovery_token.ls({
        moray: req.app.moray,
        log: req.log,
        params: {
            filter: util.format('(recovery_configuration=%s)',
                req.recoveryConfig.uuid)
        }
    }, function lsCb(lsErr, recTokens) {
        if (lsErr) {
            req.log.error({
                error: lsErr,
                params: req.params
            }, 'Error sent');
            next(lsErr);
            return;
        }

        res.send(200, recTokens.map(function serialize(token) {
            var aToken = jsprim.deepCopy(token.serialize());
            delete aToken.token;
            return aToken;
        }));
        next();
    });
}

function updateRecoveryConfiguration(req, res, next) {
    if (!req.recoveryConfig) {
        next(new restify.ResourceNotFoundError(
            'recovery configuration not found'));
        return;
    }

    if (!req.params.action) {
        next(new restify.MissingParameterError(
            'A value for the \'action\' parameter must be provided'));
        return;
    }

    var trParams = {
        uuid: req.params.uuid
    };

    if (req.params.force) {
        trParams.force = true;
    }

    if (req.params.pivtoken) {
        trParams.pivtoken = req.params.pivtoken;
    }

    // Allow to also specify the pivtoken using the CN UUID instead of
    // the associated PIVToken GUID, which might be easier sometimes
    if (req.params.cn_uuid) {
        trParams.targets = [req.params.cn_uuid];
    }

    if (req.params.cn_uuid || req.params.pivtoken) {
        trParams.standalone = true;
    }

    if (req.params.concurrency) {
        trParams.concurrency = req.params.concurrency;
    }

    transition({
        moray: req.app.moray,
        log: req.log,
        action: req.params.action,
        params: trParams
    }, function trCb(trErr, trRes) {
        if (trErr && !trRes) {
            req.log.error({
                error: trErr,
                params: req.params
            }, 'Error sent');
            next(trErr);
            return;
        }
        if (trRes.transition && trRes.transition.raw().name) {
            res.header('Location', util.format(
                '/recovery-configurations/%s?action=watch&transition=%s',
                req.params.uuid,
                trRes.transition && trRes.transition.raw().name
            ));
        }
        res.send(trErr ? 200 : 204);
        next();
    });
}

function deleteRecoveryConfiguration(req, res, next) {
    if (!req.recoveryConfig) {
        next(new restify.ResourceNotFoundError(
            'recovery configuration not found'));
        return;
    }

    mod_recovery_configuration.del({
        moray: req.app.moray,
        uuid: req.params.uuid
    }, function (err) {
        if (err) {
            req.log.error({
                error: err,
                params: req.params
            }, 'Error sent');
            if (err.name === 'InvalidConfigurationState') {
                next(new restify.PreconditionFailedError(err.message));
                return;
            }
            next(err);
            return;
        }
        res.send(204);
        next();
    });
}

function watchRecoveryConfiguration(req, res, next) {
    if (!req.recoveryConfig) {
        next(new restify.ResourceNotFoundError(
            'recovery configuration not found'));
        return;
    }
    next(new restify.NotImplementedError(
        'Watching recovery configuration transition progress is not ' +
        'implemented yet.'));
}


function registerEndpoints(http, before) {
    http.get({
        path: '/recovery-configurations',
        name: 'listrecoveryconfigs'
    }, before, listRecoveryConfigurations);
    http.post({
        path: '/recovery-configurations',
        name: 'createrecoveryconfiguration'
    }, before, preloadRecoveryConfiguration, createRecoveryConfiguration);
    http.get({
        path: '/recovery-configurations/:uuid',
        name: 'getrecoveryconfiguration'
    }, before, preloadRecoveryConfiguration, getRecoveryConfiguration);
    http.get({
        path: '/recovery-configurations/:uuid/recovery-tokens',
        name: 'listrecoveryconfigurationtokens'
    }, before, preloadRecoveryConfiguration, listRecoveryConfigurationTokens);
    http.del({
        path: '/recovery-configurations/:uuid',
        name: 'delrecoveryconfiguration'
    }, before, preloadRecoveryConfiguration, deleteRecoveryConfiguration);
    http.put({
        path: '/recovery-configurations/:uuid',
        name: 'putrecoveryconfiguration'
    }, before, preloadRecoveryConfiguration, updateRecoveryConfiguration);
    http.post({
        path: '/recovery-configurations/:uuid/watch',
        name: 'watchrecoveryconfiguration'
    }, before, preloadRecoveryConfiguration, watchRecoveryConfiguration);
}

module.exports = {
    registerEndpoints: registerEndpoints
};
// vim: set softtabstop=4 shiftwidth=4:
