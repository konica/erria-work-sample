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

# What lets deploy/scripts/backup-postgres.sh upload at all (issue #60). The nightly job holds no
# storage key and no SAS token: it asks IMDS for a token for https://storage.azure.com/ using the
# VM's own system-assigned identity, exactly as deploy/scripts/lib-azure-metric.sh already does for
# custom metrics, and this assignment is the other half of that. Without it the script fails on the
# first PUT with 403 and raises its own failure alert — which is the correct behaviour, but the
# cause is here rather than in the script.
#
# Scoped to the container, not the storage account: this identity has no business reading or
# writing anything else that ever lands in this account.
#
# "Storage Blob Data Contributor" rather than Owner or a broader role because the job needs exactly
# write, read-back (the HEAD that confirms what landed), list and delete on blobs — the delete is
# what rules out the read-only "Storage Blob Data Reader" and the append-only alternatives, since
# retention is applied by deleting expired dumps.
resource "azurerm_role_assignment" "vm_writes_pg_backups" {
  scope                = azurerm_storage_container.pg_backups.resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_linux_virtual_machine.review.identity[0].principal_id
}
