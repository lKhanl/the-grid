#!/bin/sh
# the build is plain Node now (works the same in PowerShell): see build.cjs
exec node "$(dirname "$0")/build.cjs" "$@"
