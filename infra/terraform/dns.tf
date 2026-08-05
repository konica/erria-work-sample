# DNS is optional and data-sourced, never created here: this module never
# creates a DNS zone, and it does not assume Erria's domain is delegated to
# Azure DNS. If manage_dns_in_azure is false (the default), the human wires
# the outputted static IP into whatever external registrar/DNS provider
# already holds Erria's domain — a single A record, by hand or via that
# provider's own IaC.
#
# Do NOT point this at *.cloudapp.azure.com — that hostname was removed from
# the Public Suffix List, so its Let's Encrypt issuance shares azure.com's
# rate limit with every other Azure tenant (see ticket #56).

data "azurerm_dns_zone" "existing" {
  count               = var.manage_dns_in_azure ? 1 : 0
  name                = var.dns_zone_name
  resource_group_name = var.dns_zone_resource_group_name
}

resource "azurerm_dns_a_record" "review" {
  count               = var.manage_dns_in_azure ? 1 : 0
  name                = var.dns_record_name
  zone_name           = data.azurerm_dns_zone.existing[0].name
  resource_group_name = data.azurerm_dns_zone.existing[0].resource_group_name
  ttl                 = 300
  records             = [azurerm_public_ip.review.ip_address]
  tags                = var.tags
}
