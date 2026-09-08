#!/usr/bin/env python3
"""Bounded SOHOCOZY HTTPS verification, with optional certificate DNS sync."""

import argparse
import concurrent.futures
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

APP_ID = "546a3317-90b2-44db-9284-7f897983eb4e"
HOSTS = ("sohocozystore.com", "www.sohocozystore.com")
MARKERS = (
    b"<title>SOHOCOZY",
    b'<link rel="canonical" href="https://sohocozystore.com/">',
    b"elements.js",
)


class StorefrontRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        parsed = urllib.parse.urlsplit(new_url)
        if parsed.scheme != "https" or parsed.hostname not in HOSTS:
            raise ValueError("Redirect leaves the SOHOCOZY HTTPS domains")
        return super().redirect_request(request, fp, code, message, headers, new_url)


def check_host(host):
    result = {"host": host, "ready": False}
    try:
        opener = urllib.request.build_opener(StorefrontRedirects())
        with opener.open("https://" + host + "/", timeout=15) as response:
            body = response.read(2_000_000)
            result.update(status=response.status, url=response.url,
                          sha256=hashlib.sha256(body).hexdigest())
            result["ready"] = response.status == 200 and all(m in body for m in MARKERS)
        if result["ready"]:
            with opener.open("https://" + host + "/elements.js", timeout=15) as response:
                result["script_status"] = response.status
                script = response.read(2_000_000)
                result["ready"] = response.status == 200 and b"THREE" in script
    except Exception as error:
        result["error"] = str(error)
    return result


def domain_status():
    try:
        data = json.loads(subprocess.check_output(
            ["doctl", "apps", "get", APP_ID, "-o", "json"],
            stderr=subprocess.DEVNULL, timeout=20))[0]
        return [{"domain": item["spec"]["domain"], "phase": item.get("phase"),
                 "certificate_expires_at": item.get("certificate_expires_at"),
                 "reasons": [step["reason"] for step in item.get("progress", {}).get("steps", [])
                             if step.get("reason")]}
                for item in data.get("domains", [])]
    except Exception as error:
        return {"diagnostic_error": str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--minutes", type=int, default=60, choices=range(1, 121), metavar="1..120")
    parser.add_argument("--sync-certificate-dns", action="store_true",
                        help="Create missing SOHOCOZY certificate TXT proofs before each check.")
    args = parser.parse_args()
    os.umask(0o077)
    receipts = Path.home() / ".local/share/sohocozy/receipts"
    receipts.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    receipt = receipts / ("production-watch-" + stamp + ".jsonl")
    deadline = time.monotonic() + args.minutes * 60
    print(("HTTPS verification with certificate DNS sync" if args.sync_certificate_dns
           else "Read-only HTTPS verification") + "; receipt: " + str(receipt), flush=True)
    while True:
        sync = None
        if args.sync_certificate_dns:
            try:
                result = subprocess.run(
                    [sys.executable, str(Path(__file__).with_name("sync-certificate-dns.py"))],
                    capture_output=True, text=True, timeout=120)
                sync = {"exit_code": result.returncode,
                        "output": result.stdout.strip(), "error": result.stderr.strip()}
            except subprocess.TimeoutExpired:
                sync = {"error": "Certificate DNS synchronization timed out; review its receipt."}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            hosts = list(pool.map(check_host, HOSTS))
        ready = all(host["ready"] for host in hosts)
        timed_out = time.monotonic() >= deadline
        result = {
            "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "status": "ready" if ready else "timed_out" if timed_out else "pending",
            "hosts": hosts,
            "digitalocean": domain_status(),
            "certificate_dns_sync": sync,
        }
        with receipt.open("a") as stream:
            stream.write(json.dumps(result) + "\n")
        print(json.dumps(result), flush=True)
        if ready or timed_out:
            return 0 if ready else 2
        time.sleep(min(60, max(0, deadline - time.monotonic())))


if __name__ == "__main__":
    raise SystemExit(main())
