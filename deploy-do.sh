#!/bin/zsh
# One-shot DigitalOcean deployment for SOHOCOZY.
# Prereq (once): doctl auth init   <- paste a DO API token, then run this script.
set -e
cd "$(dirname "$0")"
EXISTING=$(doctl apps list --format ID,Spec.Name --no-header 2>/dev/null | awk '$2=="sohocozy"{print $1}')
if [ -n "$EXISTING" ]; then
  echo "Updating existing app $EXISTING"
  doctl apps update "$EXISTING" --spec .do/app.yaml
else
  echo "Creating app"
  doctl apps create --spec .do/app.yaml
fi
echo "Deployment queued. Watch: doctl apps list"
