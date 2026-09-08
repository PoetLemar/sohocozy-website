#!/usr/bin/env python3
"""Copy SOHOCOZY App Platform certificate proofs into its existing DNS zone."""

import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

APP_ID = "546a3317-90b2-44db-9284-7f897983eb4e"
ZONE = "sohocozystore.com"
DOMAINS = {ZONE, "www." + ZONE}
PROOF_NAMES = {"_acme-challenge." + domain for domain in DOMAINS}


def doctl_json(*arguments):
    # Authentication stays inside doctl's configured credential store.
    result = subprocess.run(["doctl", *arguments, "--output", "json"],
                            capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError("DigitalOcean command failed; no credentials or response headers were logged.")
    return json.loads(result.stdout)


def one_object(value, label):
    if isinstance(value, list) and len(value) == 1:
        value = value[0]
    if not isinstance(value, dict):
        raise RuntimeError("Unexpected DigitalOcean " + label + " response.")
    return value


def normalized_name(value):
    return value.lower().rstrip(".") if isinstance(value, str) else ""


def proofs_for(app):
    if app.get("id") != APP_ID or app.get("spec", {}).get("name") != "sohocozy":
        raise RuntimeError("Refusing certificate DNS changes for an unexpected app.")
    domains = app.get("domains")
    if not isinstance(domains, list) or not domains:
        raise RuntimeError("The SOHOCOZY app has no domain metadata to validate.")
    proofs = set()
    for domain in domains:
        if not isinstance(domain, dict):
            raise RuntimeError("Malformed app domain metadata.")
        name = normalized_name(domain.get("spec", {}).get("domain"))
        if name not in DOMAINS:
            raise RuntimeError("Refusing certificate DNS changes for an unexpected domain.")
        validations = domain.get("validations", [])
        if not isinstance(validations, list):
            raise RuntimeError("Malformed certificate validation metadata.")
        validations = list(validations)
        if domain.get("validation"):
            validations.append(domain["validation"])
        for validation in validations:
            if not isinstance(validation, dict):
                raise RuntimeError("Malformed certificate proof.")
            proof_name = normalized_name(validation.get("txt_name"))
            value = validation.get("txt_value")
            if proof_name not in PROOF_NAMES or proof_name != "_acme-challenge." + name:
                raise RuntimeError("Unexpected certificate TXT name; no DNS records were changed.")
            if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{20,255}", value):
                raise RuntimeError("Malformed certificate TXT value; no DNS records were changed.")
            proofs.add((proof_name[:-(len(ZONE) + 1)], value))
    return sorted(proofs)


def zone_records():
    records = doctl_json("compute", "domain", "records", "list", ZONE)
    if not isinstance(records, list) or any(not isinstance(record, dict) for record in records):
        raise RuntimeError("Unexpected DigitalOcean DNS zone response.")
    return records


def present(records, name, value):
    return any(record.get("type") == "TXT"
               and normalized_name(record.get("name")) in {name, name + "." + ZONE}
               and record.get("data") == value for record in records)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-id", default=APP_ID)
    parser.add_argument("--check", action="store_true", help="Report missing proofs without creating DNS records.")
    args = parser.parse_args()
    if args.app_id != APP_ID:
        parser.error("Only the canonical SOHOCOZY app ID is permitted.")
    os.umask(0o077)
    receipt_dir = Path.home() / ".local/share/sohocozy/receipts"
    receipt_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    receipt_dir.chmod(0o700)
    with (receipt_dir / ".certificate-dns.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        app = one_object(doctl_json("apps", "get", APP_ID), "app")
        proofs = proofs_for(app)  # Validate every requested name before any write.
        before = zone_records()
        missing = [(name, value) for name, value in proofs if not present(before, name, value)]
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        receipt_path = receipt_dir / ("certificate-dns-" + stamp + "-" + str(uuid.uuid4()) + ".json")
        receipt = {"appId": APP_ID, "zone": ZONE, "recordedAt": stamp,
                   "before": before, "requestedProofs": [{"name": n, "data": v} for n, v in proofs],
                   "planned": [{"name": n, "data": v, "type": "TXT", "ttl": 60} for n, v in missing],
                   "created": [], "status": "prepared"}

        def save(status, **fields):
            receipt.update(status=status, **fields)
            temporary = receipt_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(receipt, indent=2) + "\n")
            os.replace(temporary, receipt_path)

        save("prepared")
        try:
            if args.check and missing:
                save("would_create")
                print("Certificate DNS check: " + str(len(missing)) + " TXT proof(s) missing; no DNS records changed.")
                print("Receipt: " + str(receipt_path))
                return 2
            for name, value in missing:
                # Another operator may already have supplied a proof since preflight.
                if present(zone_records(), name, value):
                    continue
                save("creating", inFlight={"name": name, "data": value, "type": "TXT", "ttl": 60})
                created = one_object(doctl_json("compute", "domain", "records", "create", ZONE,
                                               "--record-type", "TXT", "--record-name", name,
                                               "--record-data=" + value, "--record-ttl", "60"), "record")
                # Preserve the returned ID before checking the rest of the response.
                receipt["created"].append(created)
                save("created")
                if not created.get("id") or not present([created], name, value):
                    raise RuntimeError("Created TXT response needs review; see its receipt before retrying.")
                receipt.pop("inFlight", None)
                save("prepared")
            after = zone_records() if missing else before
            if any(not present(after, name, value) for name, value in proofs):
                raise RuntimeError("Certificate TXT proofs are not all present after synchronization.")
            save("updated" if receipt["created"] else "no_op", after=after)
        except Exception:
            save("unknown" if receipt.get("inFlight") else "failed")
            print("Certificate DNS synchronization needs review. Receipt: " + str(receipt_path), file=sys.stderr)
            raise
        print("Certificate DNS: " + str(len(proofs)) + " proof(s) present; " + str(len(receipt["created"])) + " TXT record(s) created.")
        print("Receipt: " + str(receipt_path))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("Certificate DNS check failed: " + str(error), file=sys.stderr)
        sys.exit(1)
