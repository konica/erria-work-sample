# Resource-group-scoped budget, not subscription-wide: this alert covers only
# this environment's Azure spend, so it isn't muddied by any other Azure
# activity on the subscription. It also only ever sees the Azure line — the
# separate Anthropic/Claude API bill is a different vendor and needs its own
# spend tracking; don't mistake this for full cost coverage.

resource "azurerm_monitor_action_group" "budget" {
  name                = "${var.resource_group_name}-budget-ag"
  resource_group_name = azurerm_resource_group.review.name
  short_name          = "reviewbudget"

  dynamic "email_receiver" {
    for_each = var.budget_alert_emails
    content {
      name          = "email-${email_receiver.key}"
      email_address = email_receiver.value
    }
  }
}

resource "azurerm_consumption_budget_resource_group" "review" {
  name              = "${var.resource_group_name}-budget"
  resource_group_id = azurerm_resource_group.review.id

  amount     = var.budget_amount_usd
  time_grain = "Monthly"

  time_period {
    start_date = formatdate("YYYY-MM-01'T'00:00:00Z", timestamp())
  }

  dynamic "notification" {
    for_each = { for pct in [50, 80, 100] : pct => pct }
    content {
      enabled        = true
      threshold      = notification.value
      operator       = "GreaterThanOrEqualTo"
      contact_groups = [azurerm_monitor_action_group.budget.id]
    }
  }

  lifecycle {
    ignore_changes = [time_period]
  }
}
