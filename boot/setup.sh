#!/usr/bin/bash
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

PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

role=kbmapi
CONFIG_AGENT_LOCAL_MANIFESTS_DIRS=/opt/smartdc/$role

echo "Finishing setup of $role zone"

# Include common utility functions (then run the boilerplate)
source /opt/smartdc/boot/lib/util.sh
sdc_common_setup

# Cookie to identify this as a SmartDC zone and its role
mkdir -p /var/smartdc/$role

# Add build/node/bin and node_modules/.bin to PATH
echo "" >>/root/.profile
echo "export PATH=\$PATH:/opt/smartdc/$role/build/node/bin:/opt/smartdc/$role/node_modules/.bin:/opt/smartdc/$role/bin" >>/root/.profile

echo "Adding log rotation"
#sdc_log_rotation_add amon-agent /var/svc/log/*amon-agent*.log 1g
sdc_log_rotation_add config-agent /var/svc/log/*config-agent*.log 1g
sdc_log_rotation_add registrar /var/svc/log/*registrar*.log 1g
sdc_log_rotation_add $role /var/svc/log/*$role*.log 1g
sdc_log_rotation_add kbmtr /var/svc/log/*kbmtr*.log 1g
sdc_log_rotation_setup_end

# Add metricsPorts metadata for cmon-agent discovery
#mdata-put metricPorts 8881

# Grab SDC application ssh keys to be used later by kbmctl
SAPI_URL=$(/usr/bin/json -f /opt/smartdc/config-agent/etc/config.json sapi.url)
METADATA=$(curl -s $SAPI_URL/applications?name=sdc|json -H 0.metadata)
mkdir -p /opt/smartdc/$role/etc
# Create private/public key files
/opt/local/bin/printf "$(echo ${METADATA} | json SDC_PUBLIC_KEY)" > /opt/smartdc/$role/etc/sdc_key.pub
/opt/local/bin/printf "$(echo ${METADATA} | json SDC_PRIVATE_KEY)" > /opt/smartdc/$role/etc/sdc_key

# Add cmdline completion for `kbmctl`:
/opt/smartdc/$role/bin/kbmctl completion >> /etc/bash/bash_completion.d/kbmctl
echo "" >>/root/.profile
echo "source '/etc/bash/bash_completion.d/kbmctl'" >>/root/.profile

# All done, run boilerplate end-of-setup
sdc_setup_complete

exit 0
