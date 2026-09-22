#!/usr/bin/env python3
"""Rewrite an ECS task-definition JSON to pin matching containers to a new image.

Fail closed: exits non-zero when no container image matches image_repo:*.
Keeps only RegisterTaskDefinition request keys so describe-task-definition
response metadata (taskDefinitionArn, revision, deregisteredAt, …) cannot
reach `aws ecs register-task-definition --cli-input-json`.
"""

from __future__ import annotations

import json
import sys

# Top-level members of RegisterTaskDefinitionRequest (botocore ecs 2014-11-13).
# Prefer an allowlist over popping known read-only keys: AWS adds response-only
# fields (e.g. deregisteredAt, deleteRequestedAt) that break ParamValidation.
REGISTER_TASK_DEFINITION_KEYS = frozenset(
    {
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
    }
)


def rewrite_task_definition(task_def: dict, image_uri: str, image_repo: str) -> dict:
    replaced = 0
    for container in task_def.get("containerDefinitions", []):
        image = container.get("image") or ""
        if image == image_uri or image.startswith(f"{image_repo}:"):
            container["image"] = image_uri
            replaced += 1
    if replaced == 0:
        raise SystemExit(
            f"No container image matching {image_repo}:* in task definition; refuse to guess."
        )
    print(f"Updated {replaced} container image(s) to {image_uri}")
    return {key: task_def[key] for key in task_def if key in REGISTER_TASK_DEFINITION_KEYS}


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(
            "usage: rewrite-ecs-task-def-image.py <image-uri> <image-repo> <src.json> <dst.json>",
            file=sys.stderr,
        )
        return 2
    image_uri, image_repo, src, dst = argv
    with open(src, encoding="utf-8") as handle:
        task_def = json.load(handle)
    rewritten = rewrite_task_definition(task_def, image_uri, image_repo)
    with open(dst, "w", encoding="utf-8") as handle:
        json.dump(rewritten, handle)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
