#!/bin/sh
# Build the installable archive: one top-level paywallwasm/ directory with only
# the files the LNbits WASM installer needs (no dev tooling).
set -eu
cd "$(dirname "$0")/../.."
out="${1:-dist/paywallwasm.zip}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/paywallwasm" "$(dirname "$out")"
cp -R config.json README.md LICENSE wasm ui static storage "$stage/paywallwasm/"
rm -f "$out"
out_abs="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
(cd "$stage" && zip -qrX "$out_abs" paywallwasm)
echo "$out_abs"
