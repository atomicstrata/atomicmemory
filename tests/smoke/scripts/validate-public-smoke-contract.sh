#!/usr/bin/env bash
# Validate the public AtomicMemory smoke contract without invoking release
# orchestration. This script checks the data shape and release-facing
# invariants that public CI and docs checks can safely enforce.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT="${ROOT}/docs-contract/public-smoke-contract.json"

if [ ! -f "${CONTRACT}" ]; then
  echo "FATAL: ${CONTRACT} not found" >&2
  exit 1
fi

jq -e '.schema_version == "atomicmemory-public-smoke-contract.v1"' "${CONTRACT}" >/dev/null
jq -e '.release_readiness.full_suite_required == true' "${CONTRACT}" >/dev/null
jq -e '.release_readiness.partial_runs == "diagnostic_only"' "${CONTRACT}" >/dev/null
jq -e '([.rows[].name] | length) == ([.rows[].name] | unique | length)' "${CONTRACT}" >/dev/null

jq -e '
  all(.rows[];
    (.kind | IN("package", "adapter", "plugin")) and
    (.name | type == "string" and length > 0) and
    (.monorepo_path | test("^(packages|adapters|plugins)/[a-z0-9-]+$")) and
    (.required_for_public_release | type == "boolean") and
    (.coverage_label | IN("package_protocol", "host_install", "true_host_e2e", "skipped_host_missing", "skipped_missing_secret")) and
    (.publish_status | IN("published", "implemented_publish_pending", "coming_soon")) and
    (.install_type | type == "string" and length > 0) and
    ((.public_install_command == null) or (.public_install_command | type == "string" and length > 0))
  )
' "${CONTRACT}" >/dev/null

jq -e '
  all(.rows[] | select(.publish_status == "published");
    (.registry_artifact | type == "string" and length > 0))
' "${CONTRACT}" >/dev/null

jq -e '
  all(.rows[] | select(.publish_status != "published");
    .public_install_command == null)
' "${CONTRACT}" >/dev/null

jq -e '
  all(.rows[] | select(.name | IN("@atomicmemory/langchain", "@atomicmemory/langgraph", "@atomicmemory/mastra"));
    .publish_status == "published" and
    .required_for_public_release == true and
    (.registry_artifact | type == "string" and length > 0) and
    (.public_install_command | type == "string" and length > 0))
' "${CONTRACT}" >/dev/null

jq -e '
  all(.rows[] | select(.name | IN("@atomicmemory/codex-plugin", "@atomicmemory/cursor-plugin"));
    .publish_status == "coming_soon" and
    .required_for_public_release == false and
    .registry_artifact == null and
    .public_install_command == null)
' "${CONTRACT}" >/dev/null

jq -e '
  all(.rows[] | select(.required_for_public_release == true);
    .coverage_label != "skipped_host_missing")
' "${CONTRACT}" >/dev/null

echo "PASS: public smoke contract is valid"
