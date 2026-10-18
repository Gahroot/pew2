#!/usr/bin/env bash
# Render every home/Lock Screen widget to PNGs, from the widget's own SwiftUI.
#
#   packages/app/scripts/widget-preview.sh [out-dir]   (default: a temp dir)
#
# Needs Xcode's command-line tools on a Mac; nothing else.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(cd "$here/.." && pwd)"
out="${1:-$(mktemp -d)}"
bin="$(mktemp -d)"
trap 'rm -rf "$bin"' EXIT

swiftc -parse-as-library -O \
  "$app/targets/_shared/PewSnapshot.swift" \
  "$app/targets/widget/PewWidgetViews.swift" \
  "$here/widget-preview/Mark.swift" \
  "$here/widget-preview/main.swift" \
  -o "$bin/widget-preview"

PEW_MARK="$app/assets/widget-pew.png" "$bin/widget-preview" "$out"
