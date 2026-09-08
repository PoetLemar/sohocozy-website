#!/bin/zsh
# Save a scoped GoDaddy Personal Access Token in macOS Keychain and verify it.
set -euo pipefail
set +x
umask 077

DOMAIN="sohocozystore.com"
KEYCHAIN_SERVICE="sohocozy.godaddy.pat"
KEYCHAIN_ACCOUNT="domains-api"
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sohocozy-godaddy-pat.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT

print -- "Paste the GoDaddy Personal Access Token, then press Return."
print -- "Required scopes: domains.domain:read and domains.nameserver:update"
read -rs "PAT?token: "
print ""

if [[ -z "$PAT" || ! "$PAT" =~ '^[A-Za-z0-9._~+/-]+=*$' ]]; then
  print -u2 -- "Nothing saved: a single valid bearer token is required."
  exit 1
fi

HEADER_FILE="$WORK_DIR/headers"
RESPONSE_FILE="$WORK_DIR/domain.json"
chmod 700 "$WORK_DIR"
print -r -- "Authorization: Bearer $PAT" > "$HEADER_FILE"
chmod 600 "$HEADER_FILE"

HTTP_CODE=$(curl --disable --silent --show-error \
  --proto '=https' --connect-timeout 15 --max-time 45 \
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

/usr/bin/python3 -c '
import json,re,sys
d=json.load(open(sys.argv[1]))
if not isinstance(d,dict) or d.get("domain",d.get("domainName","")).lower().rstrip(".") != sys.argv[2]:
    raise SystemExit("Nothing saved: GoDaddy returned a different or missing domain.")
ns=d.get("nameServers")
host=re.compile(r"(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9-]+\.?$")
if not isinstance(ns,list) or not 2 <= len(ns) <= 13 or any(not isinstance(n,str) or not host.fullmatch(n) for n in ns):
    raise SystemExit("Nothing saved: invalid or missing nameservers in the domain response.")
print("Verified domain:",sys.argv[2])
print("Current nameservers:",", ".join(ns))
' "$RESPONSE_FILE" "$DOMAIN"

# Supply the secret on stdin, keeping it out of process arguments. Only save
# after the token has successfully read this exact domain.
printf 'add-generic-password -U -a "%s" -s "%s" -w "%s"\n' \
  "$KEYCHAIN_ACCOUNT" "$KEYCHAIN_SERVICE" "$PAT" | security -i >/dev/null
SAVED_PAT=$(security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w)
if [[ "$SAVED_PAT" != "$PAT" ]]; then
  print -u2 -- "Keychain did not retain the verified token."
  exit 1
fi
unset PAT SAVED_PAT
print -- "Token saved in macOS Keychain service: $KEYCHAIN_SERVICE"
