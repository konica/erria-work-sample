#!/usr/bin/env bash
#
# Pushes the root filesystem's used-percentage to Azure Monitor as a custom metric (issue #61).
# Postgres data, Docker images and container logs all share this one 64 GiB disk, which is why
# exhaustion here is the deployment design's top-ranked self-inflicted-outage risk.
#
# Azure's own platform (host-level, no-agent) VM metrics do not include guest disk-space-used —
# only throughput/IOPS/latency for the disk device, which says nothing about how full it is.
# Guest-level free-space metrics normally require the Azure Monitor Agent, which issue #61
# explicitly rules out on cost/complexity grounds. This script is the no-agent alternative: cron
# runs it every 5 minutes (deploy/crontab), it reads `df` locally and publishes one number, and
# nothing runs in between. infra/terraform/monitoring.tf alerts on this metric at 80%.
#
# Run via cron as the deploy user; needs no .env — IMDS supplies everything else.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
. ./lib-azure-metric.sh

USED_PERCENT=$(df --output=pcent / | tail -1 | tr -dc '0-9')

publish_azure_metric 'Disk Used Percentage' "$USED_PERCENT"

echo "$(date -u +%FT%TZ) disk_used_percent=${USED_PERCENT}"
