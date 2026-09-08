#!/bin/zsh
# Stores a GoDaddy Personal Access Token (key + secret) so agents can use the
# Domains API without the secret ever passing through chat.
# Written to ~/.config/godaddy/credentials with 600 perms.
set -e
DIR="$HOME/.config/godaddy"
FILE="$DIR/credentials"
mkdir -p "$DIR"; chmod 700 "$DIR"

print -r -- "Paste the GoDaddy API KEY, then press Return."
read -r "KEY?key: "
print -r -- "Paste the GoDaddy API SECRET, then press Return (input hidden)."
read -rs "SECRET?secret: "
print ""

if [[ -z "$KEY" || -z "$SECRET" ]]; then
  print -r -- "Nothing saved: both key and secret are required."
  exit 1
fi

umask 077
cat > "$FILE" <<EOF
GODADDY_KEY=$KEY
GODADDY_SECRET=$SECRET
EOF
chmod 600 "$FILE"

print -r -- "Saved to $FILE (600). Verifying against the live API..."
CODE=$(curl -s -o /tmp/gd_check.json -w '%{http_code}' \
  -H "Authorization: sso-key ${KEY}:${SECRET}" \
  "https://api.godaddy.com/v1/domains?limit=5")
if [[ "$CODE" == "200" ]]; then
  print -r -- "OK — GoDaddy API accepted the key. Domains visible:"
  /usr/bin/python3 -c 'import json;print("\n".join("  - "+d["domain"]+" ("+d.get("status","?")+")" for d in json.load(open("/tmp/gd_check.json"))))' 2>/dev/null || cat /tmp/gd_check.json
  print -r -- "Tell Claude: key saved."
else
  print -r -- "API returned HTTP $CODE — the key may be for OTE (test) instead of Production, or mistyped."
  cat /tmp/gd_check.json 2>/dev/null | head -c 400; print ""
fi
rm -f /tmp/gd_check.json
