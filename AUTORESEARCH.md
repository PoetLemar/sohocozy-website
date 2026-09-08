# SOHOCOZY deployment investigation

Task playbook established September 8, 2026 for the requested SOHOCOZY domain activation. The active Codex goal carries the ongoing objective. This file records the method and task state for resumption.

## Requested outcome

Serve the latest saved Claude storefront build over verified HTTPS at both `sohocozystore.com` and `www.sohocozystore.com`, with the expected page, matching deployed JavaScript, and functioning desktop/mobile controls. The purchased domain is the public destination.

## Loop

1. Record the current source commit, active deployment, domain configuration, DNS answers, and real HTTPS result.
2. Name one falsifiable hypothesis and the smallest distinguishing test.
3. Save the prior configuration and apply only the change justified by that hypothesis. Preserve concurrent design work.
4. Test the requested public endpoint and the already-working endpoints. A deployment or provider status alone is not readiness evidence.
5. Keep supported improvements; restore a candidate that causes a regression. Record inconclusive and failed attempts without describing them as success. Allow certificate/DNS operations to settle instead of continually restarting them.
6. Reassess from current evidence. Repeat until the success conditions hold or a specific external capability/state prevents further progress.

The overall goal is continuous; individual observations and provider waits are bounded. Do not duplicate an operation already in flight. A changed source commit, DNS answer, or certificate request invalidates affected old checks but does not erase them.

## Controls and evidence

- `deploy-do.sh` publishes the app, synchronizes requested certificate proofs, and checks the canonical HTTPS page.
- `tools/sync-certificate-dns.py` creates missing certificate TXT proofs only for the two approved storefront hostnames. Existing records are preserved and changes are receipted privately.
- `tools/watch-production.py --minutes 60 --sync-certificate-dns` refreshes proof values and verifies actual HTTPS page/JavaScript availability during a bounded wait.
- Private receipts live in `~/.local/share/sohocozy/receipts/`; screenshots in `output/playwright/`. Neither location is included in the deployed static site.
- Keep secrets in the existing credential stores. No changes to registrar delegation, DNS-zone deletion, registration resets, paid infrastructure, or unrelated projects are part of a routine experiment.

## Baseline and next test

At 03:53 UTC September 8, `www.sohocozystore.com` served the latest saved build (`b6db5b7`) and JavaScript over valid HTTPS. The apex still failed TLS. Both Google and Cloudflare exposed its current TXT proofs. The deployed WWW certificate covers WWW only.

Experiment 001: remove only `wildcard: true` from the apex app-domain specification. Hypothesis: an unnecessary wildcard request is complicating certificate issuance; exact apex plus WWW coverage is sufficient. DigitalOcean accepted the proposed configuration before application. Keep both domain entries, existing DNS, and the working WWW route. Success requires actual apex HTTPS plus an unchanged working WWW endpoint. This hypothesis is not established until observed.

Earlier attempts are preserved in private receipts: registrar cutover, automatic zone-management failures, one domain-registration reset, stale DNS observations, and certificate-proof updates. Do not repeat them without new evidence.

## Research basis, checked September 8, 2026

| Project | Verified iteration | Relevant pattern |
| --- | --- | --- |
| [Karpathy autoresearch](https://github.com/karpathy/autoresearch/commit/228791fb499afffb54b46200aca536f79142f117) | March 26, 2026; no tagged release | Fixed experiments, independent measurement, keep/discard history; originally an ML training loop. |
| [Codex Autoresearch](https://github.com/TheGreenCedar/codex-autoresearch/releases/tag/v3.0.0) | v3.0.0, September 6, 2026 | Explicit success predicates, durable investigations, current evidence, verified delivery. |
| [AutoLoop](https://github.com/armgabrielyan/autoloop/releases/tag/v0.1.3) | v0.1.3, April 2, 2026 | Project-specific evaluations, correctness checks, scoped Git changes. |
| [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch/releases/tag/v1.7.0) | v1.7.0, August 31, 2026 | Persistent experiment records and recovery across context compaction. |

These are workflow references. No third-party research runner was installed. The v3.0.0 author explicitly does not claim demonstrated superiority over ordinary Codex or v2.9.0. Adaptation to DNS/hosting is an engineering inference, not a benchmark result.
