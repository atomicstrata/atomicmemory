/**
 * Coverage for scripts/ci/rewrite-ecs-task-def-image.py.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const SCRIPT = "scripts/ci/rewrite-ecs-task-def-image.py";
const REPO = "636941960505.dkr.ecr.us-east-1.amazonaws.com/atomicmemory-core-enterprise";
const NEW_URI = `${REPO}:sha-abcdef0`;

/** Top-level RegisterTaskDefinitionRequest members (botocore ecs 2014-11-13). */
const REGISTER_TASK_DEFINITION_KEYS = new Set([
  "containerDefinitions",
  "cpu",
  "enableFaultInjection",
  "ephemeralStorage",
  "executionRoleArn",
  "family",
  "inferenceAccelerators",
  "ipcMode",
  "memory",
  "networkMode",
  "pidMode",
  "placementConstraints",
  "proxyConfiguration",
  "requiresCompatibilities",
  "runtimePlatform",
  "tags",
  "taskRoleArn",
  "volumes",
]);

/** Response-only TaskDefinition members that must never reach register. */
const DESCRIBE_RESPONSE_ONLY_KEYS = [
  "compatibilities",
  "deleteRequestedAt",
  "deregisteredAt",
  "registeredAt",
  "registeredBy",
  "requiresAttributes",
  "revision",
  "status",
  "taskDefinitionArn",
];

function runRewrite(taskDef) {
  const dir = mkdtempSync(join(tmpdir(), "roll-core-ecs-"));
  const src = join(dir, "in.json");
  const dst = join(dir, "out.json");
  writeFileSync(src, JSON.stringify(taskDef));
  const result = spawnSync("python3", [SCRIPT, NEW_URI, REPO, src, dst], { encoding: "utf8" });
  return { result, dst };
}

test("rewrites matching enterprise core image and keeps only register keys", () => {
  const responseOnly = Object.fromEntries(
    DESCRIBE_RESPONSE_ONLY_KEYS.map((key) => [key, key === "revision" ? 9 : `value-${key}`]),
  );
  const { result, dst } = runRewrite({
    ...responseOnly,
    family: "atomicmemory-core",
    taskRoleArn: "arn:aws:iam::123:role/task",
    executionRoleArn: "arn:aws:iam::123:role/exec",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "1024",
    memory: "2048",
    runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
    containerDefinitions: [
      { name: "sidecar", image: "public.ecr.aws/x/y:1" },
      { name: "atomicmemory-core", image: `${REPO}:c7b25cf` },
    ],
    volumes: [],
    // Future AWS response junk must also be dropped by the allowlist.
    unexpectedAwsField: "must-not-survive",
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(readFileSync(dst, "utf8"));
  assert.equal(out.containerDefinitions[1].image, NEW_URI);
  assert.equal(out.containerDefinitions[0].image, "public.ecr.aws/x/y:1");
  assert.equal(out.family, "atomicmemory-core");
  assert.equal(out.cpu, "1024");
  assert.equal(out.unexpectedAwsField, undefined);
  for (const key of DESCRIBE_RESPONSE_ONLY_KEYS) {
    assert.equal(out[key], undefined, `response-only key ${key} must be stripped`);
  }
  for (const key of Object.keys(out)) {
    assert.ok(
      REGISTER_TASK_DEFINITION_KEYS.has(key),
      `output key ${key} is not a RegisterTaskDefinitionRequest member`,
    );
  }
});

test("fails closed when no container matches the enterprise repo", () => {
  const { result } = runRewrite({
    family: "atomicmemory-core",
    containerDefinitions: [{ name: "api", image: "ghcr.io/atomicstrata/atomicmemory-core:1.2.1" }],
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /No container image matching/);
});
