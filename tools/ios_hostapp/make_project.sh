#!/usr/bin/env bash
# Generates SignalsHostApp.xcodeproj from project.yml. Run on the CI macOS
# runner after `brew install xcodegen`.
set -euo pipefail
cd "$(dirname "$0")"
xcodegen generate --spec project.yml
echo "generated SignalsHostApp.xcodeproj"
