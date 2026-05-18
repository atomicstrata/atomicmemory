# Security Policy

## Reporting A Vulnerability

Report suspected vulnerabilities through this repository's GitHub vulnerability
reporting flow. Do not open a public issue with exploit details, tokens,
sensitive logs, or deployment information.

If that reporting flow is unavailable, use the security contact published by
the affected package or its public documentation. Public issues may be used only
for non-sensitive security hardening requests.

## Public Boundary

This repository must not contain credentials, sensitive service configuration,
release orchestration, or local machine paths. Security and compliance checks in
CI are public-safe and must not require protected credentials.
