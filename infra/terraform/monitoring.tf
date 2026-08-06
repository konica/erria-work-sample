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
