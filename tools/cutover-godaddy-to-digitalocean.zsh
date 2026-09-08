#!/bin/zsh
# Replace SOHOCOZY's authoritative nameservers at GoDaddy with DigitalOcean DNS.
set -euo pipefail

DOMAIN="sohocozystore.com"
KEYCHAIN_SERVICE="sohocozy.godaddy.pat"
KEYCHAIN_ACCOUNT="domains-api"
NEW_NAMESERVERS='["ns1.digitalocean.com", "ns2.digitalocean.com", "ns3.digitalocean.com"]'
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sohocozy-dns-cutover.XXXXXX")
RECEIPT_DIR="$HOME/.local/share/sohocozy/receipts"
STAMP=$(date -u '+%Y%m%dT%H%M%SZ')
trap 'rm -rf "$WORK_DIR"' EXIT

command -v doctl >/dev/null || {
  print -u2 -- "doctl is required before DNS cutover."
  exit 1
}

PAT=$(security find-generic-password \
  -a "$KEYCHAIN_ACCOUNT" \
  -s "$KEYCHAIN_SERVICE" \
  -w 2>/dev/null) || {
  print -u2 -- "No GoDaddy token found. Run tools/save-godaddy-pat.zsh first."
  exit 1
}

HEADER_FILE="$WORK_DIR/headers"
DOMAIN_FILE="$WORK_DIR/domain.json"
RESPONSE_HEADERS="$WORK_DIR/response.headers"
RESPONSE_BODY="$WORK_DIR/response.json"
ZONE_FILE="$WORK_DIR/digitalocean-zone.json"
chmod 700 "$WORK_DIR"
print -r -- "Authorization: Bearer $PAT" > "$HEADER_FILE"
chmod 600 "$HEADER_FILE"
unset PAT

doctl compute domain records list "$DOMAIN" --output json > "$ZONE_FILE"
/usr/bin/python3 -c '
import json, sys
records = json.load(open(sys.argv[1]))
types = {r.get("type") for r in records}
names = {r.get("name") for r in records}
required_types = {"A", "AAAA", "CNAME", "MX"}
missing_types = sorted(required_types - types)
if missing_types or "www" not in names:
    raise SystemExit("DigitalOcean zone is incomplete; missing: " + ", ".join(missing_types + ([] if "www" in names else ["www"])))
print(f"DigitalOcean preflight: {len(records)} records, required web and mail routes present.")
' "$ZONE_FILE"

HTTP_CODE=$(curl --silent --show-error \
  --header "@$HEADER_FILE" \
  --header "Accept: application/json" \
  --output "$DOMAIN_FILE" \
  --write-out '%{http_code}' \
  "https://api.godaddy.com/v3/domains/domain-names/$DOMAIN")

if [[ "$HTTP_CODE" != "200" ]]; then
  print -u2 -- "Could not read the current GoDaddy nameservers (HTTP $HTTP_CODE)."
  exit 1
fi

OLD_NAMESERVERS=$(/usr/bin/python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])).get("nameServers", [])))' "$DOMAIN_FILE")
if /usr/bin/python3 -c 'import json,sys; raise SystemExit(0 if set(json.loads(sys.argv[1])) == set(json.loads(sys.argv[2])) else 1)' "$OLD_NAMESERVERS" "$NEW_NAMESERVERS"; then
  print -- "$DOMAIN already uses DigitalOcean nameservers."
  exit 0
fi

mkdir -p "$RECEIPT_DIR"
chmod 700 "$RECEIPT_DIR"
/usr/bin/python3 -c '
import json, sys
json.dump({"domain": sys.argv[1], "recordedAt": sys.argv[2], "oldNameservers": json.loads(sys.argv[3]), "requestedNameservers": json.loads(sys.argv[4]), "status": "prepared"}, open(sys.argv[5], "w"), indent=2)
' "$DOMAIN" "$STAMP" "$OLD_NAMESERVERS" "$NEW_NAMESERVERS" "$RECEIPT_DIR/nameserver-cutover-$STAMP.json"

IDEMPOTENCY_KEY=$(uuidgen | tr '[:upper:]' '[:lower:]')
HTTP_CODE=$(curl --silent --show-error \
  --request PUT \
  --header "@$HEADER_FILE" \
  --header "Accept: application/json" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: $IDEMPOTENCY_KEY" \
  --data-raw "$NEW_NAMESERVERS" \
  --dump-header "$RESPONSE_HEADERS" \
  --output "$RESPONSE_BODY" \
  --write-out '%{http_code}' \
  "https://api.godaddy.com/v3/domains/domain-names/$DOMAIN/nameservers")

if [[ "$HTTP_CODE" != "202" ]]; then
  print -u2 -- "GoDaddy refused the nameserver change (HTTP $HTTP_CODE)."
  /usr/bin/python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("message") or d.get("error",{}).get("message") or "Unknown API error")' "$RESPONSE_BODY" 2>/dev/null || true
  exit 1
fi

OPERATION_URL=$(/usr/bin/python3 -c '
import json, sys
d=json.load(open(sys.argv[1]))
for link in d.get("links", []):
    if link.get("rel") == "self":
        print(link.get("href", "")); break
' "$RESPONSE_BODY")

if [[ -z "$OPERATION_URL" ]]; then
  OPERATION_URL=$(awk 'BEGIN{IGNORECASE=1} /^location:/ {gsub("\r", "", $2); print $2}' "$RESPONSE_HEADERS")
fi

if [[ -n "$OPERATION_URL" ]]; then
  for attempt in {1..60}; do
    curl --silent --show-error \
      --header "@$HEADER_FILE" \
      --header "Accept: application/json" \
      --output "$RESPONSE_BODY" \
      "$OPERATION_URL"
    STATUS=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status", "UNKNOWN"))' "$RESPONSE_BODY")
    case "$STATUS" in
      COMPLETED) break ;;
      FAILED|CANCELED|CANCELLED)
        print -u2 -- "GoDaddy nameserver operation ended with status $STATUS."
        exit 1
        ;;
    esac
    sleep 5
  done
fi

/usr/bin/python3 -c '
import json, sys
p=sys.argv[1]
d=json.load(open(p))
d["status"]="submitted"
d["idempotencyKey"]=sys.argv[2]
json.dump(d, open(p,"w"), indent=2)
' "$RECEIPT_DIR/nameserver-cutover-$STAMP.json" "$IDEMPOTENCY_KEY"

print -- "Nameserver cutover submitted for $DOMAIN."
print -- "Rollback nameservers saved to $RECEIPT_DIR/nameserver-cutover-$STAMP.json"
