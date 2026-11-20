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

# Sandboxes reach the outside only through the egress service. A network of
# this name that is not internal would give them a direct route: refuse it.
if docker network inspect pheromill-sandbox >/dev/null 2>&1; then
  internal="$(docker network inspect --format '{{.Internal}}' pheromill-sandbox)"
  if [ "$internal" != "true" ]; then
    echo "The network pheromill-sandbox exists and is not internal. Remove it (docker network rm pheromill-sandbox) and run this script again." >&2
    exit 1
  fi
else
  docker network create --internal pheromill-sandbox
fi
echo "State directories ready under $home; network pheromill-sandbox is internal."
