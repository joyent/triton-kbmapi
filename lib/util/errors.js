/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Error classes and helpers
 */

'use strict';

const util = require('util');

const assert = require('assert-plus');
const restify = require('restify');


// --- Globals


const MSG = {
    duplicate: 'Already exists',
    internal: 'Internal error',
    missingParam: 'Missing parameter',
    missingParams: 'Missing parameters',
    invalidParams: 'Invalid parameters'
};



// --- Error classes


/**
 * Base class for an internal server error
 */
function InternalError(cause, message) {
    assert.object(cause, 'cause');
    assert.optionalString(message, 'message');

    if (!message) {
        message = MSG.internal;
    }

    restify.InternalServerError.call(this, {
        cause: cause,
        message: message,
        restCode: 'InternalError',
        body: {
            code: 'InternalError',
            message: message
        }
    });
}

util.inherits(InternalError, restify.InternalServerError);


/**
 * Base class for invalid / missing parameters
 */
function InvalidParamsError(message, errors) {
    assert.string(message, 'message');
    assert.arrayOfObject(errors, 'errors');

    restify.RestError.call(this, {
        restCode: 'InvalidParameters',
        statusCode: 422,
        message: message,
        body: {
            code: 'InvalidParameters',
            message: message,
            errors: errors
        }
    });

    this.name = 'InvalidParamsError';
}

util.inherits(InvalidParamsError, restify.RestError);


/*
 * Error response for duplicate parameters
 */
function duplicateParam(field, message) {
    assert.string(field, 'field');

    return {
        field: field,
        code: 'Duplicate',
        message: message || MSG.duplicate
    };
}


/**
 * Error response for invalid parameters
 */
function invalidParam(field, message, extra) {
    assert.string(field, 'field');

    var param = {
        field: field,
        code: 'InvalidParameter',
        message: message || MSG.invalidParams
    };

    if (extra) {
        for (var e in extra) {
            param[e] = extra[e];
        }
    }

    return param;
}

/**
 * Error response for missing parameters
 */
function missingParam(field, message) {
    assert.string(field, 'field');

    return {
        field: field,
        code: 'MissingParameter',
        message: message || MSG.missingParam
    };
}


module.exports = {
    duplicateParam: duplicateParam,
    InternalError: InternalError,
    invalidParam: invalidParam,
    InvalidParamsError: InvalidParamsError,
    missingParam: missingParam,
    msg: MSG
};
// vim: set softtabstop=4 shiftwidth=4:
