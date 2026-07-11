#!/usr/bin/env bash
#
# Report the CDN cache headers Forge serves a built asset with.
#
# Our asset filenames are content-hashed (e.g. mermaid.core-<hash>.js), so their
# URLs are immutable — a chunk's URL only changes when its bytes do. That means
# we *want* to see a long-lived cache policy: ideally `cache-control: ... immutable`
# or a large `max-age`, plus an `etag`. This script just surfaces those headers so
# the observed values can be pasted into the README's "Asset caching" table.
#
# Run it AFTER `forge deploy` + `forge install`, against a real chunk URL copied
# from the browser DevTools -> Network tab (open a diagram, find the macro
# iframe's .js request, "Copy link address").
#
# Usage: scripts/check-asset-headers.sh '<asset-url>'
set -euo pipefail

url="${1:-}"
if [[ -z "$url" ]]; then
  echo "usage: $0 '<asset-url-from-devtools-network-tab>'" >&2
  exit 2
fi

echo "HEAD $url"
echo "----------------------------------------"
curl -sSI "$url" \
  | grep -iE 'cache-control|etag|age|x-cache|expires|last-modified|content-type|content-encoding' \
  || { echo "(no matching headers — is the URL correct and publicly reachable?)" >&2; exit 1; }
