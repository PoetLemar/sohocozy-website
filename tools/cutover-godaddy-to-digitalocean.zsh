#!/bin/zsh
# Change only SOHOCOZY's registrar nameservers after preserving both DNS zones.
set -euo pipefail
set +x
umask 077
WORK_DIR=$(mktemp -d "/tmp/sohocozy-dns-cutover.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT
chmod 700 "$WORK_DIR"
command -v doctl >/dev/null || { print -u2 -- "doctl is required."; exit 1; }
# No token in command arguments, receipts, or output.
security find-generic-password -a domains-api -s sohocozy.godaddy.pat -w \
  > "$WORK_DIR/token" 2>/dev/null || {
  print -u2 -- "No GoDaddy token found. Run tools/save-godaddy-pat.zsh first."
  exit 1
}

/usr/bin/python3 - "$WORK_DIR/token" "$HOME/.local/share/sohocozy/receipts" <<'PY'
import datetime
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

DOMAIN = "sohocozystore.com"
BASE = "https://api.godaddy.com"
DOMAIN_PATH = "/v3/domains/domain-names/" + DOMAIN
ZONE_PATH = "/v3/domains/zones/" + DOMAIN + "/dns-records"
NEW_NS = ["ns1.digitalocean.com", "ns2.digitalocean.com", "ns3.digitalocean.com"]
OLD_NS = {"ns21.domaincontrol.com", "ns22.domaincontrol.com"}
APP_HOST = "sohocozy-mdxzc.ondigitalocean.app"
# Reviewed SOHOCOZY targets; changed infrastructure requires a fresh preflight.
EXPECTED_IPS = {"A": {"162.159.140.98", "172.66.0.96"},
                "AAAA": {"2a06:98c1:58::60", "2606:4700:7::60"}}
receipt = None
receipt_path = None


def persist(status, **fields):
    receipt.update(status=status, updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), **fields)
    temporary = receipt_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(receipt, indent=2) + "\n")
    os.replace(temporary, receipt_path)


def fail(message):
    raise RuntimeError(message)


def normalize_domain(value):
    return value.lower().rstrip(".") if isinstance(value, str) else ""


def domain_nameservers(data):
    if not isinstance(data, dict) or normalize_domain(data.get("domain", data.get("domainName"))) != DOMAIN:
        fail("GoDaddy returned a missing or different domain; refusing the operation.")
    values = data.get("nameServers")
    hostname = re.compile(r"(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9-]+\.?$")
    if not isinstance(values, list) or not 2 <= len(values) <= 13 or any(not isinstance(v, str) or not hostname.fullmatch(v) for v in values):
        fail("GoDaddy returned missing or invalid nameservers; no safe rollback is available.")
    values = [normalize_domain(v) for v in values]
    if len(values) != len(set(values)):
        fail("GoDaddy returned duplicate nameservers.")
    return values


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def safe_url(value, operation=False):
    if not isinstance(value, str) or re.search(r"[\s\\]", value):
        fail("Invalid GoDaddy operation URL; no credential was sent to it.")
    parsed = urllib.parse.urlsplit(urllib.parse.urljoin(BASE, value))
    if parsed.scheme != "https" or parsed.netloc != "api.godaddy.com" or parsed.fragment:
        fail("Untrusted GoDaddy URL; no credential was sent to it.")
    if operation and (parsed.query or not re.fullmatch(r"/v3/domains/operations/[A-Za-z0-9_-]+", parsed.path)):
        fail("Unexpected GoDaddy operation path; no credential was sent to it.")
    return parsed.geturl()


def request(path, method="GET", payload=None, key=None):
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode()
        headers.update({"Content-Type": "application/json", "Idempotency-Key": key})
    req = urllib.request.Request(safe_url(path), data=body, method=method, headers=headers)
    try:
        with opener.open(req, timeout=30) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}, response.headers
    except urllib.error.HTTPError as error:
        return error.code, {}, {}


def read_json(path):
    code, body, _ = request(path)
    if code != 200:
        fail("GoDaddy read failed with HTTP " + str(code) + ".")
    return body


def record_identity(record):
    if not isinstance(record, dict):
        fail("Malformed DNS record; preflight stopped.")
    name = normalize_domain(record.get("name"))
    if name == DOMAIN:
        name = "@"
    elif name.endswith("." + DOMAIN):
        name = name[:-(len(DOMAIN) + 1)]
    kind = record.get("type", "").upper()
    if not name or not kind:
        fail("Malformed DNS record; preflight stopped.")
    return name, kind


def record_key(record):
    name, kind = record_identity(record)
    value = record.get("data")
    if not isinstance(value, str):
        fail("Malformed DNS record; preflight stopped.")
    if kind in {"CNAME", "MX", "NS"}:
        value = normalize_domain(value)
    elif kind in {"A", "AAAA"}:
        value = str(ipaddress.ip_address(value))
    extras = {"MX": ("priority",), "SRV": ("priority", "port", "weight", "service", "protocol"),
              "CAA": ("flags", "tag")}.get(kind, ())
    return (name, kind, value) + tuple(record.get(k, record.get("flag", 0) if k == "flags" else 0) for k in extras)


def is_replaced(record):
    # GoDaddy may use logical web values such as "WebsiteBuilder Site".
    # Classify replaced records before parsing data; retain the raw snapshot.
    name, kind = record_identity(record)
    # _domainconnect is GoDaddy-specific discovery, retained only in rollback.
    return (name == "@" and kind in {"NS", "SOA", "A", "AAAA"}) or (name in {"www", "*"} and kind in {"A", "AAAA", "CNAME"}) or (name == "_domainconnect" and kind == "CNAME")


try:
    token = Path(sys.argv[1]).read_text().strip()
    if not re.fullmatch(r"[A-Za-z0-9._~+/-]+=*", token):
        fail("Missing or invalid GoDaddy bearer token.")
    opener = urllib.request.build_opener(NoRedirect())
    zone = json.loads(subprocess.run(["doctl", "compute", "domain", "records", "list", DOMAIN, "--output", "json"],
                                     check=True, capture_output=True, text=True).stdout)
    if not isinstance(zone, list) or any(not isinstance(r, dict) for r in zone):
        fail("DigitalOcean returned an invalid zone.")
    keys = {record_key(r) for r in zone}
    for kind, wanted in EXPECTED_IPS.items():
        if {k[2] for k in keys if k[:2] == ("@", kind)} != wanted:
            fail("DigitalOcean apex " + kind + " records do not match SOHOCOZY's reviewed app addresses.")
    for name in ("www", "*"):
        if {k for k in keys if k[0] == name and k[1] in {"A", "AAAA", "CNAME"}} != {(name, "CNAME", APP_HOST)}:
            fail("DigitalOcean " + name + " does not point exclusively at the SOHOCOZY app.")
    if {k[2] for k in keys if k[:2] == ("@", "NS")} != set(NEW_NS):
        fail("DigitalOcean zone nameservers are incomplete or unexpected.")
    if any(k[:2] == ("@", "CNAME") for k in keys):
        fail("DigitalOcean apex has a conflicting CNAME.")

    original_domain = read_json(DOMAIN_PATH)
    old_ns = domain_nameservers(original_domain)
    if set(old_ns) == set(NEW_NS):
        print(DOMAIN + " already has the requested nameservers at GoDaddy; web zone preflight passed.")
        print("Public DNS propagation and HTTPS still require separate verification.")
        sys.exit(0)
    if set(old_ns) != OLD_NS:
        fail("Current GoDaddy nameservers differ from the reviewed original pair; cutover stopped.")

    # Save every source record and require preservation of non-web routes.
    original_zone = []
    for page in range(1, 101):
        body = read_json(ZONE_PATH + "?pageSize=100&totalRequired=true&page=" + str(page))
        if not isinstance(body, dict) or not isinstance(body.get("items"), list):
            fail("GoDaddy DNS snapshot is malformed.")
        original_zone.extend(body["items"])
        total_pages = body.get("totalPages", 1 if not body["items"] else None)
        if not isinstance(total_pages, int) or not page <= total_pages <= 100:
            fail("GoDaddy DNS pagination is incomplete or exceeds the snapshot limit.")
        if page == total_pages:
            if body.get("totalItems", len(original_zone)) != len(original_zone):
                fail("GoDaddy DNS record count changed during snapshot.")
            break
    old_routes = {record_key(r) for r in original_zone if not is_replaced(r)}
    new_routes = {record_key(r) for r in zone if not is_replaced(r)}
    if old_routes != new_routes:
        fail("DigitalOcean non-web records differ from GoDaddy (including mail/TXT). Reconcile them before cutover.")

    receipt_dir = Path(sys.argv[2])
    receipt_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    receipt_dir.chmod(0o700)
    for previous_path in receipt_dir.glob("nameserver-cutover-*.json"):
        previous = json.loads(previous_path.read_text())
        if previous.get("domain") == DOMAIN and previous.get("status") in {"submitting", "accepted", "submitted", "polling", "verifying", "pending", "unknown", "unverified"}:
            fail("An earlier cutover is unresolved. Reconcile its operation before resubmitting: " + str(previous_path))
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    key = str(uuid.uuid4())
    receipt_path = receipt_dir / ("nameserver-cutover-" + stamp + "-" + key + ".json")
    receipt = {"domain": DOMAIN, "recordedAt": stamp, "idempotencyKey": key,
               "oldNameservers": old_ns, "requestedNameservers": NEW_NS,
               "originalDomain": original_domain, "originalGoDaddyZone": original_zone,
               "preparedDigitalOceanZone": zone,
               "rollback": {"method": "PUT", "url": BASE + DOMAIN_PATH + "/nameservers", "body": old_ns,
                            "note": "Use a fresh Idempotency-Key; first reconcile any in-flight operation."}}
    persist("prepared")
    # Re-read immediately before writing, to catch a concurrent registrar edit.
    if set(domain_nameservers(read_json(DOMAIN_PATH))) != set(old_ns):
        persist("aborted", reason="Nameservers changed during preflight")
        fail("Nameservers changed during preflight; no update sent.")
    persist("submitting")
    code, operation, headers = request(DOMAIN_PATH + "/nameservers", "PUT", NEW_NS, key)
    if code != 202:
        persist("rejected" if 400 <= code < 500 else "unknown", httpStatus=code)
        fail("GoDaddy did not accept the nameserver update (HTTP " + str(code) + ").")
    persist("accepted", operation=operation)
    if not isinstance(operation, dict) or normalize_domain(operation.get("domain")) != DOMAIN:
        fail("GoDaddy returned an operation for a missing or different domain.")
    operation_id = operation.get("operationId")
    links = [link.get("href") for link in operation.get("links", []) if link.get("rel") == "self"]
    location = headers.get("Location")
    if location:
        links.append(location)
    if not links and isinstance(operation_id, str) and re.fullmatch(r"[A-Za-z0-9_-]+", operation_id):
        links.append("/v3/domains/operations/" + operation_id)
    urls = {safe_url(link, operation=True) for link in links}
    if len(urls) != 1:
        fail("Missing or conflicting operation polling URL; update remains unverified.")
    operation_url = urls.pop()
    if operation_id and operation_url.rsplit("/", 1)[-1] != operation_id:
        fail("Operation identifier does not match its polling URL.")
    operation_id = operation_url.rsplit("/", 1)[-1]
    persist("polling", operationUrl=operation_url)
    for attempt in range(60):
        operation = read_json(operation_url)
        if not isinstance(operation, dict) or normalize_domain(operation.get("domain")) != DOMAIN or (operation_id and operation.get("operationId") != operation_id):
            fail("Polled operation identity does not match the requested domain/update.")
        status = operation.get("status")
        if status in {"FAILED", "CANCELED", "CANCELLED"}:
            persist("failed", operation=operation)
            fail("GoDaddy operation ended with status " + status + ".")
        if status == "COMPLETED":
            persist("verifying", operation=operation)
            break
        if status not in {"CONFIRMED", "EXECUTING", "PENDING", "QUEUED"}:
            fail("GoDaddy returned an unknown operation status.")
        if attempt == 59:
            persist("pending", operation=operation)
            fail("GoDaddy operation is still pending after the polling limit; completion is not confirmed.")
        time.sleep(5)
    final_domain = read_json(DOMAIN_PATH)
    actual_ns = domain_nameservers(final_domain)
    if set(actual_ns) != set(NEW_NS):
        persist("unverified", observedNameservers=actual_ns)
        fail("Operation completed, but GoDaddy does not yet report the requested nameservers.")
    persist("registrar_verified", verifiedDomain=final_domain, observedNameservers=actual_ns)
    print("GoDaddy now reports all three DigitalOcean nameservers for " + DOMAIN + ".")
    print("Public DNS propagation and HTTPS still require separate verification.")
    print("Receipt and rollback: " + str(receipt_path))
except Exception as error:
    if receipt is not None:
        if receipt["status"] in {"submitting", "accepted", "polling", "verifying"}:
            persist("unknown", reason=str(error))
        print("Receipt and rollback: " + str(receipt_path), file=sys.stderr)
    print(str(error), file=sys.stderr)
    sys.exit(1)
PY
