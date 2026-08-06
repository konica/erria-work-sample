# Shared by deploy/scripts/report-*.sh (issue #61). Publishes one custom-metric data point to
# Azure Monitor for the review VM's own resource, authenticated with the VM's system-assigned
# managed identity via IMDS — a single curl call per invocation, not a persistent process. That
# distinction is load-bearing: issue #61 explicitly rules out Log Analytics/App Insights/an
# agent on cost grounds, and this never adds one — the identity needs the "Monitoring Metrics
# Publisher" role on this VM (infra/terraform/monitoring.tf), and nothing runs between cron
# ticks. Source this file; it defines publish_azure_metric but runs nothing on its own.

publish_azure_metric() {
  local metric_name="$1" value="$2"
  local token instance resource_id location timestamp

  token=$(curl -sf -H 'Metadata: true' \
    'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fmonitoring.azure.com%2F' \
    | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

  # /compute's `resourceId` and `location` fields (api-version 2021-02-01) give us the exact
  # ARM resource ID and the region the custom-metrics endpoint must match — built by hand
  # elsewhere in this repo (deploy.sh's COMPOSE_PROJECT_NAME), but IMDS already has both, so
  # there's nothing to reconstruct or keep in sync with Terraform's naming.
  instance=$(curl -sf -H 'Metadata: true' \
    'http://169.254.169.254/metadata/instance/compute?api-version=2021-02-01')
  resource_id=$(echo "$instance" | grep -o '"resourceId":"[^"]*"' | cut -d'"' -f4)
  location=$(echo "$instance" | grep -o '"location":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$token" ] || [ -z "$resource_id" ] || [ -z "$location" ]; then
    echo "publish_azure_metric: could not read IMDS token/resourceId/location — is this running on the VM with the identity role assigned?" >&2
    return 1
  fi

  timestamp=$(date -u +%Y-%m-%dT%H:%M:%S)

  # Single instantaneous reading, so min = max = sum = value, count = 1 (the REST API wants a
  # pre-aggregated point, not a raw sample — see the API docs' "Metric values" section).
  curl -sf -X POST "https://${location}.monitoring.azure.com${resource_id}/metrics" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${token}" \
    -d "{\"time\":\"${timestamp}\",\"data\":{\"baseData\":{\"metric\":\"${metric_name}\",\"namespace\":\"erria/host\",\"dimNames\":[],\"series\":[{\"dimValues\":[],\"min\":${value},\"max\":${value},\"sum\":${value},\"count\":1}]}}}" \
    > /dev/null
}
