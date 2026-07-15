#!/usr/bin/env bash

set -e

if [ $# -lt 1 ]; then
    echo "Usage:"
    echo "./scripts/test.sh broken-prisma"
    exit 1
fi

FIXTURE=$1

ROOT=$(pwd)
TESTING="$ROOT/../testing"

WORKSPACE="$TESTING/workspaces/$FIXTURE"

echo "Preparing workspace..."

rm -rf "$WORKSPACE"

cp -R "$TESTING/fixtures/$FIXTURE" "$WORKSPACE"

cp "$TESTING/.env" "$WORKSPACE/.env"

echo
echo "Workspace ready:"
echo "$WORKSPACE"
echo

cd "$WORKSPACE"

node "$ROOT/dist/cli/index.js"