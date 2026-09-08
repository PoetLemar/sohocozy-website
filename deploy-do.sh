#!/bin/zsh
# Deploy the canonical SOHOCOZY App Platform app and wait for it to become live.
set -euo pipefail

cd "$(dirname "$0")"
command -v doctl >/dev/null || {
  print -u2 -- "doctl is required: https://docs.digitalocean.com/reference/doctl/how-to/install/"
  exit 1
}

APP_NAME="sohocozy"
MATCHES=$(doctl apps list --format ID,Spec.Name --no-header | awk -v name="$APP_NAME" '$2 == name { print $1 }')
MATCH_COUNT=$(print -r -- "$MATCHES" | awk 'NF { count++ } END { print count + 0 }')

if (( MATCH_COUNT > 1 )); then
  print -u2 -- "Refusing to deploy: found more than one app named $APP_NAME."
  exit 1
fi

if (( MATCH_COUNT == 1 )); then
  APP_ID="$MATCHES"
  print -- "Updating $APP_NAME ($APP_ID) and pulling the latest main branch..."
  doctl apps update "$APP_ID" \
    --spec .do/app.yaml \
    --update-sources \
    --wait \
    --format ID,DefaultIngress,ActiveDeployment.ID \
    --no-header
else
  print -- "Creating $APP_NAME..."
  CREATE_RESULT=$(doctl apps create \
    --spec .do/app.yaml \
    --wait \
    --format ID,DefaultIngress,ActiveDeployment.ID \
    --no-header)
  print -- "$CREATE_RESULT"
  APP_ID=$(print -r -- "$CREATE_RESULT" | awk 'NR == 1 { print $1 }')
fi

print -- "DigitalOcean deployment completed for SOHOCOZY ($APP_ID)."

if ! /usr/bin/python3 tools/sync-certificate-dns.py --app-id "$APP_ID"; then
  print -u2 -- "Deployment succeeded; certificate DNS synchronization needs attention before HTTPS readiness can be verified."
  exit 2
fi

CANONICAL_URL="https://sohocozystore.com"
VERIFY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sohocozy-deploy-check.XXXXXX")
trap 'rm -rf "$VERIFY_DIR"' EXIT

# Exit 2 means the deployment completed, but the canonical site is not ready.
# Keep TLS verification enabled: a pending certificate must not count as live.
if ! HTTP_CODE=$(curl --disable --fail --silent --show-error \
  --proto '=https' --connect-timeout 10 --max-time 30 \
  --retry 3 --retry-delay 3 \
  --output "$VERIFY_DIR/index.html" --write-out '%{http_code}' \
  "$CANONICAL_URL"); then
  print -u2 -- "Deployment succeeded; custom-domain readiness is not yet verified at $CANONICAL_URL. Check DNS and certificate provisioning."
  exit 2
fi

if [[ "$HTTP_CODE" != "200" ]] \
  || ! /usr/bin/grep -Fq '<title>SOHOCOZY — the garments of calm</title>' "$VERIFY_DIR/index.html" \
  || ! /usr/bin/grep -Fq '<link rel="canonical" href="https://sohocozystore.com/">' "$VERIFY_DIR/index.html" \
  || ! /usr/bin/grep -Fq '<script type="module" src="elements.js"></script>' "$VERIFY_DIR/index.html"; then
  print -u2 -- "Deployment succeeded; $CANONICAL_URL did not return the expected SOHOCOZY HTML (HTTP $HTTP_CODE)."
  exit 2
fi

print -- "SOHOCOZY is live over verified HTTPS at $CANONICAL_URL."
