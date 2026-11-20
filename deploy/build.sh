#!/bin/sh
# Build the factory image from a digest-pinned base and print its identifier.
# Usage: BASE_IMAGE=node@sha256:<digest> sh deploy/build.sh
set -eu

: "${BASE_IMAGE:?Set BASE_IMAGE to a digest-pinned image with Node.js 22+ and git 2.38+ (name@sha256:<digest>)}"
case "$BASE_IMAGE" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "BASE_IMAGE must be pinned by digest: name@sha256:<64 hex characters>" >&2; exit 1 ;;
esac

cd "$(dirname "$0")/.."
iidfile="$(mktemp)"
docker build --build-arg BASE_IMAGE="$BASE_IMAGE" --iidfile "$iidfile" -f deploy/Dockerfile .
echo "Add this line to deploy/.env:"
echo "PHEROMILL_IMAGE=$(cat "$iidfile")"
rm -f "$iidfile"
