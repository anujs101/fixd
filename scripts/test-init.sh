#!/usr/bin/env bash

set -e

ROOT=$(pwd)
TESTING="$ROOT/../testing"

WORKSPACE="$TESTING/generated"

rm -rf "$WORKSPACE"
mkdir -p "$WORKSPACE"

cp "$TESTING/.env" "$WORKSPACE/.env"

echo
echo "Created clean workspace"
echo

cd "$WORKSPACE"

node "$ROOT/dist/cli/index.js" init