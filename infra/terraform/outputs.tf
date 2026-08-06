output "public_ip_address" {
  description = "The VM's static public IP. Point the DNS A record here if DNS is managed outside Azure, and feed this to ticket #58's deploy workflow as the SSH target."
  value       = azurerm_public_ip.review.ip_address
}

output "resource_group_name" {
  value = azurerm_resource_group.review.name
}

output "admin_username" {
  description = "The VM's deploy user (var.admin_username) — feed this to ticket #58's deploy workflow as DEPLOY_SSH_USER."
  value       = azurerm_linux_virtual_machine.review.admin_username
}

output "vm_name" {
  value = azurerm_linux_virtual_machine.review.name
}

output "backup_storage_account_name" {
  description = "Storage account holding nightly pg_dump backups (ticket #60)."
  value       = azurerm_storage_account.backups.name
}

output "backup_container_name" {
  value = azurerm_storage_container.pg_backups.name
}

output "dns_fqdn" {
  description = "Null unless manage_dns_in_azure is true, in which case this is the record Terraform created."
  value       = var.manage_dns_in_azure ? azurerm_dns_a_record.review[0].fqdn : null
}
