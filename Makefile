#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2020 Joyent, Inc.
#

#
# KBMAPI Makefile
#

NAME		:= kbmapi

#
# Tools
#

NYC	:= node_modules/.bin/nyc
FAUCET		:= node_modules/.bin/faucet

#
# Configuration used by Makefile.defs and Makefile.targ to generate
# "check" and "docs" targets.
#
DOC_FILES	= index.md
JSON_FILES	= package.json
ESLINT_FILES	:= $(shell find lib client test -name '*.js')
ESLINT		= ./node_modules/.bin/eslint


#
# Configuration used by Makefile.smf.defs to generate "check" and "all" targets
# for SMF manifest files.
#
SMF_MANIFESTS_IN	= smf/manifests/kbmapi.xml.in smf/manifests/kbmtr.xml.in

#
# Makefile.defs defines variables used as part of the build process.
#

ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_VERSION =	v6.17.0
	NODE_PREBUILT_IMAGE = 7f4d80b4-9d70-11e9-9388-6b41834cbeeb
	NODE_PREBUILT_TAG := zone64
else
	NPM=npm
	NODE=node
	NPM_EXEC=$(shell which npm)
	NODE_EXEC=$(shell which node)
endif

ENGBLD_USE_BUILDIMAGE	= true
ENGBLD_REQUIRE		:= $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
	include ./deps/eng/tools/mk/Makefile.agent_prebuilt.defs
endif
include ./deps/eng/tools/mk/Makefile.smf.defs

ROOT		:= $(shell pwd)
RELEASE_TARBALL	:= $(NAME)-pkg-$(STAMP).tar.gz
RELSTAGEDIR	:= /tmp/$(NAME)-$(STAMP)

# triton-origin-x86_64-19.2.0
BASE_IMAGE_UUID = a0d5f456-ba0f-4b13-bfdc-5e9323837ca7
BUILDIMAGE_NAME = $(NAME)
BUILDIMAGE_DESC = Triton Key Backup and Management
AGENTS		= config registrar

PATH		:= $(NODE_INSTALL)/bin:/opt/local/bin:${PATH}

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NPM_EXEC) sdc-scripts
	$(NPM) install

$(NYC): | $(NPM_EXEC)
	$(NPM) install

$(FAUCET): | $(NPM_EXEC)
	$(NPM) install

CLEAN_FILES += ./node_modules/tape

.PHONY: test
test: $(NYC) $(FAUCET)
	$(NPM) run coverage | $(FAUCET)

#
# Packaging targets
#

.PHONY: release
release: check all $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)
	@mkdir -p $(RELSTAGEDIR)/site
	@touch $(RELSTAGEDIR)/site/.do-not-delete-me
	cp -r $(ROOT)/server.js \
		$(ROOT)/transitioner.js \
		$(ROOT)/kbmctl.js \
		$(ROOT)/bin \
		$(ROOT)/client \
		$(ROOT)/lib \
		$(ROOT)/node_modules \
		$(ROOT)/package.json \
		$(ROOT)/sapi_manifests \
		$(ROOT)/sbin \
		$(ROOT)/smf \
		$(ROOT)/test \
		$(ROOT)/build \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(ROOT)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(ROOT)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -PR $(NODE_INSTALL) $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build
	(cd $(RELSTAGEDIR) && $(TAR) -I pigz -cf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)

.PHONY: publish
publish: release
	@if [[ -z "$(ENGBLD_BITS_DIR)" ]]; then \
	  echo "error: 'ENGBLD_BITS_DIR' must be set for 'publish' target"; \
	  exit 1; \
	fi
	mkdir -p $(ENGBLD_BITS_DIR)/$(NAME)
	cp $(ROOT)/$(RELEASE_TARBALL) $(ENGBLD_BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)

#
# Target definitions.  This is where we include the target Makefiles for
# the "defs" Makefiles we included above.
#

include ./deps/eng/tools/mk/Makefile.deps

ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
	include ./deps/eng/tools/mk/Makefile.agent_prebuilt.targ
endif
include ./deps/eng/tools/mk/Makefile.smf.targ
include ./deps/eng/tools/mk/Makefile.targ

sdc-scripts: deps/sdc-scripts/.git
