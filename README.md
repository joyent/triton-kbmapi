<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2020 Joyent, Inc.
-->

# triton-kbmapi: Key backup and management service

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md) --

## Development

This is a Work In Progress. Some of the RFD specifications may be not
yet implemented. Please check docs directory for more details regarding
current and future development plans.

To build the project:

    make all

### Using YubiKeys from COAL

In order to be able to use a YubiKey from COAL the following properties need
to be added to the `.vmx` file of the VM we want to use it:

```
usb.generic.allowHID = "TRUE"
usb.generic.allowLastHID = "TRUE"
```

These files are usually `netboot.vmx` for Compute Node COAL images and
`USB-headnode.vmx` of the SDC Headnode.

The file `coal/coal-computenode.vmwarevm.14.tbz2` added to sdc-headnode.git
repository already contains all the aforementioned modifications.

Once these lines have been added there will be two available options for a
given pivy-tool:

```
Shared Yubico YubiKey OTP+FIDO+CCID
Yubico.com YubiKey OTP+FIDO+CCID
```

You need to pick the one without "Shared". It will say that the YubiKey will
not be useable by the system during the time it's being user by the guest OS,
which is exactly what we need.

Also, note that by design a YubiKey needs to go through a factory reset in
order to be useable as CN key for KBMAPI.

You'll need to do something like lock both PIN and PUK before you can call
`pivy-tool factory-reset`. (Can lock by running `pivy-tool change-pin` entering
a wrong value 3 times and `pivy-tool change-puk` another 3 times). Note you
may need to un-plug/plug the YK once the factory reset is complete.

The reason for this is that the idea with how kbmapi sets it up, is once it
initializes the YK, it has it generate all the keys, and then it discards the
admin key and puk (which is different from the pin) to effectively seal the YK
(i.e. can't make any changes after setup).

## Test

    make test

Note you need PostgreSQL installed on the machine you're running the tests from
due to [node-moray-sandbox](https://github.com/joyent/node-moray-sandbox). See
that repo's README for the details.

Unit tests can also run with:

    npm run-script test

and a similar command can be used to run tests with code coverage:

    npm run-script coverage

Given there are some warnings being printed out by one of the dependencies,
another way to run the whole set of unit tests including code coverage is

    make test 2> /dev/null

then, getting code coverage results is as simple as:

    open coverage/lcov-report/index.html

## Installation

The easiest way is to upgrade sdcadm to an experimental image containing the
KBMAPI install code:

    sdcadm self-update

Then run the KBMAPI post-setup:

    sdcadm post-setup kbmapi

That should grab that most recently built KBMAPI image.  Once that completes,
you should have a kbmapi0 zone on your HN.

## Updates

You should be able to update using sdcadm:

    sdcadm update kbmapi

## Uninstall

Use this at your own risk!

    scp tools/obliterate-kbmapi-service.sh headnode:/var/tmp
    ssh headnode touch /lib/sdc/.sdc-test-no-production-data
    ssh headnode /var/tmp/obliterate-kbmapi-service.sh

## Documentation

To update docs, edit "docs/README.md" and run `make docs` if necessary in order
to update the Table of Contents.

## License

"triton-kbmapi" is licensed under the
[Mozilla Public License version 2.0](http://mozilla.org/MPL/2.0/).
See the file LICENSE.
