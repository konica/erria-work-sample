variable "location" {
  description = "Azure region. West Europe by default for GDPR data residency (Erria is Danish, data includes EU business contacts)."
  type        = string
  default     = "westeurope"
}

variable "resource_group_name" {
  description = "Resource group holding every resource this module creates."
  type        = string
  default     = "erria-review"
}

variable "vm_size" {
  description = "VM SKU. Standard_B2s per ADR-0007 / the MVP deployment design — do not resize casually, the memory budget in that doc assumes 4 GiB."
  type        = string
  default     = "Standard_B2s"
}

variable "os_disk_size_gb" {
  description = "OS disk size in GB. 64 GiB Standard SSD (E6) per the ticket's cost model."
  type        = number
  default     = 64
}

variable "admin_username" {
  description = "The VM's admin/deploy user. Not root; SSH-key-only, password auth disabled."
  type        = string
  default     = "deploy"
}

variable "admin_ssh_public_key" {
  description = "Public half of the deploy SSH key. Pass via TF_VAR_admin_ssh_public_key — never commit this in a .tfvars file."
  type        = string
  sensitive   = true
}

variable "ssh_source_address_prefixes" {
  description = "CIDR ranges allowed to reach port 22. Defaults to any source; tighten this to a known admin IP/range once one exists."
  type        = list(string)
  default     = ["*"]
}

variable "swap_size_mb" {
  description = "Swap file size in MB, provisioned as insurance against a Keycloak JVM spike, not routine capacity."
  type        = number
  default     = 2048
}

variable "backup_storage_account_name" {
  description = "Name of the storage account used for nightly pg_dump backups. Must be globally unique, lowercase, 3-24 chars, alphanumeric only — override this default before applying for real."
  type        = string
  default     = "erriareviewbackups"
}

variable "manage_dns_in_azure" {
  description = "If true, this module creates the A record in an Azure DNS zone (data-sourced, not created here). If false, the module only outputs the static IP for the human to point an external DNS provider at."
  type        = bool
  default     = false
}

variable "dns_zone_name" {
  description = "Existing Azure DNS zone name (e.g. erria.com). Required when manage_dns_in_azure is true."
  type        = string
  default     = null
}

variable "dns_zone_resource_group_name" {
  description = "Resource group that owns the existing Azure DNS zone. Required when manage_dns_in_azure is true."
  type        = string
  default     = null
}

variable "dns_record_name" {
  description = "Subdomain record name relative to the zone (e.g. 'outreach' for outreach.erria.com). Required when manage_dns_in_azure is true."
  type        = string
  default     = null
}

variable "budget_amount_usd" {
  description = "Monthly Azure Cost Management budget for this resource group. Default has headroom over the ~$44/month estimate; this alert covers Azure spend only, not the separate Anthropic/Claude API bill."
  type        = number
  default     = 60
}

variable "budget_alert_emails" {
  description = "Email addresses notified at 50/80/100% of the budget — override this default before applying for real."
  type        = list(string)
  default     = ["ops@erria.example"]
}

variable "tags" {
  description = "Tags applied to every resource this module creates."
  type        = map(string)
  default = {
    project     = "erria-outreach-agent"
    environment = "review"
    managed-by  = "terraform"
  }
}
