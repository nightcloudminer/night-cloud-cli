#!/bin/bash
# Simple runner script for night-cloud-miner CLI
cd "$(dirname "$0")"
node packages/cli/dist/cli.js "$@"
