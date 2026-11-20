#!/bin/sh
# The single command that proves a change: install, lint, type-check, test
# (including holdout/), build, and any product gate (accessibility, SEO,
# performance budget). It must exit non-zero on any failure.
#
# It fails until you replace it: an empty verify would let anything merge.
echo "scripts/verify.sh is not defined yet. Replace it with the checks that prove a change." >&2
exit 1
