#!/bin/zsh
# Save a scoped GoDaddy Personal Access Token in macOS Keychain and verify it.
set -euo pipefail

DOMAIN="sohocozystore.com"
KEYCHAIN_SERVICE="sohocozy.godaddy.pat"
KEYCHAIN_ACCOUNT="domains-api"
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sohocozy-godaddy-pat.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT

print -- "Paste the GoDaddy Personal Access Token, then press Return."
print -- "Required scopes: domains.domain:read and domains.nameserver:update"
read -rs "PAT?token: "
print ""

if [[ -z "$PAT" ]]; then
  print -u2 -- "Nothing saved: a token is required."
  exit 1
fi

security add-generic-password \
  -U \
  -a "$KEYCHAIN_ACCOUNT" \
  -s "$KEYCHAIN_SERVICE" \
  -w "$PAT" >/dev/null

HEADER_FILE="$WORK_DIR/headers"
RESPONSE_FILE="$WORK_DIR/domain.json"
chmod 600 "$WORK_DIR"
print -r -- "Authorization: Bearer $PAT" > "$HEADER_FILE"
chmod 600 "$HEADER_FILE"
unset PAT

HTTP_CODE=$(curl --silent --show-error \
  --header "@$HEADER_FILE" \
  --header "Accept: application/json" \
  --output "$RESPONSE_FILE" \
  --write-out '%{http_code}' \
  "https://api.godaddy.com/v3/domains/domain-names/$DOMAIN")

if [[ "$HTTP_CODE" != "200" ]]; then
  print -u2 -- "GoDaddy verification failed with HTTP $HTTP_CODE."
  /usr/bin/python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("message") or d.get("error",{}).get("message") or "Unknown API error")' "$RESPONSE_FILE" 2>/dev/null || true
  exit 1
fi

/usr/bin/python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("Verified domain:", d.get("domain") or d.get("domainName") or sys.argv[2]); print("Current nameservers:", ", ".join(d.get("nameServers", [])))' "$RESPONSE_FILE" "$DOMAIN"
print -- "Token saved in macOS Keychain service: $KEYCHAIN_SERVICE"

