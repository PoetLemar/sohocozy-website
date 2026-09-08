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

INGRESS=$(doctl apps get "$APP_ID" --format DefaultIngress --no-header)
curl --fail --silent --show-error --location \
  --retry 5 --retry-delay 3 \
  --output /dev/null "$INGRESS"

print -- "SOHOCOZY is live at $INGRESS"
