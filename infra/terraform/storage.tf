# Backup storage. This is the one resource in the module that must NOT go
# away on a routine `terraform destroy` between review cycles — prevent_destroy
# means destroy fails loudly on this resource by design. Retiring backups for
# real is a deliberate act: remove this lifecycle block (or -target everything
# else) rather than something a blanket destroy does by accident.

resource "azurerm_storage_account" "backups" {
  name                     = var.backup_storage_account_name
  resource_group_name      = azurerm_resource_group.review.name
  location                 = azurerm_resource_group.review.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
  tags                     = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "pg_backups" {
  name                  = "pg-backups"
  storage_account_name  = azurerm_storage_account.backups.name
  container_access_type = "private"
}
