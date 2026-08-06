#!/usr/bin/env bash
#
# Pushes the live TLS certificate's remaining-days-to-expiry to Azure Monitor as a custom metric
# (issue #61). "Caddy renews automatically" is a claim worth verifying independently — this reads
# the certificate Caddy is actually presenting over the wire via openssl, not Caddy's own state
# or logs, so a renewal that silently stops working is caught here even if Caddy never reports
# it failing. infra/terraform/monitoring.tf alerts on this metric at 14 days remaining.
#
# Run via cron once a day (deploy/crontab) as the deploy user, with .env already sourced —
# DEPLOY_DOMAIN is the only application config this needs; the rest comes from IMDS.

set -euo pipefail

: "${DEPLOY_DOMAIN:?set DEPLOY_DOMAIN — source .env first (see deploy/README.md), or export it directly}"

cd "$(dirname "${BASH_SOURCE[0]}")"
. ./lib-azure-metric.sh

END_DATE=$(echo | openssl s_client -servername "$DEPLOY_DOMAIN" -connect "${DEPLOY_DOMAIN}:443" 2>/dev/null \
  | openssl x509 -noout -enddate | cut -d= -f2)

if [ -z "$END_DATE" ]; then
  echo "report-tls-expiry: could not read a certificate from ${DEPLOY_DOMAIN}:443" >&2
  exit 1
fi

DAYS_REMAINING=$(( ($(date -d "$END_DATE" +%s) - $(date -u +%s)) / 86400 ))

publish_azure_metric 'TLS Certificate Days Remaining' "$DAYS_REMAINING"

echo "$(date -u +%FT%TZ) tls_days_remaining=${DAYS_REMAINING} domain=${DEPLOY_DOMAIN}"
