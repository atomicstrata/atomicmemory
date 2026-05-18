# Security Policy

## Reporting A Vulnerability

Report suspected vulnerabilities through GitHub private vulnerability reporting
for this repository. Do not open a public issue with exploit details, tokens,
private logs, or sensitive deployment information.

If private vulnerability reporting is not enabled during pre-cutover staging,
use the security contact published by the affected released package or its
public documentation. Public issues may be used only for non-sensitive security
hardening requests.

## Public Boundary

This repository must not contain private credentials, private service
configuration, private release orchestration, or local developer-machine paths.
Security and compliance checks in CI are public-safe and must not require
private credentials.
