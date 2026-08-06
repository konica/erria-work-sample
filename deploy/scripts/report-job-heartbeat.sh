#!/usr/bin/env bash
#
# Publishes a completion heartbeat for a scheduled worker job (issue #62). The failure mode this
# guards against is silence, not error output: a cron job that stops firing produces no log and no
# alert on its own — cron mails failures to a local mailbox nobody reads, and a job that simply
# never runs again produces no failure to mail in the first place. So the signal isn't "did the
# job report an error" — it's "did the job complete at all, recently."
#
# Called from deploy/crontab with `&&`, chained after the job itself:
#   docker compose ... run --rm worker --job=followup-cadence && \
#     deploy/scripts/report-job-heartbeat.sh "Followup Cadence Heartbeat"
# `&&` means a non-zero exit from the job (main.ts's catch-all sets it on any thrown error) short-
# circuits the heartbeat — so a job that ran and failed looks the same, to Azure Monitor, as a job
# that never ran at all: no heartbeat data point either way. That's deliberate; the two failure
# modes both deserve the same alert, and error-output alerting is a separate, already-covered
# concern (each job logs its own errors to /var/log/erria/*.log per deploy/crontab).
#
# One custom metric per job (value always 1 — a presence signal, not a magnitude) via the same
# managed-identity mechanism report-disk-usage.sh/report-tls-expiry.sh already use (issue #61).
# infra/terraform/monitoring.tf alerts when a job's heartbeat metric has had zero data points over
# a window sized to that job's cadence, via `aggregation = "Count"`.
#
# Usage: report-job-heartbeat.sh "<Metric Name>"

set -euo pipefail

METRIC_NAME="${1:?usage: report-job-heartbeat.sh \"<Metric Name>\"}"

cd "$(dirname "${BASH_SOURCE[0]}")"
. ./lib-azure-metric.sh

publish_azure_metric "$METRIC_NAME" 1

echo "$(date -u +%FT%TZ) heartbeat published: ${METRIC_NAME}"
