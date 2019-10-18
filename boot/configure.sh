#!/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2019 Joyent, Inc.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

echo "Importing kbmapi SMF manifest"
/usr/sbin/svccfg import /opt/smartdc/kbmapi/smf/manifests/kbmapi.xml

echo "Enabling kbmapi service"
/usr/sbin/svcadm enable smartdc/application/kbmapi

echo "Importing kbmtr SMF manifest"
/usr/sbin/svccfg import /opt/smartdc/kbmapi/smf/manifests/kbmtr.xml

# echo "Enabling kbmtr service"
# /usr/sbin/svcadm enable smartdc/application/kbmtr
exit 0
