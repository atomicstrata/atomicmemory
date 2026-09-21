#!/usr/bin/env bash
# Roll one Core ECS service to a new image URI and record it in SSM.
#
# Usage:
#   roll-core-ecs-image.sh <image-uri> <image-repo> <ssm-param> <cluster> <service>
#
# Fail closed: refuses to update if no container image matches image-repo:*.
set -euo pipefail

if [[ "$#" -ne 5 ]]; then
  echo "usage: $0 <image-uri> <image-repo> <ssm-param> <cluster> <service>" >&2
  exit 2
fi

image_uri="$1"
image_repo="$2"
ssm_param="$3"
cluster="$4"
service="$5"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

task_def_arn="$(aws ecs describe-services \
  --cluster "${cluster}" \
  --services "${service}" \
  --query 'services[0].taskDefinition' \
  --output text)"
if [[ -z "${task_def_arn}" || "${task_def_arn}" == "None" ]]; then
  echo "::error::No task definition found for ${cluster}/${service}" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

aws ecs describe-task-definition \
  --task-definition "${task_def_arn}" \
  --query 'taskDefinition' \
  > "${tmp_dir}/task-def.json"

python3 "${here}/rewrite-ecs-task-def-image.py" \
  "${image_uri}" \
  "${image_repo}" \
  "${tmp_dir}/task-def.json" \
  "${tmp_dir}/task-def-new.json"

new_arn="$(aws ecs register-task-definition \
  --cli-input-json "file://${tmp_dir}/task-def-new.json" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)"

aws ecs update-service \
  --cluster "${cluster}" \
  --service "${service}" \
  --task-definition "${new_arn}" \
  --force-new-deployment \
  >/dev/null

aws ssm put-parameter \
  --name "${ssm_param}" \
  --type String \
  --value "${image_uri}" \
  --overwrite

echo "ECS updated: ${cluster}/${service} -> ${new_arn} (${image_uri})"
echo "SSM ${ssm_param}=${image_uri}"
