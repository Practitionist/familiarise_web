#!/usr/bin/env bash
# #709 — money-cron failure alert.
#
# Originally this no-op'd with a warning whenever SLACK_OPS_WEBHOOK_URL was
# unset. That secret has never been provisioned, so for every cron failure to
# date the alert was a `::warning::` line buried in a log nobody reads — which
# is how reconcile-ledgers stayed red for twelve consecutive runs unnoticed.
#
# Two changes fix that without breaking forks and preview builds:
#   1. Sentry is a fallback sink. SENTRY_DSN is already provisioned, so a
#      failure now reaches an alerting surface even with Slack unconfigured.
#   2. For jobs that move or reconcile money, having NO sink at all is itself a
#      failure: the step exits non-zero so the run is visibly red rather than
#      quietly green-with-a-warning. Non-money jobs keep the old lenient
#      behaviour so forks and preview environments aren't punished.
#
# #1757 — the Sentry sink never delivered. It posted a bare event to the legacy
# `/api/<project>/store/` endpoint with an `X-Sentry-Auth` header, and Sentry
# answered 403 on every call (three weeks of process-payouts and payout
# reconciler failures went unpaged). The sink now speaks the envelope protocol
# (https://develop.sentry.dev/sdk/data-model/envelopes/): POST to
# `/api/<project>/envelope/` with `Content-Type: application/x-sentry-envelope`
# and a three-line body — an envelope header carrying the full DSN (which is
# how the request authenticates; no auth header is needed), an item header
# `{"type":"event"}`, and the event JSON whose `event_id` matches the header.
# A sink that fails is itself a red step: a dead sink must be visible.
#
# The DSN must name a project that exists. On 2026-09-20 the local `.env`
# SENTRY_DSN pointed at project 4509348818124800, which exists in no
# organisation: Relay answers 200 on the first envelope (accepted, then
# dropped) and `403 … with_reason: ProjectId` once its cache is warm, which is
# exactly the 403 the Actions runs saw. Rotate the secret to the live
# familiarise_web DSN (project 4511593990914048); see 07-required-secrets.md.
set -euo pipefail

# Fail fast on the known-dead DSN so a misconfigured secret can never look
# like a delivered page: Relay answers 200 on the first envelope (accepted,
# then dropped), which would otherwise set delivered=1 and exit 0. A dead
# sink is a red step for every job, money-critical or not. The live project
# is 4511593990914048.
case "${SENTRY_DSN:-}" in
  */4509348818124800|*/4509348818124800\?*)
    echo "::error::SENTRY_DSN names dead project 4509348818124800 — rotate to the live familiarise_web DSN (project 4511593990914048)" >&2
    exit 1
    ;;
esac

JOB_NAME="${1:-unknown job}"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"

# Jobs whose failure means money is unreconciled, unpaid, or unrefunded. Keep in
# sync with docs/enterprise/50-operations/07-required-secrets.md.
MONEY_CRITICAL_JOBS="
process-payouts
create-payout-batch
reconcile-payout-status
handle-stuck-payouts
reconcile-ledgers
reconcile-payment-status
reconcile-orphaned-confirmations
reconcile-pending-refunds
cascade-refund-earnings
reconcile-disputes
handle-lost-disputes
release-earnings
sync-payment-earnings
release-pending-trust-earnings
generate-subscription-invoices
settle-invoice-accruals
dunning
sweep-orphaned-topup-captures
cleanup-abandoned-payments
timeout-member-overages
sweep-abandoned-overage-charges
irp-uploader
msme-payment-alerts
"

is_money_critical() {
  echo "$MONEY_CRITICAL_JOBS" | grep -qx "$1"
}

delivered=0

# --- Sink 1: Slack (primary) -------------------------------------------------
if [ -n "${SLACK_OPS_WEBHOOK_URL:-}" ]; then
  # jq-built payload: printf interpolation produced malformed JSON for job
  # names containing quotes or backslashes.
  payload=$(jq -n --arg job "$JOB_NAME" --arg url "$RUN_URL" \
    '{text: (":rotating_light: *" + $job + "* failed.\n<" + $url + "|Run logs>")}')
  if curl -fsS -X POST -H 'Content-Type: application/json' -d "$payload" "$SLACK_OPS_WEBHOOK_URL"; then
    delivered=1
  else
    echo "::warning::Slack notification failed for ${JOB_NAME}"
  fi
fi

# --- Sink 2: Sentry (fallback) ----------------------------------------------
# Parse the DSN (https://<key>@<host>/<project_id>) and post one event as a
# Sentry envelope. Deliberately dependency-free: the runner has curl and jq
# but this step must not require `npm ci` to have succeeded.
sentry_sink_failed=0
if [ -n "${SENTRY_DSN:-}" ]; then
  dsn_key="$(echo "$SENTRY_DSN" | sed -E 's#^https?://([^@]+)@.*#\1#')"
  dsn_host="$(echo "$SENTRY_DSN" | sed -E 's#^https?://[^@]+@([^/]+)/.*#\1#')"
  dsn_project="$(echo "$SENTRY_DSN" | sed -E 's#.*/([0-9]+)$#\1#')"

  if [ -n "$dsn_key" ] && [ -n "$dsn_host" ] && [ -n "$dsn_project" ]; then
    level="error"
    if is_money_critical "$JOB_NAME"; then level="fatal"; fi
    # 32 lowercase hex chars; the envelope header and the event must carry the
    # same id or Sentry drops the item.
    event_id="$(uuidgen 2>/dev/null | tr -d - | tr 'A-F' 'a-f' || true)"
    if [[ -z "$event_id" ]]; then event_id="$(openssl rand -hex 16)"; fi
    sent_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    event=$(jq -cn \
      --arg job "$JOB_NAME" --arg url "$RUN_URL" --arg level "$level" \
      --arg event_id "$event_id" --arg ts "$sent_at" \
      '{
         event_id: $event_id,
         timestamp: $ts,
         message: ("cron failed: " + $job),
         level: $level,
         platform: "other",
         logger: "github-actions",
         tags: { subsystem: "cron", job: $job },
         extra: { run_url: $url }
       }')
    envelope_header=$(jq -cn --arg event_id "$event_id" --arg dsn "$SENTRY_DSN" --arg ts "$sent_at" \
      '{ event_id: $event_id, dsn: $dsn, sent_at: $ts }')
    item_header=$(jq -cn --arg len "$(printf '%s' "$event" | wc -c | tr -d ' ')" \
      '{ type: "event", content_type: "application/json", length: ($len | tonumber) }')
    envelope="$(printf '%s\n%s\n%s\n' "$envelope_header" "$item_header" "$event")"
    if curl -fsS -X POST \
        -H 'Content-Type: application/x-sentry-envelope' \
        --data-binary "$envelope" \
        "https://${dsn_host}/api/${dsn_project}/envelope/" >/dev/null; then
      delivered=1
      echo "::notice::Sentry event ${event_id} recorded for ${JOB_NAME}"
    else
      sentry_sink_failed=1
      echo "::warning::Sentry notification failed for ${JOB_NAME}"
    fi
  else
    sentry_sink_failed=1
    echo "::warning::SENTRY_DSN is set but could not be parsed for ${JOB_NAME}"
  fi
fi

# --- No sink reached ---------------------------------------------------------
if [ "$delivered" -eq 1 ]; then
  exit 0
fi

# #1757 — a configured Sentry sink that did not accept the event is a dead
# sink; the step goes red so nobody mistakes "warned in a log" for "paged".
if [[ "$sentry_sink_failed" -eq 1 ]]; then
  echo "::error::${JOB_NAME} failed and the Sentry sink rejected the event — the alert path itself is broken" >&2
  exit 1
fi

if is_money_critical "$JOB_NAME"; then
  echo "::error::${JOB_NAME} failed and NO alert sink is configured (SLACK_OPS_WEBHOOK_URL and SENTRY_DSN both unset or unreachable). A money job failing silently is itself an incident — see docs/enterprise/50-operations/07-required-secrets.md"
  exit 1
fi

echo "::warning::No alert sink configured — failure for ${JOB_NAME} was not paged"
exit 0
