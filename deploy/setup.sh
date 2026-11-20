#!/bin/sh
# Create the state directories of the three services with the ownership the
# containers expect, and the internal network sandboxes attach to.
# Usage (as root): PHEROMILL_HOME=/var/lib/pheromill sh deploy/setup.sh
set -eu

home="${PHEROMILL_HOME:-/var/lib/pheromill}"
for directory in control spool runner runner/work runner/grants egress; do
  mkdir -p "$home/$directory"
done
chown -R 10001:10001 "$home"
chmod 700 "$home/control" "$home/egress" "$home/runner/grants"

docker network inspect pheromill-sandbox >/dev/null 2>&1 || docker network create --internal pheromill-sandbox
echo "State directories ready under $home; network pheromill-sandbox exists."
