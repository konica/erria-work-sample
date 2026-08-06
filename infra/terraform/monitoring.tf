# Monitoring for issue #61 — sized for two people and one box, same constraint as budget.tf's
# action group. No Log Analytics workspace, no Application Insights, no agent: those were a
# managed-design cost line ($2.99/GB at Analytics tier) with no counterpart here.
#
# Memory and CPU-credit visibility need nothing in this file — "Available Memory Bytes" /
# "Available Memory Percentage" and "CPU Credits Consumed" / "CPU Credits Remaining" are
# host-level Microsoft.Compute/virtualMachines platform metrics, collected automatically for
# every VM with no agent and no diagnostic setting to enable (Azure Monitor reference docs,
# verified 2026-08 — see deploy/README.md's Monitoring section for exactly where to look and
# for the caveat that CPU-credit metrics only emit data on burstable (B-series) VMs, which
# var.vm_size's current default is not). That is also why disk usage has no equivalent
# built-in metric: guest-level free-space is not exposed at the host level at all, on any VM
# size, agent or not — only disk *throughput* (IOPS/bandwidth/latency) is. The disk and
# TLS-expiry alerts below work around that gap with one curl call from cron
# (deploy/scripts/report-disk-usage.sh, report-tls-expiry.sh) rather than an agent: the VM's own
# managed identity publishes a single custom metric per run, and nothing runs in between ticks.

resource "azurerm_monitor_action_group" "ops" {
  name                = "${var.resource_group_name}-ops-ag"
  resource_group_name = azurerm_resource_group.review.name
  short_name          = "reviewops"

  dynamic "email_receiver" {
    for_each = var.ops_alert_emails
    content {
      name          = "email-${email_receiver.key}"
      email_address = email_receiver.value
    }
  }
}

# "A resource, or its managed identity, can be granted Monitoring Metrics Publisher permissions
# on another resource. ... An example is allowing a resource to emit metrics about itself."
# (Azure Monitor custom-metrics REST API docs) — that's exactly this: the VM's own identity,
# scoped to the VM's own resource ID, so it can publish metrics about itself and nothing else.
resource "azurerm_role_assignment" "vm_publishes_own_metrics" {
  scope                = azurerm_linux_virtual_machine.review.id
  role_definition_name = "Monitoring Metrics Publisher"
  principal_id         = azurerm_linux_virtual_machine.review.identity[0].principal_id
}

resource "azurerm_monitor_metric_alert" "disk_usage" {
  name                = "${var.resource_group_name}-disk-usage-alert"
  resource_group_name = azurerm_resource_group.review.name
  scopes              = [azurerm_linux_virtual_machine.review.id]
  description         = "Root filesystem usage crossed ${var.disk_usage_alert_threshold_percent}% (issue #61). Postgres data, Docker images and container logs all share this one 64 GiB disk."
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "erria/host"
    metric_name      = "Disk Used Percentage"
    aggregation      = "Maximum"
    operator         = "GreaterThanOrEqual"
    threshold        = var.disk_usage_alert_threshold_percent
    # This is a custom metric this module's own cron script publishes, not a standard platform
    # metric — it does not exist yet at the moment `terraform apply` first creates this alert
    # (the VM hasn't booted and run a cron tick yet), so metric validation must be skipped or
    # the apply fails on a metric Azure has never seen.
    skip_metric_validation = true
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  depends_on = [azurerm_role_assignment.vm_publishes_own_metrics]
}

# --- Autonomous-send alerting gaps (issue #62) --------------------------------------------------
#
# §8's target-state design (docs/architecture/2026-08-02-azure-solution-architecture.md) predates
# autonomous sending entirely and says nothing about it. These six resources close that gap for
# this review deployment, reusing exactly the mechanism issue #61 already established: a cron
# script on the VM publishes a custom metric over the managed identity
# (deploy/scripts/lib-azure-metric.sh), and a metric alert here watches it. Two of the four
# app-level metrics (kill-switch state, send volume, audit backlog, Claude spend) need a database
# query, which the host itself can't do — apps/worker/src/jobs/report-alerting-metrics.ts computes
# them inside the worker container, and deploy/scripts/report-autonomous-alerting-metrics.sh
# forwards the result the same way the two scripts above forward host-level readings.

resource "azurerm_monitor_metric_alert" "followup_cadence_heartbeat" {
  name                = "${var.resource_group_name}-followup-cadence-heartbeat-alert"
  resource_group_name = azurerm_resource_group.review.name
  scopes              = [azurerm_linux_virtual_machine.review.id]
  description         = "Scheduled-job silence, not error output (issue #62) — cron mails failures to a local mailbox nobody reads, and a job that stops firing produces no failure to mail in the first place. Fires when the followup-cadence job (deploy/crontab, daily at 06:00 UTC) has published zero completion heartbeats in the last 24 hours."
  severity            = 1
  frequency           = "PT1H"
  window_size         = "P1D"

  criteria {
    metric_namespace = "erria/host"
    metric_name      = "Followup Cadence Heartbeat"
    # Count, not Maximum: the absence of data points is the signal, so this alerts on "fewer than
    # one heartbeat all day" rather than on any particular heartbeat value.
    aggregation            = "Count"
    operator               = "LessThan"
    threshold              = 1
    skip_metric_validation = true
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  depends_on = [azurerm_role_assignment.vm_publishes_own_metrics]
}

resource "azurerm_monitor_metric_alert" "audit_sample_maintenance_heartbeat" {
  name                = "${var.resource_group_name}-audit-sample-maintenance-heartbeat-alert"
  resource_group_name = azurerm_resource_group.review.name
  scopes              = [azurerm_linux_virtual_machine.review.id]
  description         = "Same reasoning as followup_cadence_heartbeat above (issue #62), for the audit-sample-maintenance job (deploy/crontab, daily at 06:05 UTC)."
  severity            = 1
  frequency           = "PT1H"
  window_size         = "P1D"

  criteria {
    metric_namespace       = "erria/host"
    metric_name            = "Audit Sample Maintenance Heartbeat"
    aggregation            = "Count"
    operator               = "LessThan"
    threshold              = 1
    skip_metric_validation = true
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  depends_on = [azurerm_role_assignment.vm_publishes_own_metrics]
}

resource "azurerm_monitor_metric_alert" "autonomous_kill_switch_state" {
  name                = "${var.resource_group_name}-autonomous-kill-switch-alert"
  resource_group_name = azurerm_resource_group.review.name
  scopes              = [azurerm_linux_virtual_machine.review.id]
  description         = "Notifies both team members whenever autonomousSendingEnabled flips, in either direction (issue #62) — the highest-consequence setting in the system, and 'somebody turned it on and nobody noticed' is the scenario worth spending an alert on. One rule covers both directions by construction: azurerm_monitor_metric_alert fires (Activated) the moment the metric crosses into the alert condition — the switch turning ON — and auto-resolves (Resolved, also notified) the moment it crosses back out — the switch turning OFF. Both notifications go to the same ops action group."
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "erria/host"
    metric_name      = "Autonomous Sending Enabled"
    aggregation      = "Maximum"
    # >= 1 (not just "> 0") because the metric is a boolean 0/1 presence value published every
    # tick by report-autonomous-alerting-metrics.sh — there's no third state to worry about.
    operator               = "GreaterThanOrEqual"
    threshold              = 1
    skip_metric_validation = true
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  depends_on = [azurerm_role_assignment.vm_publishes_own_metrics]
}

resource "azurerm_monitor_metric_alert" "autonomous_send_volume_anomaly" {
  name                = "${var.resource_group_name}-autonomous-send-volume-anomaly-alert"
  resource_group_name = azurerm_resource_group.review.name
  scopes              = [azurerm_linux_virtual_machine.review.id]
  description         = "A tripwire on an unexpected spike, not a cap (issue #62) — the autonomous-send design deliberately has no volume ceiling (docs/superpowers/specs/2026-08-03-autonomous-send-design.md §1), so this only asks a human to look. Dynamic Thresholds (not a fixed number) because there is no sensible fixed number to pick for a metric whose whole design point is having no ceiling; Azure learns the account's own historical pattern and alerts on deviation from it instead."
  severity            = 2
  frequency           = "PT15M"
  window_size         = "PT15M"

  dynamic_criteria {
    metric_namespace         = "erria/host"
    metric_name              = "Autonomous Sends"
    aggregation              = "Total"
    operator                 = "GreaterThan"
    alert_sensitivity        = "Medium"
    evaluation_total_count   = 4
    evaluation_failure_count = 3
    skip_metric_validation   = true
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  depends_on = [azurerm_role_assignment.vm_publishes_own_metrics]
}

resource "azurerm_monitor_metric_alert" "audit_sample_backlog" {
  name                = "${var.resource_group_name}-audit-sample-backlog-alert"
  resource_group_name = azurerm_resource_group.review.name
  scopes              = [azurerm_linux_virtual_machine.review.id]
  description         = "Sampling is worthless if nobody marks the samples (issue #62) — fires when the oldest unreviewed Tier 1 audit sample has been waiting longer than var.audit_sample_backlog_alert_threshold_hours. The design guarantees an account's first autonomous send is always sampled regardless of configured rate (§3), so that first sample appearing and being reviewed before this threshold is the signal that sampling works end to end."
  severity            = 2
  frequency           = "PT1H"
  window_size         = "PT6H"

  criteria {
    metric_namespace       = "erria/host"
    metric_name            = "Oldest Unreviewed Audit Sample Age Hours"
    aggregation            = "Maximum"
    operator               = "GreaterThanOrEqual"
    threshold              = var.audit_sample_backlog_alert_threshold_hours
    skip_metric_validation = true
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  depends_on = [azurerm_role_assignment.vm_publishes_own_metrics]
}

resource "azurerm_monitor_metric_alert" "claude_api_spend" {
  name                = "${var.resource_group_name}-claude-api-spend-alert"
  resource_group_name = azurerm_resource_group.review.name
  scopes              = [azurerm_linux_virtual_machine.review.id]
  description         = "Claude API spend threshold, separate from budget.tf's Azure Cost Management budget alert (issue #62) — different vendor, and per the ticket likely the larger number. Routed to the same budget action group as the Azure budget alert, not the ops one, since this is a spend concern for the same audience rather than an operational one. The value is an estimate derived from LlmCall token counts at list pricing (apps/worker/src/jobs/report-alerting-metrics.ts) — a ceiling, not the vendor's actual invoice, since introductory per-token pricing may apply for part of the billing period."
  severity            = 2
  frequency           = "PT1H"
  window_size         = "P1D"

  criteria {
    metric_namespace       = "erria/host"
    metric_name            = "Claude API Spend Estimate USD Month To Date"
    aggregation            = "Maximum"
    operator               = "GreaterThanOrEqual"
    threshold              = var.claude_api_spend_alert_threshold_usd
    skip_metric_validation = true
  }

  action {
    action_group_id = azurerm_monitor_action_group.budget.id
  }

  depends_on = [azurerm_role_assignment.vm_publishes_own_metrics]
}

resource "azurerm_monitor_metric_alert" "tls_expiry" {
  name                = "${var.resource_group_name}-tls-expiry-alert"
  resource_group_name = azurerm_resource_group.review.name
  scopes              = [azurerm_linux_virtual_machine.review.id]
  description         = "The public TLS certificate has ${var.tls_expiry_alert_threshold_days} days or fewer remaining (issue #61) — read from the live certificate by deploy/scripts/report-tls-expiry.sh, independently of whether Caddy's own renewal logs say it's fine."
  severity            = 1
  frequency           = "PT1H"
  window_size         = "P1D"

  criteria {
    metric_namespace       = "erria/host"
    metric_name            = "TLS Certificate Days Remaining"
    aggregation            = "Minimum"
    operator               = "LessThanOrEqual"
    threshold              = var.tls_expiry_alert_threshold_days
    skip_metric_validation = true
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  depends_on = [azurerm_role_assignment.vm_publishes_own_metrics]
}
