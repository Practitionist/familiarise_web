#!/usr/bin/env bash
# #709 — money-cron failure alert. No-op (with a visible warning) when the
# webhook secret isn't provisioned, so forks/previews don't fail the step.
set -euo pipefail

JOB_NAME="${1:-unknown job}"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"

if [ -z "${SLACK_OPS_WEBHOOK_URL:-}" ]; then
  echo "::warning::SLACK_OPS_WEBHOOK_URL not set — money-cron failure NOT paged (${JOB_NAME})"
  exit 0
fi

payload=$(printf '{"text":":rotating_light: *%s* failed.\n<%s|Run logs>"}' "$JOB_NAME" "$RUN_URL")
curl -fsS -X POST -H 'Content-Type: application/json' -d "$payload" "$SLACK_OPS_WEBHOOK_URL" \
  || echo "::warning::Slack notification failed for ${JOB_NAME}"
