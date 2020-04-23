# Key Backup and Management API (KBMAPI)

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->


  - [PIV token object](#piv-token-object)
  - [PIV token History](#piv-token-history)
- [KBMAPI Endpoints](#kbmapi-endpoints)
  - [CreatePivtoken (POST /pivtokens)](#createpivtoken-post-pivtokens)
  - [UpdatePivtoken (PUT /pivtokens/:guid)](#updatepivtoken-put-pivtokensguid)
  - [ReplacePivtoken (POST /pivtokens/:replaced\_guid/replace)](#replacepivtoken-post-pivtokensreplaced%5C_guidreplace)
  - [ListPivtokens (GET /pivtokens)](#listpivtokens-get-pivtokens)
  - [GetToken (GET /pivtokens/:guid)](#gettoken-get-pivtokensguid)
  - [GetTokenPin (GET /pivtokens/:guid/pin)](#gettokenpin-get-pivtokensguidpin)
  - [DeletePivtoken (DELETE /pivtokens/:guid)](#deletepivtoken-delete-pivtokensguid)
  - [Recovery Tokens](#recovery-tokens)
  - [ListRecoveryTokens (GET /pivtokens/:guid/recovery-tokens)](#listrecoverytokens-get-pivtokensguidrecovery-tokens)
  - [CreateRecoveryToken (POST /pivtokens/:guid/recovery-tokens)](#createrecoverytoken-post-pivtokensguidrecovery-tokens)
  - [GetRecoveryToken (GET /pivtokens/:guid/recovery-tokens/:uuid)](#getrecoverytoken-get-pivtokensguidrecovery-tokensuuid)
  - [UpdateRecoveryToken (PUT /pivtokens/:guid/recovery-tokens/:uuid)](#updaterecoverytoken-put-pivtokensguidrecovery-tokensuuid)
  - [DeleteRecoveryToken (DELETE /pivtokens/:guid/recovery-tokens/:uuid)](#deleterecoverytoken-delete-pivtokensguidrecovery-tokensuuid)
  - [Recovery Configuration(s)](#recovery-configurations)
  - [Recovery configurations lifecycle](#recovery-configurations-lifecycle)
  - [AddRecoveryConfig (POST /recovery_configs)](#addrecoveryconfig-post-recovery_configs)
  - [WatchRecoveryConfigTransition (GET /recovery_configs/:uuid?action=watch&transition=\<name\>)](#watchrecoveryconfigtransition-get-recovery_configsuuidactionwatchtransition%5Cname%5C)
  - [ListRecoveryConfigs (GET /recovery_configs)](#listrecoveryconfigs-get-recovery_configs)
  - [ShowRecoveryConfig (GET /recovery_configs/:uuid)](#showrecoveryconfig-get-recovery_configsuuid)
  - [StageRecoveryConfig (PUT /recovery_configs/:uuid?action=stage)](#stagerecoveryconfig-put-recovery_configsuuidactionstage)
  - [UnstageRecoveryConfig (PUT /recovery_configs/:uuid?action=unstage)](#unstagerecoveryconfig-put-recovery_configsuuidactionunstage)
  - [ActivateRecoveryConfig (PUT /recovery_configs/:uuid?action=activate)](#activaterecoveryconfig-put-recovery_configsuuidactionactivate)
  - [DeactivateRecoveryConfig (PUT /recovery_configs/:uuid?action=deactivate)](#deactivaterecoveryconfig-put-recovery_configsuuidactiondeactivate)
  - [RemoveRecoveryConfig (DELETE /recovery_configs/:uuid)](#removerecoveryconfig-delete-recovery_configsuuid)
- [Inventory: Recovery Configs associated with PIV tokens](#inventory-recovery-configs-associated-with-piv-tokens)
  - [Inventory Update](#inventory-update)
  - [Development status (v1.x pending)](#development-status-v1x-pending)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2020 Joyent, Inc.
-->


The goal of this is to provide an API that will be used to manage the
pivtokens on Triton compute nodes containing encrypted zpools.
The details are largely in [RFD 173](https://github.com/joyent/rfd/blob/master/rfd/0173/README.adoc) still.

The tl;dr is that when a CN boots, it will authenticate itself to KBMAPI,
and then request the pin to unlock its local PIV token.  Once unlocked, it
can supply the zpool encryption key to allow the encrypted zpool to be
imported.  It also allows for recovery (i.e. replace PIV token).

KBMAPI is a fairly simple and minimal REST service.  API endpoints
provide the means for adding new PIV tokens, removing PIV tokens, recovering PIV tokens
(i.e. replacing a PIV token), as well as providing the PIN of a PIV token to an
authenticated entity.

When a PIV token is added, the KBMAPI service will need to generate a recovery
pivtoken (a random blob of data) that will be stored on the CN.  The recovery
token serves two purposes:  First, it is used by the CN as the recovery key
as described in [Provisioning and backups](https://github.com/joyent/rfd/blob/master/rfd/0077/README.adoc#prov-backups).
Second, it is also used by the CN as a shared secret with KBMAPI for the purposes
of replacing the PIV token information of a CN with the data from a new PIV token.

#### kbmapi-history

When PIV tokens are deleted or reinitialized, the old PIV token data should be kept in a
KBMAPI-maintained history.  This history maintains the PIV token data for an
amount of time defined by the `KBMAPI_HISTORY_DURATION` SAPI variable.  The
default is 15 days.  The purpose is to provide a time-limited backup
against accidental PIV token deletion.

#### Attestation

NOTE: Attestation or token preloading are not implemented for KBMAPI v1.0. The
`attestation` attribute for PIV Tokens is accepted and properly stored, but not
enforced depending on `KBMAPI_REQUIRE_ATTESTATION`.

[yubi-attest](https://developers.yubico.com/PIV/Introduction/PIV_attestation.html)

Some PIV tokens have extensions that allow for attestation -- that is a method
to show that a given certificate was created on the device and not imported.
For YubiKeys, this is done by creating a special x509 certificate as detailed
[here](https://developers.yubico.com/PIV/Introduction/PIV_attestation.html).

If an operator wishes to require attestation, they must set the
`KBMAPI_REQUIRE_ATTESTATION` SAPI parameter to `true`.  In addition, the
`KBMAPI_ATTESTATION_CA` SAPI parameter must be set to the CA certificate
used for attestation.

Additionally, an operator may wish to limit the PIV tokens that are allowed to
be used with KBMAPI to a known set of PIV tokens.  To do so, an operator would
set the SAPI parameter `KBMAPI_REQUIRE_TOKEN_PRELOAD` to `true`.  A command
line tool (working name 'kbmctl') is then used by the operator to load the
range of serial numbers into KBMAPI.  This is only supported for PIV tokens that
support attestation (e.g. YubiKeys).  In other words, enabling
`KBMAPI_REQUIRE_TOKEN_PRELOAD` requires `KBMAPI_REQUIRE_ATTESTATION` to also
be enabled (but not necessarily vice versa).

It should be noted that both the attestation and device serial numbers
are non-standard PIV extensions.  As such support for either feature will
require kbmd / piv-tool and potentially kbmapi to support a particular device's
implementation.  Similarly, enabling the feature requires the use of PIV tokens
that implement the corresponding feature (attestation or a static serial number).
The initial scope will only include support for YubiKey attestation and serial
numbers.

In both cases, enforcement of the policy occurs during the provisioning
process (i.e. at the time of a CreatePivtoken call).  Changes to either policy
do _not_ affect existing PIV tokens in KBMAPI.

### PIV token object

The PIV token data needs to be persistently stored (for hopefully obvious reasons).
A moray bucket will be used to store the PIV token data. The JSON config of the
bucket will be:

```
{
    "desc": "token data",
    "name": "pivtokens",
    "schema": {
        "index": {
            "guid": { "type": "string", "unique": true },
            "cn_uuid": { "type": "uuid", "unique": true }
        }
    }
}
```

The PIV token object itself will be represented using JSON similar to:

```
{
    "model": "Yubico YubiKey 4",
    "serial": "5213681",
    "cn_uuid": "15966912-8fad-41cd-bd82-abe6468354b5",
    "guid": "97496DD1C8F053DE7450CD854D9C95B4",
    "pin": "123456",
    "recovery_tokens": [{
        "created": "ISO-8601 Time String",
        "token": "jmzbhT2PXczgber9jyOSApRP337gkshM7EqK5gOhAcg="
    }, {
        "created": "ISO-8601 Time String",
        "token": "QmUgc3VyZSB0byBkcmluayB5b3VyIG92YWx0aW5l"
    }]
    "pubkeys": {
       "9e": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9d": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9a": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA..."
    },
    "attestation": {
       "9e": "-----BEGIN CERTIFICATE-----....",
       "9d": "-----BEGIN CERTIFICATE-----....",
       "9a": "-----BEGIN CERTIFICATE-----....."
    }
}
```


**Field**        | **Required** | **Description**
-----------------|--------------|-----------------
model            | No       | The model of the PIV token.
serial           | No       | The serial number of the PIV token (if available).
cn\_uuid         | Yes      | The UUID of the compute node that contains this PIV token.
guid             | Yes      | The GUID of the provisioned PIV token.
pin              | Yes      | The pin of the provisioned PIV token.
recovery\_tokens | Yes      | An array of recovery tokens.  Used to recover the encryption keys of a zpool protected by this PIV token.  Also used when replacing a PIV token.  When the recovery configuration is updated, a new recovery token is generated and added to the list. Note that the `token` member is base64 encoded.
pubkeys          | Yes      | A JSON object containing the _public_ keys of the PIV token.
pubkeys.9a       | Yes      | The public key used for authentication after the PIV token has been unlocked.
pubkeys.9d       | Yes      | The public key used for encryption after the PIV token has been unlocked.
pubkeys.9e       | Yes      | The public key used for authenticating the PIV token itself without a pin (e.g. used when requesting the pin of a PIV token).
attestation      | No       | The attestation certificates for the corresponding pubkeys.


Note that when provisioning a PIV token, if any of the optional fields are known,
(e.g. `attestation` or `serial`) they should be supplied during provisioning.

### PIV token History

As a failsafe measure, when a PIV token is deleted, the entry from the PIV token
bucket is saved into a history bucket.  This bucket retains up to
`KBMAPI_HISTORY_DURATION` days of PIV token data (see [kbmapi-history](#kbmapi-history)).

The history bucket looks very similar to the PIV token bucket:

```
{
    "desc": "token history",
    "name": "pivtoken_history",
    "schema": {
        "index": {
            "guid": { "type": "string" },
            "cn_uuid": { "type": "uuid" },
            "active_range": { "type": "daterange" }
        }
    }
}
```

The major difference is that the index fields are not unique as well as the
`active_range` index.  An accidentally deleted PIV token that's restored might end
up with multiple history entries, and a CN which has had a PIV token replacement
will also have multiple history entries.

The moray entry in the history bucket also looks similar, but not quite the
same as the PIV token bucket:

```
{
    "active_range": "[2019-01-01T00:00:00Z, 2019-03-01T05:06:07Z]",
    "model": "Yubico YubiKey 4",
    "serial": "5213681",
    "cn_uuid": "15966912-8fad-41cd-bd82-abe6468354b5",
    "guid": "97496DD1C8F053DE7450CD854D9C95B4",
    "pin": "123456",
    "recovery_tokens": [{
        "created": "ISO-8601 Time String",
        "token": "jmzbhT2PXczgber9jyOSApRP337gkshM7EqK5gOhAcg="
    }, {
        "created": "ISO-8601 Time String",
        "token": "QmUgc3VyZSB0byBkcmluayB5b3VyIG92YWx0aW5l"
    }],
    "pubkeys": {
       "9e": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9d": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9a": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA..."
    },
    "attestation": {
       "9e": "-----BEGIN CERTIFICATE-----....",
       "9d": "-----BEGIN CERTIFICATE-----....",
       "9a": "-----BEGIN CERTIFICATE-----....."
    },
    "comment": ""
}
```

The major difference is the addition of the `active_range` property as well as
the `comment` property. The `active_range` property represents the (inclusive)
start and end dates that the provisioned PIV token was in use.

It's permitted that the same provisioned PIV token might have multiple entries in
the history table.  An example would be a PIV token accidentally deleted and
restored would have an entry for the deletion, and then a second entry when
the PIV token is retired (or reprovisioned).

The `comment` field is an optional field that contains free form text.  It is
intended to note the reason for the deletion.

To protect the PIV token data in Moray, we will rely on the headnode disk
encryption.

Given the HN PIV token will not use the GetTokenPin API call to obtain its pin,
we shouldn't store the data for the HN PIV token in KBMAPI.

#### Preloading PIV tokens

NOTE: Preloading PIV tokens is not supported by KBMAPI v1.0

To support an operator preloading unprovisioned PIV tokens, we track ranges of
serial numbers that are allowed to be provisioned.  We use a separate
moray bucket for tracking these ranges of serial numbers:

```
{
    "desc": "pivtoken serials",
    "name": "pivtoken_serial",
    "schema": {
        "index": {
            "ca_dn": { "type": "string" },
            "serial_range": { "type": "numrange" }
        }
    }
}
```

The entries looks similar to:

```
{
    "serial_range": "[111111, 123456]",
    "allow": true,
    "ca_dn": "cn=my manf authority",
    "comment": "A useful comment here"
}
```


**Field**     | **Description**
--------------|-----------------
serial\_range | An range of serial numbers.  This range is inclusive.
allow         | Set to true if this range is allowed, or false is this range is blacklisted.
ca\_dn        | The distinguished name (DN) of the attestation CA for this PIV token.  Used to disambiguate any potential duplicate serial numbers between vendors.
comment       | An operator supplied free form comment.


The `kbmctl` command is used to manage this data.

#### Audit Trail

NOTE: Audit trail is not supported by KBMAPI v1.0

Given the critical nature of the PIV token data, it is desirable to maintain an
audit trail of activity. KBMAPI does not provide a native mechanism for
replicating the audit trail to another system. It is recommended that the
Triton log archiver or another log shipping tool is used to safely store the
KBMAPI log file, /var/svc/log/smartdc-application-kbmapi:default.log.

#### Responses

All response objects are `application/json` encoded HTTP bodies.  In addition,
all responses will have the following headers:


**Header**  | **Description**
------------|-----------------
Date        | When the response was sent (RFC 1123 format).
Api-Version | The exact version of the KBMAPI server that processed the request.
Request-Id  | A unique id for this request.


If the response contains content, the following additional headers will be
present:


**Header**     | **Description**
---------------|-----------------
Content-Length | How much content, in bytes.
Content-Type   | The format of the response (currently always `application/json`).
Content-MD5    | An MD5 checksum of the response.


#### HTTP Status Codes

KBMAPI will return one of the following codes on an error:

**Code** | **Description**    | **Details**
---------|--------------------|-------------
401      | Unauthorized       | Either no Authorization header was sent, or the credentials used were invalid.
405      | Method Not Allowed | Method not supported for the given resource.
409      | Conflict           | A parameter was missing or invalid.
500      | Internal Error     | An unexpected error occurred.


If an error occurs, KBMAPI will return a standard JSON error response object
in the body of the response:

```
{
    "code": "CODE",
    "message": "human readable string"
}
```

Where `code` is one of:


**Code**           | **Description**
-------------------|------------------
BadRequest         | Bad HTTP was sent.
InternalError      | Something went wrong in KBMAPI.
InvalidArgument    | Bad arguments or a bad value for an argument.
InvalidCredentials | Authentication failed.
InvalidHeader      | A bad HTTP header was sent.
InvalidVersion     | A bad `Api-Version` string was sent.
MissingParameter   | A required parameter was missing.
ResourceNotFound   | The resource was not found.
UnknownError       | Something completely unexpected happened.


## KBMAPI Endpoints

In each case, each request should include an `Accept-Version` header indicating
the version of the API being requested.  The initial value defined here shall
be '1.0'.

### CreatePivtoken (POST /pivtokens)

Add a new initialized PIV token.  Included in the request should be an
`Authorization` header with a method of 'Signature' with the date header
signed using the PIV token's `9e` key.  The payload is a JSON object with the
following fields:


**Field**   | **Required** | **Description**
------------|--------------|-----------------
guid        | Yes          | The GUID of the provisioned PIV token.
cn\_uuid    | Yes          | The UUID of the CN that contains this PIV token.
pin         | Yes          | The pin for the PIV token generated during provisioning.
model       | No           | The model of the PIV token (if known).
serial      | No           | The serial number of the PIV token (if known).
pubkeys     | Yes          | The public keys of the PIV token generated during provisioning.
pubkeys.9a  | Yes          | The `9a` public key of the PIV token.
pubkeys.9d  | Yes          | The `9d` public key of the PIV token.
pubkeys.9e  | Yes          | The `9e` public key of the PIV token.
attestation | No           | The attestation certificates corresponding to the `9a`, `9d`, and `9e` public keys.


Note: for the optional fields, they should be supplied with the request when
known.  Unfortunately, there is no simple way to enforce this optionality on
the server side, so we must depend on the CN to supply the optional data
when appropriate.

If the signature check fails, a 401 Unauthorized error + NotAuthorized code
is returned.

If any of the required fields are missing, a 409 Conflict + InvalidArgument
error is returned.

If the `guid` or `cn_uuid` fields contain a value already in use in the
`tokens` bucket, a new entry is _not_ created.  Instead, the `9e` public key
from the request is compared to the `9e` key in the stored PIV token data.  If
the keys match, and the signature check succeeds, then the `recovery_token`
value of the existing entry is returned and a 200 response is returned. This
allows the CN to retry a request in the event the response was lost.

If the `9e` key in the request does not match the `9e` key for the existing
token in the `tokens` bucket, but either (or both) the `guid` or `cn_uuid`
fields match an existing entry, a 409 Conflict + NotAuthorized error
is returned.  In such an instance, an operator must manually verify if the
information in the PIV token bucket is out of date and manually delete it before
the PIV token provisioning can proceed.

If an operator has hardware with duplicate UUIDs, they must contact
their hardware vendor to resolve the situation prior to attempting to provision
the PIV token on the system with a duplicate UUID.  While we have seen such
instances in the past, they are now fairly rare.  Our past experience has
shown that attempting to work around this at the OS and Triton level is
complicated and prone to breaking.  Given what is at stake in terms of the
data on the system, we feel it is an unacceptable risk to try to work around
such a situation (instead of having the hardware vendor resolve it).

IMPORTANT: Don't forget that Attestation and token preloading are not supported
by KBMAPI v1.0

If the attestation section is supplied, the attestation certs _must_ agree
with the pubkeys supplied in the request.  If they do not agree, or if
`KBMAPI_ATTESTATION_REQUIRED` is true and no attestation certs are provided, a
409 Conflict + InvalidArgument error is returned.

If `KBMAPI_REQUIRE_TOKEN_PRELOAD` is `true`, the serial number of
the PIV token as well as the attestation certificates of the PIV token in question
must be present in the CreateToken request.  KBMAPI performs a search for
a range of allowed serial numbers in the `token_serial` bucket whose
attestation CA DN matches the attestation CA of the PIV token in the request.

If the serial number is not part of an allowed range, a
409 Conflict + InvalidArgument error is returned.

In addition, a `recovery_token` is generated by KBMAPI and stored as part of the
token object.  This should be a random string of bytes generated by a random
number generator suitable for cryptographic purposes.

Once the entry is updated or created in moray, a successful response is
returned (201) and the generated recovery token is included in the response.

Recovery Tokens may include some or all of the following fields:

**Field**               | **Required** | **Description**
------------------------|--------------|-----------------
uuid                    | Yes          | The UUID of the provisioned Recovery token.
pivtoken                | Yes          | The GUID of the provisioned PIV token.
token                   | Yes          | The encrypted recovery token which could be used for HMAC auth in case the PIVToken is not available. Note that this value is `base64` encoded. It should be properly decoded before using it for HMAC auth.
recovery\_configuration | Yes          | The UUID of the recovery configuration template to be used with the token.
template                | No           | The template associated with the aforementioned recovery configuration. Included when a new recovery token is created in order to save some extra HTTP requests to /recovery-configurations. (As a rule regarding when to expect this field to be present: only for HTTP POST requests).
created                 | Yes          | When this recovery token was created.
staged                  | No           | When this recovery token was staged. This information will be updated by cn-agent in KBMAPI once the recovery configuration associated with this recovery token has been staged into the CN.
activated               | No           | When this recovery token was activated. This information will be update by cn-agent in KBMAPI when the recovery configuration associated with the token has been activated into the CN. We only care about the "active" recovery token, where activated is set and "expired" is not.
expired                 | No           | When this recovery token was expired. Usually associated to the fact that another recovery token has been activated.


Example request (with attestation)

```
POST /pivtokens
Host: kbmapi.mytriton.example.com
Date: Thu, 13 Feb 2019 20:01:02 GMT
Authorization: Signature <Base64(rsa(sha256($Date)))>
Accept-Version: ~1
Accept: application/json

{
    "model": "Yubico YubiKey 4",
    "serial": "5213681",
    "cn_uuid": "15966912-8fad-41cd-bd82-abe6468354b5",
    "guid": "97496DD1C8F053DE7450CD854D9C95B4",
    "pin": "123456",
    "pubkeys": {
       "9e": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9d": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9a": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA..."
    },
    "attestation": {
       "9e": "-----BEGIN CERTIFICATE-----....",
       "9d": "-----BEGIN CERTIFICATE-----....",
       "9a": "-----BEGIN CERTIFICATE-----....."
    }
}
```

An example response might look like:

```
HTTP/1.1 201 Created
Location: /pivtokens/97496DD1C8F053DE7450CD854D9C95B4
Content-Type: application/json
Content-Length: 12345
Content-MD5: s5ROP0dBDWlf5X1drujDvg==
Date: Fri, 15 Feb 2019 12:34:56 GMT
Server: Joyent KBMAPI 1.0
Api-Version: 1.0
Request-Id: b4dd3618-78c2-4cf5-a20c-b822f6cd5fb2
Response-Time: 42


{
    "model": "Yubico YubiKey 4",
    "serial": "5213681",
    "cn_uuid": "15966912-8fad-41cd-bd82-abe6468354b5",
    "guid": "97496DD1C8F053DE7450CD854D9C95B4",
    "pubkeys": {
       "9e": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9d": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9a": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA..."
    },
    "recovery_tokens": [
        {
            token: 'ca0dab3f5b936f6a97e98d9161b6fc3da2ab8c4f086ad286f9bdf296cbc5c9026d224fbd0b0d109e',
            created: '2019-11-06T15:49:11.218Z',
            pivtoken: '97496DD1C8F053DE7450CD854D9C95B4',
            recovery_configuration: 'ff6d69c1-0af2-4441-9416-7bd8a9ec56fe',
            uuid: '03482e94-64b0-50d3-a858-23fdf3ff47f6'
        }
    ]
}
```

In order to make the request/response retry-able without generating and saving a new
`recovery_token` each time (to prevent a single recovery configuration update
from creating multiple `recovery_tokens` due to network/retry issues), any
requests made after the initial PIV token creation to the same `Location` (i.e.
`POST /pivtokens/:guid`) will result into the same PIV token object being
retrieved.

This can be used in order to generate new recovery tokens when a request is
made at a given time after `recovery_token` creation. This time interval will
be configurable in SAPI through the variable `KBMAPI_RECOVERY_TOKEN_DURATION`.
By default, this value is set to 1 day.

When the `POST` request is received for an existing PIV token, KBMAPI will
verify the antiquity of the newest member of `recovery_tokens` and in case it
exceeds the aforementioned `KBMAPI_RECOVERY_TOKEN_DURATION` value, it will
generate a new `recovery_token`.

On all of these cases, the status code will be `200 Ok` instead of the
`201 Created` used for the initial PIV token creation.

### UpdatePivtoken (PUT /pivtokens/:guid)

Update the current fields of a PIV token.  Currently, the only field that can be
altered is the `cn_uuid` field (e.g. during a chassis swap).  If the new
`cn_uuid` field is already associated with an assigned PIV token, or if any of
the remaining fields differ, the update fails.

This request is authenticated by signing the Date header with the PIV token's 9e
key (same as CreateToken).  This however does not return the recovery token
in it's response.

Example request:

```
PUT /pivtokens/97496DD1C8F053DE7450CD854D9C95B4
Host: kbmapi.mytriton.example.com
Date: Thu, 13 Feb 2019 20:01:02 GMT
Authorization: Signature <Base64(rsa(sha256($Date)))>
Accept-Version: ~1
Accept: application/json

{
    "model": "Yubico YubiKey 4",
    "serial": "5213681",
    "cn_uuid": "99556402-3daf-cda2-ca0c-f93e48f4c5ad",
    "guid": "97496DD1C8F053DE7450CD854D9C95B4",
    "pin": "123456",
    "pubkeys": {
       "9e": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9d": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9a": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA..."
    },
    "attestation": {
       "9e": "-----BEGIN CERTIFICATE-----....",
       "9d": "-----BEGIN CERTIFICATE-----....",
       "9a": "-----BEGIN CERTIFICATE-----....."
    }
}
```

Example response:

```
HTTP/1.1 200 OK
Location: /pivtokens/97496DD1C8F053DE7450CD854D9C95B4
Content-Type: application/json
Content-Length: 1122
Content-MD5: s5ROP0dBDWlf5X1drujDvg==
Date: Sun, 17 Feb 2019 10:27:43 GMT
Server: Joyent KBMAPI 1.0
Api-Version: 1.0
Request-Id: 7e2562ba-731b-c91b-d7c6-90f2fd2d36a0
Response-Time: 23
```

### ReplacePivtoken (POST /pivtokens/:replaced\_guid/replace)

When a PIV token is no longer available (lost, damaged, accidentally reinitialized,
etc.), a recovery must be performed.  This allows a new PIV token to replace the
unavailable PIV token.  When a replacement is required, an operator initiates the
recovery process on the CN.  This recovery process on the CN will decrypt the
current `recovery_token` value for the lost PIV token that was created during the
lost PIV token's CreatePivtoken request or a subsequent `CreatePivtoken` request.
KBMAPI will periodically purge members of a PIV token's `recovery_tokens` array
that are sufficiently old to no longer be considered valid (even when accounting
for propagation delays).

The CN submits a ReplacePivtoken request to replace the unavailable PIV token
with a new PIV token.  The `:replaced_guid` parameter is the guid of the
unavailable PIV token.
The data included in the request is identical to that of a CreatePivtoken request.
The major difference is that instead of using a PIV token's 9e key to sign the date
field, the decrypted `recovery_token` value is used as the signing key.

Instead of HTTP Signature auth using the SSH key, HMAC signature using the
`recovery_token` as value will be used.

If the lost PIV token does not exist in KBMAPI we should reject the request with
a `404 Not Found` response.

If the request fails to authenticate, a `401 Unauthorized` error
is returned.

If all the checks succeed, the information from the old PIV token
(`:replaced_guid`) is moved to a history entry for that PIV token.
Any subsequent requests to `/pivtokens/:replaced_guid` should either return a
`404 Not found` reply. Note we do not try to return a `301 Moved Permanently`
response with a new PIV token location because we could have a request to a PIV
token which has already been replaced by another, which in turn has been
replaced by another one ...

The newly created PIV token will then be returned, together with the proper
`Location` header (`/pivtokens/:new_guid`). In case of network/retry issues,
additional attempts to retrieve the new PIV token information should be made
through `CreateToken` end-point for the new PIV token, and these requests should
be signed by the new PIV token 9e key, instead of using HMAC with the old PIV token
`recovery_token`.

An example request:

```
POST /pivtokens/97496DD1C8F053DE7450CD854D9C95B4/recover
Host: kbmapi.mytriton.example.com
Date: Thu, 13 Feb 2019 20:01:02 GMT
Authorization: Signature <Base64(rsa(sha256($Date)))>
Accept-Version: ~1
Accept: application/json

{
    "model": "Yubico YubiKey 4",
    "serial": "6324923",
    "cn_uuid": "15966912-8fad-41cd-bd82-abe6468354b5",
    "guid": "75CA077A14C5E45037D7A0740D5602A5",
    "pin": "424242",
    "pubkeys": {
       "9e": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9d": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9a": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA..."
    },
    "attestation": {
       "9e": "-----BEGIN CERTIFICATE-----....",
       "9d": "-----BEGIN CERTIFICATE-----....",
       "9a": "-----BEGIN CERTIFICATE-----....."
    }
}
```

And an example response:

```
HTTP/1.1 201 Created
Location: /pivtokens/75CA077A14C5E45037D7A0740D5602A5
Content-Type: application/json
Content-Length: 12345
Content-MD5: s5ROP0dBDWlf5X1drujDvg==
Date: Fri, 15 Feb 2019 12:54:56 GMT
Server: Joyent KBMAPI 1.0
Api-Version: 1.0
Request-Id: 473bc7f4-05cf-4edb-9ef7-8b61cdd8e6b6
Response-Time: 42

{
    "model": "Yubico YubiKey 4",
    "serial": "5213681",
    "cn_uuid": "15966912-8fad-41cd-bd82-abe6468354b5",
    "guid": "75CA077A14C5E45037D7A0740D5602A5",
    "pubkeys": {
       "9e": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9d": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9a": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA..."
    },
    "recovery_tokens": [
        {
            "created": "2019-11-06T15:49:11.101Z",
            "token": "cefb9c2001b535b697d5a13ba6855098e8c58feb800705092db061343bb7daa10e52a97ed30f2cf1"
        }
    ]
}
```

Note that the location contains the guid of the _new_ PIV token.


### ListPivtokens (GET /pivtokens)

Gets all provisioned PIV tokens.  The main requirement here is no
sensitive information of a PIV token is returned in the output.

Filtering by at least the `cn_uuid` as well as windowing functions should be
supported.

An example request:

```
GET /pivtokens
Host: kbmapi.mytriton.example.com
Date: Wed, 12 Feb 2019 02:04:45 GMT
Accept-Version: ~1
Accept: application/json
```

An example response:

```
HTTP/1.1 200 Ok
Location: /pivtokens
Content-Type: application/json
Content-Length: 11222333
Content-MD5: s5ROP0dBDWlf5X1drujDvg==
Date: Wed, 12 Feb 2019 02:04:45 GMT
Server: Joyent KBMAPI 1.0
Api-Version: 1.0
Request-Id: af32dafe-b9ed-c2c1-b5e5-f5fefc40aba4
Response-Time: 55

{
    [
        {
            "model": "Yubico YubiKey 4",
            "serial": "5213681",
            "cn_uuid": "15966912-8fad-41cd-bd82-abe6468354b5",
            "guid": "97496DD1C8F053DE7450CD854D9C95B4"
            "pubkeys": {
               "9e": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
               "9d": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
               "9a": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA..."
            }
        },
        {
            "model": "Yubico YubiKey 5",
            "serial": "12345123",
            "cn_uuid": "e9498ab2-d6d8-ca61-b908-fb9e2fea950a",
            "guid": "75CA077A14C5E45037D7A0740D5602A5",
            "pubkeys": {
               "9e": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
               "9d": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
               "9a": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA..."
            }
        },
        ....
    ]
}
```

### GetToken (GET /pivtokens/:guid)

Gets the public info for a specific PIV token.  Only the public fields are
returned.

Example request:

```
GET /pivtokens/97496DD1C8F053DE7450CD854D9C95B4
Host: kbmapi.mytriton.example.com
Date: Wed, 12 Feb 2019 02:10:32 GMT
Accept-Version: ~1
Accept: application/json
```

Example response:

```
HTTP/1.1 200 Ok
Location: /pivtokens/97496DD1C8F053DE7450CD854D9C95B4
Content-Type: application/json
Content-Length: 12345
Content-MD5: s5REP1dBDWlf5X1drujDvg==
Date: Wed, 12 Feb 2019 02:10:35 GMT
Server: Joyent KBMAPI 1.0
Api-Version: 1.0
Request-Id: de02d045-f8df-cf51-c424-a21a7984555b
Response-Time: 55

{
   "model": "Yubico YubiKey 4",
   "serial": "5213681",
   "cn_uuid": "15966912-8fad-41cd-bd82-abe6468354b5",
   "guid": "97496DD1C8F053DE7450CD854D9C95B4"
   "pubkeys": {
      "9e": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
      "9d": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
      "9a": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA..."
   }
}
```

### GetTokenPin (GET /pivtokens/:guid/pin)

Like GetToken, except it also includes the `pin`.  The `recovery_token` field
is *not* returned.  This request must be authenticated using the 9E key of the
token specified by `:guid` to be successful.  An `Authorization` header should
be included in the request, the value being the signature of the `Date` header
(very similar to how CloudAPI authenticates users);

This call is used by the CN during boot to enable it to unlock the other
keys on the PIV token.

An example request:

```
GET /pivtokens/97496DD1C8F053DE7450CD854D9C95B4/pin
Host: kbmapi.mytriton.example.com
Date: Wed, 12 Feb 2019 02:11:32 GMT
Accept-Version: ~1
Accept: application/json
Authorization: Signature <Base64(rsa(sha256($Date)))>
```

An example reply:

```
HTTP/1.1 200 OK
Location: /pivtokens/97496DD1C8F053DE7450CD854D9C95B4/pin
Content-Type: application/json
Content-Length: 2231
Date: Thu, 13 Feb 2019 02:11:33 GMT
Api-Version: 1.0
Request-Id: 57e46450-ab5c-6c7e-93a5-d4e85cd0d6ef
Response-Time: 1

{
    "model": "Yubico YubiKey 4",
    "serial": "5213681",
    "cn_uuid": "15966912-8fad-41cd-bd82-abe6468354b5",
    "guid": "97496DD1C8F053DE7450CD854D9C95B4",
    "pin": "123456",
    "pubkeys": {
       "9e": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9d": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...",
       "9a": "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA..."
    },
    "attestation": {
       "9e": "-----BEGIN CERTIFICATE-----....",
       "9d": "-----BEGIN CERTIFICATE-----....",
       "9a": "-----BEGIN CERTIFICATE-----....."
    }
}
```

### DeletePivtoken (DELETE /pivtokens/:guid)

Deletes information about a PIV token.  This would be called during the
decommission process of a CN.  The request is authenticated using the 9e
key of the PIV token.

Sample request:

```
DELETE /pivtokens/97496DD1C8F053DE7450CD854D9C95B4 HTTP/1.1
Host: kbmapi.mytriton.example.com
Accept: application/json
Authorization: Signature <Base64(rsa(sha256($Date)))>
Api-Version: ~1
Content-Length: 0
```

Sample response:

```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, Api-Version, Response-Time
Access-Control-Allow-Methods: GET, HEAD, POST, DELETE
Access-Control-Expose-Headers: Api-Version, Request-Id, Response-Time
Connection: Keep-Alive
Date: Thu, 21 Feb 2019 11:26:19 GMT
Server: Joyent KBMAPI 1.0.0
Api-Version: 1.0.0
Request-Id: f36b8a41-5841-6c05-a116-b517bf23d4ab
Response-Time: 997
```

Note: alternatively, an operator can manually run `kbmctl` to delete an entry.

A destroyed PIV token is automatically added to `token_history`.

### Recovery Tokens

In order to simplify the management of recovery tokens from the CN's where
recovery configurations are being staged or activated, convenience
end-points for recovery tokens and the PIV Token that the recovery tokens are
associated to.

All the recovery token requests are authenticated using the 9e key of the
PIVToken the recovery token(s) belong to.

Creating/updating recovery tokens have some rules regarding existing recovery
tokens for a given PIV Token:

- When a new recovery token is "created", if there is any existing recovery
  token for the same PIV Token which hasn't yet been staged or activated,
  it will be immediately expired.
- When a new recovery token is "staged", if there are any recovery
  tokens which haven't yet been staged, they will be immediately expired.
- When a new recovery token is "activated", if there are any existing
  recovery tokens which were active, they will be immediately expired.

### ListRecoveryTokens (GET /pivtokens/:guid/recovery-tokens)

List all the existing recovery tokens for the given PIV Token `:guid`.

Sample request:

```
GET /pivtokens/75CA077A14C5E45037D7A0740D5602A5/recovery-tokens
X-Request-Id: e287c376-3fbb-4f55-b10a-cb31e6ffc08d
Accept: application/json
User-Agent: restify/1.6.0 (x64-darwin; v8/5.1.281.111; OpenSSL/1.0.2r) node/6.17.1
Date: Wed, 06 Nov 2019 15:49:11 GMT
Host: kbmapi.mytriton.example.com
Authorization: Signature <Base64(rsa(sha256($Date)))>
Connection: close
---
{ guid: '75CA077A14C5E45037D7A0740D5602A5' }
```
Sample Response:

```
Content-Type: application/json
Content-Length: 573
X-Response-Time: 19
Server-Name: my.triton.server
Date: Wed, 06 Nov 2019 15:49:11 GMT
Connection: close
X-Request-Received: 1573055351322
X-Request-Processing-Time: 24

200 OK
---
[ { token: 'cd990dffcc5359096430645a1c5f4b8e90bdca1b4efabcc0a093434c8806e5e485720cfb69f61d32',
    created: '2019-11-06T15:49:11.101Z',
    expired: '2019-11-06T15:49:11.218Z',
    pivtoken: '75CA077A14C5E45037D7A0740D5602A5',
    recovery_configuration: 'f85b894e-d02c-5b1c-b2ea-0564ef55ee24',
    uuid: '9f8f4f79-7069-557d-a009-46cdb2a69c93' },
  { token: 'ca0dab3f5b936f6a97e98d9161b6fc3da2ab8c4f086ad286f9bdf296cbc5c9026d224fbd0b0d109e',
    created: '2019-11-06T15:49:11.218Z',
    pivtoken: '75CA077A14C5E45037D7A0740D5602A5',
    recovery_configuration: 'ff6d69c1-0af2-4441-9416-7bd8a9ec56fe',
    uuid: '03482e94-64b0-50d3-a858-23fdf3ff47f6' } ]
```

### CreateRecoveryToken (POST /pivtokens/:guid/recovery-tokens)

While the values for `token`, `uuid` (will be inferred from `token` otherwise),
`created` and `recovery_configuration` can be provided, the expected usage is
to just request the creation of a new recovery token which will use the currently
active recovery configuration.

Note that, when provided, the value for `token` is expected to be `base64` encoded.

When creating new tokens for later staging a new recovery configuration into a CN
where a token using the currently active recovery configuration, the new (not yet
active) `recovery_configuration` should be provided.

Sample Request:

```
POST /pivtokens/75CA077A14C5E45037D7A0740D5602A5/recovery-tokens
X-Request-Id: e287c376-3fbb-4f55-b10a-cb31e6ffc08d
Accept: application/json
Content-Type: application/json
User-Agent: restify/1.6.0 (x64-darwin; v8/5.1.281.111; OpenSSL/1.0.2r) node/6.17.1
Date: Wed, 06 Nov 2019 15:49:11 GMT
Content-Length: 2
Content-Md5: mZFLkyvTelC5g8XnyQrpOw==
Host: kbmapi.mytriton.example.com
Authorization: Signature <Base64(rsa(sha256($Date)))>
Connection: close
---
{ guid: '75CA077A14C5E45037D7A0740D5602A5' }
```

Sample Response:

```
Content-Type: application/json
Content-Length: 285
X-Response-Time: 18
Server-Name: my.triton.server
Date: Wed, 06 Nov 2019 15:49:11 GMT
Connection: close
X-Request-Received: 1573055351348
X-Request-Processing-Time: 24

201 Created
---
{ token: 'd115cecb97e90cdd26a7955778d09d13b4343ae4a46456fd855056df2cbee7ca4143d5c6d8a204a2',
  created: '2019-11-06T15:49:11.366Z',
  pivtoken: '75CA077A14C5E45037D7A0740D5602A5',
  recovery_configuration: 'ff6d69c1-0af2-4441-9416-7bd8a9ec56fe',
  uuid: '2e618395-eb6f-59d6-a817-cf972b4ad081' }
```

### GetRecoveryToken (GET /pivtokens/:guid/recovery-tokens/:uuid)

Get details for the given recovery token.

**Field**               | **Description**
------------------------|-----------------
pivtoken                | PIV token GUID
uuid                    | UUID of the recovery token
recovery\_configuration | UUID of the recovery configuration associated with the recovery token
token                   | The proper recovery token string, base64 encoded.
created                 | When the token was created
staged                  | Timestamp when the token was staged into the PIV token's associated CN
activated               | Timestamp for when the token was activated
expired                 | When the token has been replaced by a new one into the CN


Sample Request:

```
GET /pivtokens/75CA077A14C5E45037D7A0740D5602A5/recovery-tokens/2e618395-eb6f-59d6-a817-cf972b4ad081
X-Request-Id: e287c376-3fbb-4f55-b10a-cb31e6ffc08d
Accept: application/json
User-Agent: restify/1.6.0 (x64-darwin; v8/5.1.281.111; OpenSSL/1.0.2r) node/6.17.1
Date: Wed, 06 Nov 2019 15:49:11 GMT
Host: kbmapi.mytriton.example.com
Authorization: Signature <Base64(rsa(sha256($Date)))>
Connection: close
---
{ guid: '75CA077A14C5E45037D7A0740D5602A5',
  uuid: '2e618395-eb6f-59d6-a817-cf972b4ad081' }
```

Sample Response:

```
Content-Type: application/json
Content-Length: 285
X-Response-Time: 27
Server-Name: my.triton.server
Date: Wed, 06 Nov 2019 15:49:11 GMT
Connection: close
X-Request-Received: 1573055351377
X-Request-Processing-Time: 33

200 OK
---
{ token: 'd115cecb97e90cdd26a7955778d09d13b4343ae4a46456fd855056df2cbee7ca4143d5c6d8a204a2',
  created: '2019-11-06T15:49:11.366Z',
  pivtoken: '75CA077A14C5E45037D7A0740D5602A5',
  recovery_configuration: 'ff6d69c1-0af2-4441-9416-7bd8a9ec56fe',
  uuid: '2e618395-eb6f-59d6-a817-cf972b4ad081' }
```

### UpdateRecoveryToken (PUT /pivtokens/:guid/recovery-tokens/:uuid)

Modify the values for token's `staged`, `activated` and `expired`. Used to collect information
regarding when a recovery token has been staged or activated into a CN, or when it has been
superseded by another recovery token.

Sample Request:

```
PUT /pivtokens/75CA077A14C5E45037D7A0740D5602A5/recovery-tokens/2e618395-eb6f-59d6-a817-cf972b4ad081
X-Request-Id: e287c376-3fbb-4f55-b10a-cb31e6ffc08d
Accept: application/json
Content-Type: application/json
User-Agent: restify/1.6.0 (x64-darwin; v8/5.1.281.111; OpenSSL/1.0.2r) node/6.17.1
Date: Wed, 06 Nov 2019 15:49:11 GMT
Content-Length: 76
Content-Md5: fsZh6anm1pBXWAP9ZziqCg==
Host: kbmapi.mytriton.example.com
Authorization: Signature <Base64(rsa(sha256($Date)))>
Connection: close
---
{ guid: '75CA077A14C5E45037D7A0740D5602A5',
  uuid: '2e618395-eb6f-59d6-a817-cf972b4ad081',
  staged: '2019-11-06T15:49:11.411Z',
  activated: '2019-11-06T15:49:11.411Z' }
```

Sample Response:

```
Content-Type: application/json
Content-Length: 360
X-Response-Time: 29
Server-Name: my.triton.server
Date: Wed, 06 Nov 2019 15:49:11 GMT
Connection: close
X-Request-Received: 1573055351411
X-Request-Processing-Time: 35

200 OK
---
{ token: 'd115cecb97e90cdd26a7955778d09d13b4343ae4a46456fd855056df2cbee7ca4143d5c6d8a204a2',
  created: '2019-11-06T15:49:11.366Z',
  staged: '2019-11-06T15:49:11.411Z',
  activated: '2019-11-06T15:49:11.411Z',
  pivtoken: '75CA077A14C5E45037D7A0740D5602A5',
  recovery_configuration: 'ff6d69c1-0af2-4441-9416-7bd8a9ec56fe',
  uuid: '2e618395-eb6f-59d6-a817-cf972b4ad081' }
```

### DeleteRecoveryToken (DELETE /pivtokens/:guid/recovery-tokens/:uuid)

Remove a recovery token. Note this is not possible if the recovery token is active or staged. It needs
to be expired before.

Sample Request:

```
DELETE /pivtokens/75CA077A14C5E45037D7A0740D5602A5/recovery-tokens/2e618395-eb6f-59d6-a817-cf972b4ad081
X-Request-Id: e287c376-3fbb-4f55-b10a-cb31e6ffc08d
Accept: application/json
User-Agent: restify/1.6.0 (x64-darwin; v8/5.1.281.111; OpenSSL/1.0.2r) node/6.17.1
Date: Wed, 06 Nov 2019 15:49:11 GMT
Host: kbmapi.mytriton.example.com
Authorization: Signature <Base64(rsa(sha256($Date)))>
Connection: close
---
{ guid: '75CA077A14C5E45037D7A0740D5602A5',
  uuid: '2e618395-eb6f-59d6-a817-cf972b4ad081' }
```

Sample Response:

```
X-Response-Time: 18
Server-Name: my.triton.server
Date: Wed, 06 Nov 2019 15:49:11 GMT
Connection: close
X-Request-Received: 1573055351448
X-Request-Processing-Time: 23

204 No Content
---
```

### Recovery Configuration(s)

We need to support the following features related to recovery config propagation:
1. A mechanism to ensure that we do not push recovery config X until recovery
   config X-1 has been sucessfully activated on all consumers.
2. An override mechanism that allows recovery config X to be pushed to consumers
   before earlier configs are known to be active.
3. A means to test the most recent recovery config before activation across the
   general population.
4. The ability to not activate a recovery configuration that has been staged.

Which was translated into:
1. KBMAPI must maintain an inventory of where each configuration is present and
   whether it is staged or active. This inventory needs to be robust in the face
   of down or rebooting nodes at any point during the staging and activation
   phases.
2. There must be a way to unstage or replace a staged recovery configuration.
3. A mechanism for activating a staged configuration on a single compute node
   must exist.

Each configuration object contains a template, which is a base64 encoded string
created by the cmd `pivy-box template create -i <name> ...`.

Here is how a template is created using `pivy-box` interactive mode:


```bash=
$ pivy-box tpl create -i backup
-- Editing template --
Select a configuration to edit:

Commands:
  [+] add new configuration
  [-] remove a configuration
  [w] write and exit
Choice? +
Add what type of configuration?
  [p] primary (single device)
  [r] recovery (multi-device, N out of M)

Commands:
  [x] cancel
Choice? r
-- Editing recovery config 1 --
Select a part to edit:

Commands:
  [n] 0 parts required to recover data (change)
  [+] add new part/device
  [&] add new part based on local device
  [-] remove a part
  [x] finish and return
Choice? +
GUID (in hex)? E6FB45BDE5146C5B21FCB9409524B98C
Slot ID (hex)? [9D]
Key? ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBADLQ8fNp4/+aAg7S/nWrUU6nl3bd3eajkk7LJu42qZWu8+b218MspLSzpwv3AMnwQDaIhM7kt/HhXfYgiQXd30zYAC/xZlz0TZP2XHMjJoVq4VbwZfqxXXAmySwtm6cDY7tWvFOHlQgF3SofE5Fd/6gupHy59+3dtLKwZMMU1ewcPm8sg== kbmapi test one token
-- Editing part 1 --
Read-only attributes:
  GUID: E6FB45BDE5146C5B21FCB9409524B98C
  Slot: 9D
  Key: ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBADLQ8fNp4/+aAg7S/nWrUU6nl3bd3eajkk7LJu42qZWu8+b218MspLSzpwv3AMnwQDaIhM7kt/HhXfYgiQXd30zYAC/xZlz0TZP2XHMjJoVq4VbwZfqxXXAmySwtm6cDY7tWvFOHlQgF3SofE5Fd/6gupHy59+3dtLKwZMMU1ewcPm8sg==

Select an attribute to change:
  [n] Name: (null)
  [c] Card Auth Key: (none set)

Commands:
  [x] finish and return
...
```

This is the final result, after adding several keys to the recovery config:

```bash=
$ pivy-box tpl show backup
-- template --
version: 1
configuration:
  type: recovery
  required: 2 parts
  part:
    guid: E6FB45BDE5146C5B21FCB9409524B98C
    name: xk1
    slot: 9D
    key: ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBADLQ8fNp4/+aAg7S/nWrUU6nl3bd3eajkk7LJu42qZWu8+b218MspLSzpwv3AMnwQDaIhM7kt/HhXfYgiQXd30zYAC/xZlz0TZP2XHMjJoVq4VbwZfqxXXAmySwtm6cDY7tWvFOHlQgF3SofE5Fd/6gupHy59+3dtLKwZMMU1ewcPm8sg==
  part:
    guid: 051CD9B2177EB12374C798BB3462793E
    name: xk2
    slot: 9D
    key: ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBAA6H1gT8uJBMc7mknW7Wi0M2/2x/65lKZy9DLM9x60pU6wt8KsBI2PKJoUY/7Jq6dyIRckVzNh15z78agjshPu9aQHiKVRn8lEbNTuAuCr6NbEx62yQbAamf85qpQMaUT47hjHhP5srMMGb7cjBTCO1rTsVOxYcIc7bmnLEy69nRmpxaA==
  part:
    guid: D19BE1E0660AECFF0A9AF617540AFFB7
    name: xk3
    slot: 9D
    key: ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBABrFyNJvVBr80bWBE9Df/b/GOnIypNxURgD0D64Nt7iT6oF163shFWLXJ04TPPSAgSX57/8e7lohol9pSczXMQaQQGaefYZKMfUvyeXpcNsu1m47axaq/HwKpwGGW0LgQ2VZQhWDQjDPP8Yr3s/krNXoV/ArwWJT7HwHocL5y7eN4TUcQ==
```

Here is how to get the values used by KBMAPI for a given template:

```javascript=
const crypto = require('crypto');
const fs = require('fs');
const input = fs.readFileSync('/path/to/.ebox/tpl/name');
// This is the template:
input.toString();
// => '6wwBAQECAgMBCG5pc3RwNTIxQwIAy0PHzaeP/mgIO0v51q1FOp5d23d3mo5JOyybu\nNqmVrvPm9tfDLKS0s6cL9wDJ8EA2iITO5Lfx4V32IIkF3d9M2AEEOb7Rb3lFGxbIf\ny5QJUkuYwCA3hrMQABCG5pc3RwNTIxQwIAOh9YE/LiQTHO5pJ1u1otDNv9sf+uZSm\ncvQyzPcetKVOsLfCrASNjyiaFGP+yaunciEXJFczYdec+/GoI7IT7vWkEEAUc2bIX\nfrEjdMeYuzRieT4CA3hrMgABCG5pc3RwNTIxQwMAaxcjSb1Qa/NG1gRPQ3/2/xjpy\nMqTcVEYA9A+uDbe4k+qBdet7IRVi1ydOEzz0gIEl+e//Hu5aIaJfaUnM1zEGkEEEN\nGb4eBmCuz/Cpr2F1QK/7cCA3hrMwA=\n'
const hash = crypto.createHash('sha512');
hash.update(input.toString());
// And this is the hash value, used as identifier:
hash.digest('hex')
// => 'f85b894ed02cbb1c32ea0564ef55ee2438a86c5a4988ca257dd7c71953f349d9cf0472838099967d9ec4ca15603efad17f6ac6b3f434c9080f99d6f2041799d7'
// Instead of the hash (or together with), we can also generate a UUID
// using the following procedure:
var buf = hash.digest();
// variant:
buf[8] = buf[8] & 0x3f | 0xa0;
// version:
buf[6] = buf[6] & 0x0f | 0x50;
var hex = buf.toString('hex', 0, 16);
var uuid = [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32)
].join('-');
```

### Recovery configurations lifecycle

Recovery configurations will go through a Finite State Machine during their
expected lifecycles. The following are the definitions of all the possible
states for recovery configurations:

* `new`: This state describes the raw parameters for the recovery configuration
  (mostly `template`) before the HTTP request to create the recovery
  configuration record in KBMAPI has been made.
* `created`: Once the recovery configuration has been created into KBMAPI
  through the HTTP request to `POST /recovery_configurations`. The recovery
  configuration now has a unique `uuid`, the attribute `created` has been added.
  The process to stage this configuration through encrypted Compute Nodes needs
  an additional HTTP request (usually triggered by `kbmctl recovery stage`)
* `staged`: The recovery configuration has been spread across encrypted Compute
  Nodes (or at least to all encrypted Compute Nodes available at the moment we
  made the previous HTTP request). Confirmation has been received by KBMAPI that
  the _"staging"_ process has been finished.
* `active`: The request to activate the configuration across all the CNs where it
  has been previously staged has been sent to KBMAPI. The transition from
  `staged` to `active` will take some time. We need to keep track of the
  transition until it finishes.
* `expired`: When a given recovery configuration has been replaced by some other
  and we no longer care about it being deployed across the different encrypted
  Compute Nodes. This stage change for recovery configurations is a side effect
  of another configuration transitioning to `active`.


```
                                          +-----------+
                            +-------------| unstaging |--------------+
                            |             +-----------+              |
                            |                              unstage() |
                            v                                        |
    +------+   POST    +---------+   stage() +---------+        +--------+
    | new  | --------> | created | --------> | staging | -----> | staged |
    +------+           +---------+           +---------+        +--------+
                           ^                                        |  ^
             reactivate()  |                                        |  |
       +-------------------+                             activate() |  |
       |                                                            |  |
  +---------+   expire() +---------+         +-------------+        |  |
  | expired | <--------- | active  |  <----- |  activating | <------+  |
  +---------+            +---------+         +-------------+           |
       |                     |                                         |
       | destroy()           |  deactivate()   +--------------+        |
       v                     +---------------> | deactivating |--------+
  +---------+                                  +--------------+
  | removed |
  +---------+
```

While there is an `expired` state, a given recovery configuration can only reach
such state when another one has been activated. There's no value in keeping
around an "expired" recovery configuration other than allowing operators to
reuse the same configuration several times without having to remove previous
records due to the requirement for UUID uniqueness and the way it's generated
through template hash. This configuration needs to be re-staged to all the CNs
again, exactly the same way as if it were a new one.

A persistent cache is used by the process that is currently orchestrating state
transitions. This allows:
- Recovery from CNAPI being down either at the beginning or in the middle of a
  transition.
- Recovery from KBMAPI going down in the middle of a transition.
- The ability to provide information regarding a transition not only to the
  client which initiated the process with an HTTP request, but to any other
  client instance, due to console sessions finishing abruptly or just for
  convenience.

This persistent cache will store, for each transition, the following
information:
- The recovery configuration this transition belongs to.
- List of CNs/PIV Tokens to take part in the transition process (it will
  be just the encrypted Compute Nodes which are running at the moment the
  transition has been started)
- List of CNs where the transition has been completed and, in case of failure,
  as much information as possible regarding such failures.
- List of `taskid` for each CN where the transition is in progress. These will
  match with `taskid` for cn-agent into each CN which can be accessed through
  CNAPI using either `GET /tasks/:task_id` or `GET /tasks/:task_id/wait`.
- An indicator of whether or not the transition has been aborted.
- An indicator of whether or not the transition is running.

KBMAPI provides:
- A process to orchestrate (run) the transitions (backed up by a SMF service)
- An end-point to watch transitions progress.

We will have a moray bucket called `kbmapi_recovery_configs` with the following
JSON config:

```json=
{
    "desc": "Recovery configuration templates",
    "name": "kbmapi_recovery_configs",
    "schema": {
        "index": {
            "uuid": { "type": "uuid", "unique": true },
            "hash": { "type": "string", "unique": true },
            "template": { "type": "string" },
            "created": {"type": "date"},
            "staged": {"type": "date"},
            "activated": {"type": "date"},
            "expired": {"type": "date"}
        }
    }
}
```

We may want to keep a list of configurations for historical purposes.

The persistent transition cache will be stored into another moray bucket with
the following structure:

```json=
{
    "desc": "Recovery configuration transitions",
    "name": "kbmapi_recovery_config_transitions",
    "schema": {
        "index": {
            "recovery_config_uuid": { "type": "uuid" },
            "name": { "type": "string" },
            "targets" : {"type": ["uuid"] },
            "completed" : {"type": ["uuid"] },
            "wip": { "type": ["uuid"] },
            "taskids": { "type": ["string"] },
            "concurrency": { "type": "integer" },
            "locked_by": { "type": "uuid" },
            "aborted": {"type": "boolean"}
        }
    }

}
```

Where `targets` is the collection of CNs which need to be updated, `completed`
is the list of those we're already done with, `wip` are the ones we're
modifying right now and `taskids` are the CNAPI's provided `taskid` for each
one of the CNs included in `wip` so we can check progress of such tasks using
CNAPI. `locked_by` is the UUID of the `kbmtr` process which is currently
orchestrating the transition.

#### End-points

KBMAPI needs end-points to support the following command:

```
kbmctl recovery <add|show|list|activate|deactivate|stage|unstage|remove>
```

The following end-point and routes will be created:

 - HTTP Resource `/recovery_configs`:
     - `GET /recovery_configs` (ListRecoveryConfigs)
     - `POST /recovery_configs` (AddRecoveryConfig)
     - `GET /recovery_configs/:uuid` (ShowRecoveryConfig)
     - `PUT /recovery_configs/:uuid?action=stage` (StageRecoveryConfig)
     - `PUT /recovery_configs/:uuid?action=unstage` (UnstageRecoveryConfig)
     - `PUT /recovery_configs/:uuid?action=activate` (ActivateRecoveryConfig)
     - `PUT /recovery_configs/:uuid?action=deactivate` (DeactivateRecoveryConfig)
     - `GET /recovery_configs/:uuid?action=watch` (WatchRecoveryConfigTransition)
     - `DELETE /recovery_configs/:uuid` (RemoveRecoveryConfig)


### AddRecoveryConfig (POST /recovery_configs)

| Field      | Required | Description |
| ---------- | -------- | ----------- |
| template   |  Yes     | Base64 encoded recovery configuration template.|
| concurrency|  No      | Number of ComputeNodes to update concurrently (default 10).|
| force      |  No      | Boolean, allow the addition of a new recovery config even if the latest one hasn't been staged (default false). |
| stage      |  No      | Boolean, automatically proceed with the staging of the recovery configuration across all encrypted Compute Nodes without waiting for the HTTP request for `stage`.|


### WatchRecoveryConfigTransition (GET /recovery_configs/:uuid?action=watch&transition=\<name\>)

| Field      | Required | Description |
| ---------- | -------- | ----------- |
| uuid       |  Yes     | The uuid of the recovery configuration to watch.|
| transition |  Yes     | The name of the transition to watch for the given config.|

Watch the transition from one recovery config state to the next one in the FSM.

This end-point will provide details regarding the transition progress using a
JSON Stream of CNs which are or have already completed the transition, together
with an eventual error message in case the transition failed for any of these
CNs. When the transition has finished for all the CNs a final `END` event will
be sent and the connection will be closed.

The format of these `Transition Progress Events` is still TBD.

In case a configuration has already finished the given transition, the stream
will be automatically closed right after the first response has been sent.

### ListRecoveryConfigs (GET /recovery_configs)

Get a list of recovery configurations. Note that both, this and the
ShowRecoveryConfig end-points will grab all the existing PIV tokens in KBMAPI
and provide a counter of how many PIV tokens are using each config.
Additionally, the show recovery config will provide the uuids (hostnames too?)
of the CNs using a given recovery configuration.

### ShowRecoveryConfig (GET /recovery_configs/:uuid)

| Field      | Required | Description |
| ---------- | -------- | ----------- |
| uuid       |  Yes     | The uuid of the recovery configuration to retrieve.|

This returns a JSON object containing the selected recovery configuration. This
is a JSON object like:

```json=
{
    "uuid": "f85b894e-d02c-5b1c-b2ea-0564ef55ee24",
    "template": "AAAewr22sdd...",
    "hash": "0123456789abcdef",
    "created": "ISO 8601 Date",
    ["activated": "ISO 8601 Date",]
    ["expired": "ISO 8601 Date",]
}
```

### StageRecoveryConfig (PUT /recovery_configs/:uuid?action=stage)

| Field      | Required | Description |
| ---------- | -------- | ----------- |
| uuid       |  Yes     | The uuid of the recovery configuration to stage.|
| concurrency|  No      | Number of ComputeNodes to update concurrently (default 10).|
| pivtoken   |  No      | In case we want to stage this configuration just for a given pivtoken (on a given Compute Node)|

Note that in case `pivtoken` guid is provided, the recovery configuration state
will not change.

### UnstageRecoveryConfig (PUT /recovery_configs/:uuid?action=unstage)

| Field      | Required | Description |
| ---------- | -------- | ----------- |
| uuid       |  Yes     | The uuid of the recovery configuration to unstage.|
| concurrency|  No      | Number of ComputeNodes to update concurrently (default 10).|
| pivtoken   |  No      | In case we want to unstage this configuration just for a given pivtoken (on a given Compute Node)|

Note that in case `pivtoken` guid is provided, the recovery configuration state
will not change.

### ActivateRecoveryConfig (PUT /recovery_configs/:uuid?action=activate)

| Field      | Required | Description |
| ---------- | -------- | ----------- |
| uuid       |  Yes     | The uuid of the recovery configuration to activate.|
| concurrency|  No      | Number of ComputeNodes to update concurrently (default 10).|
| pivtoken   |  No      | In case we want to activate this configuration just for a given pivtoken (on a given Compute Node)|

Note that in case `pivtoken` guid is provided, the recovery configuration state
will not change.

### DeactivateRecoveryConfig (PUT /recovery_configs/:uuid?action=deactivate)

| Field      | Required | Description |
| ---------- | -------- | ----------- |
| uuid       |  Yes     | The uuid of the recovery configuration to deactivate.|
| concurrency|  No      | Number of ComputeNodes to update concurrently (default 10).|
| pivtoken   |  No      | In case we want to deactivate this configuration just for a given pivtoken (on a given Compute Node)|

Note that in case `pivtoken` guid is provided, the recovery configuration state
will not change.

### RemoveRecoveryConfig (DELETE /recovery_configs/:uuid)

| Field      | Required | Description |
| ---------- | -------- | ----------- |
| uuid.      |  Yes     | The uuid of the recovery configuration to remove.|

Only a recovery configuration that isn't in use by any CN can be removed.

#### Other notes

Note that we need at least one **recovery config** for everything to work
properly. We'll need to figure out a way to provide such configuration either
during initial headnode setup or during initial kbmapi install ...

A recovery configuration must be activated before the first encrypted CN can be
set up. If a recovery configuration is not present, any attempt to create a
PIVToken will give the following error:

    Invalid Parameters Error: cannot create a PIVToken without a valid recovery configuration


## Inventory: Recovery Configs associated with PIV tokens

The list of PIV Tokens stored by KBMAPI can be used as a cache of which
configurations are present into each encrypted Compute Node. Each one of these
PIV tokens have one or more recovery tokens associated with a given recovery
configuration.

For example, for a CN with UUID `15966912-8fad-41cd-bd82-abe6468354b5` which has
been created when a recovery configuration with hash `f85b894ed0...` was active,
we'll initially have the following object with one associated recovery token:

```
{
    "model": "Yubico YubiKey 4",
    "serial": "5213681",
    "cn_uuid": "15966912-8fad-41cd-bd82-abe6468354b5",
    "guid": "97496DD1C8F053DE7450CD854D9C95B4",
    "pin": "123456",
    "recovery_tokens": [{
        "created": 123456789,
        "activated": 123456789,
        "token": "jmzbhT2PXczgber9jyOSApRP337gkshM7EqK5gOhAcg...",
        "config": "recovery config template ..."
    }],
    "pubkeys": {
       "9e": "...",
       "9d": "...",
       "9a": "..."
    },
    "attestation": {
       "9e": "....",
       "9d": "....",
       "9a": "...."
    }
}
```

Note that in this initial case, the values for `recovery_tokens[0].created` and
`recovery_tokens[0].activated` are the same, because this is the value we used
for the initial CN setup.

If we have the need to generate another recovery token for this same PIV token,
while the same configuration object is active, we'll have the following
modification to the PIV token's `recovery_tokens` member:

```
{
    "cn_uuid": "15966912-8fad-41cd-bd82-abe6468354b5",
    "guid": "97496DD1C8F053DE7450CD854D9C95B4",
    ...,
    "recovery_tokens": [{
        "created": 123456789,
        "activated": 123456789,
        "expired": 134567890,
        "token": "jmzbhT2PXczgber9jyOSApRP337gkshM7EqK5gOhAcg...",
        "config": "recovery config template ..."
    }, {
        "created": 134567890,
        "activated": 134567890,
        "token": "ecf1fc337276047347c0fdb167fb241b89226f58c95d...",
        "config": "another recovery config template ..."
    }],
    ...
}
```

The moment the new recovery\_token has been activated, the previous one will be
expired.

Then, when we add a new recovery configuration, a new recovery token will be
added to each KBMAPI's PIV token and this information will be stored into the CN
too. We'll call this latest recovery token to be _"staged"_.

```
{
    "cn_uuid": "15966912-8fad-41cd-bd82-abe6468354b5",
    "guid": "97496DD1C8F053DE7450CD854D9C95B4",
    ...,
    "recovery_tokens": [{
        "created": 123456789,
        "activated": 123456789,
        "expired": 134567890,
        "token": "jmzbhT2PXczgber9jyOSApRP337gkshM7EqK5gOhAcg...",
        "config": "recovery config template ..."
    }, {
        "created": 134567890,
        "activated": 134567890,
        "token": "ecf1fc337276047347c0fdb167fb241b89226f58c95d...",
        "config": "another recovery config template ..."
    }, {
        "created": 145678901,
        "token": "aff4fbb14b3de5c7e9986...",
        "config": "yet another recovery config template ..."
    }],
    ...
}
```

Once we activate a recovery configuration already staged into all our active
encrypted Compute Nodes, each CN will update its local information accordingly
and the KBMAPI's PIV token object will look as follows:

```
{
    "cn_uuid": "15966912-8fad-41cd-bd82-abe6468354b5",
    "guid": "97496DD1C8F053DE7450CD854D9C95B4",
    ...,
    "recovery_tokens": [{
        "created": 134567890,
        "activated": 134567890,
        "expired": 145678911,
        "token": "ecf1fc337276047347c0fdb167fb241b89226f58c95d...",
        "config": "another recovery config template ..."
    }, {
        "created": 145678901,
        "activated": 145678911,
        "token": "aff4fbb14b3de5c7e9986...",
        "config": "yet another recovery config template ..."
    }],
    ...
}
```

There is no need to keep more than the recovery tokens associated with the
currently active and staged configurations. Previous recovery tokens can be
removed as part of the process of adding/activating a new one, given the
information they provide will be useless at this point and in the future.

#### Implementation details

In order to provide reasonable search options for client applications trying to
figure out which recovery configuration is active or staged into each Compute
Node, storing the recovery tokens as an array within the PIV Tokens moray bucket
is not the better approach. Instead, we'll use a specific bucket where we'll
save each token's properties and references to the PIV token that owns the
recovery token, and the recovery configuration used for that token.


```json=
{
    "desc": "Recovery tokens",
    "name": "kbmapi_recovery_tokens",
    "schema": {
        "index": {
            "pivtoken_uuid": { "type": "uuid" },
            "configuration_uuid": { "type": "uuid" }
            "token": { "type": "string"},
            "created": {"type": "string"},
            "activated": {"type": "string"},
            "expired": {"type": "string"}
        }
    }
}
```

These recovery tokens will then be fetched from the PIV tokens model and loaded
sorted by `created` value.

For new recovery config `staging` the CNs will be interested in the recovery
config hash and template so those values should be provided together with the
recovery token in order to avoid the need for another HTTP request.

For other actions like `activate`, `cancel`, `remove` ... the recovery config
uuid would do just fine (or the hash, since it can also be used to refer the
same resource).

### Inventory Update

During the add/activate new config phase we keep inventory just waiting for each
addition/activation/removal (... whatever the KBMAPI task) to be completed.

```
+--------+  Add recovery cfg task  +-------+  run task  +----------+
| KBMAPI | ----------------------> | CNAPI | ---------> | cn-agent |--+
+--------+                         +-------+            +----------+  |
     ^   provide taskid to           |  ^   provide information       |
     |   wait for completion         |  |   about task progress       |
     +-------------------------------+  +-----------------------------+
```

Here, the "add recovery config" CN-Agent task consists of:

- Either we'll send the recovery\_token's details when we call the `POST
  /servers/:server_uuid/recovery_config` end-point, or we'll let the cn\_agent
  know that it has to perform an HTTP request to `POST /pivtokens/:guid`
  authenticated with the `9e` key of the YubiKey attached to the CN in order to
  retrieve such information. Let's assume at first that the simplest path will
  be used and, in order to save the extra HTTP request for each one of the CN
  agents, we'll provide the information on the original HTTP request to CNAPI.
  Params: `recovery token`, `hash`, `PIV token guid`, `action`
  (`add|activate|...`).
- The cn\_agent will store then the values for the new recovery config and the
  new recovery token.
- The cn\_agent will refresh local sysinfo to include the information about the
  new config hash.
- KBMAPI will wait for task completion.


```
             HTTP Request /pivtokens/:cn_uuid/pin.
             This is an HTTP Signature signed request
+----------+   Tusing 9e key from YubiKey.                +--------+
| cn-agent | -------------------------------------------> | KBMAPI |<-+
+----------+ <------------------------------------------  +--------+  |
     |         PIV token including recovery tokens.                   |
     |                                                                ^
     v                                                                |
Compare local config and token                                        |
against received information.      |  Once the task has been finished ^
In case of differences, init a new |  update PIV token in KBMAPI      |
"recovery config" related task.    |------->------>------>------->----+
```

Note this task will be executed only when cn-agent detects that it's running at
a server where EDAR is in use (encrypted zpool information, available from
sysinfo).

This approach has no issues with a possible flow or concurrent requests to
either CNAPI or KBMAPI from the different cn-agents, since the tasks will run in
batches of configurable number of CNs and we'll wait for completion, using a
known size queue.


### Development status (v1.x pending)

- `token_serial` bucket needs to be created and end-point to access PIV tokens
  serial should be provided.
- SAPI configuration for attestation is not present and none of the associated
  functionalities implemented.


#### Other action items
- Provide access to a given PIV Token using CN's UUID in order to make possible
  for a cn-agent task to run on CN boot to perform a verify request against
  KBMAPI. Consider using `GET /pivtokens?uuids=[]` list of CN's UUIDs in a
  similar way to what CNAPI does for these searches.
- Implement `PUT /tokens/:guid` to allow updates of some PIV Token CN UUID.
