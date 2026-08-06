variable "location" {
  description = "Azure region. ADR-0007 specifies West Europe for GDPR data residency, but this subscription hit RegionIsOfferRestricted on nearly every VM SKU in every EU/APAC region checked, plus a 0 vCPU quota on the few SKUs that were offered (Bsv2, DASv5, DCasv6, ...) everywhere. Central US is the one region found where the D-series v6/v7 lineup is both unrestricted AND has real quota right now, with no quota-increase request or wait needed. A deliberate, PM-approved deviation from the EU-residency default for this MVP phase, not an oversight. Revisit once the subscription's region/SKU restrictions lift."
  type        = string
  default     = "centralus"
}

variable "resource_group_name" {
  description = "Resource group holding every resource this module creates."
  type        = string
  default     = "erria-review"
}

variable "vm_size" {
  description = "VM SKU. ADR-0007 specifies Standard_B2s (2 vCPU/4 GiB, ~$35/mo), but it's RegionIsOfferRestricted subscription-wide on the current subscription in every region checked, and its Bsv2 cousin has 0 quota everywhere too. Standard_D2als_v6 (2 vCPU/4 GiB, AMD, ~$66/mo compute in Central US) is unrestricted with real quota in Central US specifically — it matches the doc's original 4 GiB memory budget exactly, and being a non-burstable D-series SKU, doesn't carry the B-series CPU-credit-throttling caveat the deployment design flagged for Keycloak startup / migrations. All-in cost is ~$75/mo vs. the ticket's ~$44/mo estimate, driven by the region/SKU swap, not by oversizing. Re-check availability with `az vm list-skus --location <location> --size Standard_B2s --all -o table` if this subscription's restrictions ever lift."
  type        = string
  default     = "Standard_D2als_v6"
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
  description = "Public half of the deploy SSH key. Must be RSA — Azure's VM SSH-key provisioning rejects ed25519 keys outright ('Only RSA SSH keys are supported by Azure'), even though the VM's own OpenSSH server would accept either once running. Pass via TF_VAR_admin_ssh_public_key — never commit this in a .tfvars file."
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
  description = "Monthly Azure Cost Management budget for this resource group. Default has headroom over the ~$75/month Central US + Standard_D2als_v6 estimate (revised up from the ticket's original ~$44/month West Europe + Standard_B2s figure due to subscription SKU/region restrictions); this alert covers Azure spend only, not the separate Anthropic/Claude API bill."
  type        = number
  default     = 95
}

variable "budget_alert_emails" {
  description = "Email addresses notified at 50/80/100% of the budget."
  type        = list(string)
  default     = ["dtrungthao@gmail.com"]
}

variable "ops_alert_emails" {
  description = "Email addresses notified by the disk-usage and TLS-expiry alerts (issue #61). Kept separate from budget_alert_emails so ops and spend alerts could go to different lists if that's ever wanted; defaults to the same single address until a second teammate's email is confirmed — the ticket asks for both team members to be alerted."
  type        = list(string)
  default     = ["dtrungthao@gmail.com"]
}

variable "disk_usage_alert_threshold_percent" {
  description = "Root-filesystem used-percentage that fires the disk alert (issue #61's acceptance criterion is exactly 80%). Postgres data, Docker images and container logs all share this one disk."
  type        = number
  default     = 80
}

variable "tls_expiry_alert_threshold_days" {
  description = "Days-remaining-until-expiry that fires the TLS alert (issue #61). 14 days gives a full ACME retry window's worth of slack before a Let's Encrypt certificate (90-day validity, renewed automatically by Caddy around day 60) would actually lapse."
  type        = number
  default     = 14
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
