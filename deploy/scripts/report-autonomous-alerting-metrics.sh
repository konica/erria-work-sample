#!/usr/bin/env bash
#
# Publishes the four autonomous-send alerting metrics that only the application can compute
# (issue #62) — the kill switch's current state, autonomous send volume, the audit-sample review
# backlog, and estimated Claude API spend. Unlike disk usage and TLS expiry (issue #61), none of
# these are readable from the host: they all need a database query, so
# `apps/worker/src/jobs/report-alerting-metrics.ts` (run in-container, where Prisma already is)
# computes them and prints one `KEY=VALUE` line per metric to stdout; this script's only job is to
# run that container, parse its stdout, and forward each value to Azure Monitor over the VM's
# managed identity — the same `lib-azure-metric.sh` report-disk-usage.sh and report-tls-expiry.sh
# already use. Nothing runs between cron ticks; this still isn't "an agent" in the sense issue #61
# ruled out.
#
# Deliberately not gated behind `&&` on the docker compose run the way the two job heartbeats are
# (deploy/crontab) — a metrics-collection failure here doesn't get its own heartbeat-absence alert,
# the same choice already made for report-disk-usage.sh/report-tls-expiry.sh. If this script's own
# cron entry stops firing, every alert fed by it goes stale silently; accepted for a two-person
# team's one box, consistent with issue #61's stated scope, rather than adding a heartbeat for the
# heartbeat mechanism itself.
#
# Run via cron every 5 minutes (deploy/crontab) from /opt/erria.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib-azure-metric.sh
. "${SCRIPT_DIR}/lib-azure-metric.sh"

OUTPUT=$(docker compose -f compose.yaml -f compose.deploy.yaml run --rm worker --job=autonomous-alerting-metrics)
echo "$OUTPUT"

publish_metric() {
  local key="$1" metric_name="$2" value
  value=$(printf '%s\n' "$OUTPUT" | sed -n "s/^${key}=//p")
  if [ -z "$value" ]; then
    echo "report-autonomous-alerting-metrics: missing ${key} in job output — skipping '${metric_name}'" >&2
    return 0
  fi
  publish_azure_metric "$metric_name" "$value"
}

publish_metric 'AUTONOMOUS_SENDING_ENABLED' 'Autonomous Sending Enabled'
publish_metric 'AUTONOMOUS_SENDS_IN_WINDOW' 'Autonomous Sends'
publish_metric 'OLDEST_UNREVIEWED_AUDIT_SAMPLE_AGE_HOURS' 'Oldest Unreviewed Audit Sample Age Hours'
publish_metric 'CLAUDE_API_SPEND_ESTIMATE_USD_MONTH_TO_DATE' 'Claude API Spend Estimate USD Month To Date'
