# Resource group, VNet, subnet and NSG for the single review VM.
#
# One /27 subnet is plenty for one NIC. The NSG is attached at the subnet,
# not the NIC, since there is exactly one NIC in this topology and a
# subnet-level attachment is one fewer association to keep in sync.

# RegionIsOfferRestricted (new subscriptions can be blocked from B-series SKUs
# in a given region) is an ARM-level, apply-time rejection — the azurerm
# provider has no data source that exposes SKU-offer restrictions, so this
# can't be caught at plan time. Run this once before a first apply:
#   az vm list-skus --location centralus --size Standard_D2als_v6 --all -o table
# A restriction shows up in the `restrictions` column; it's resolved via an
# Azure support request, not a code change.

resource "azurerm_resource_group" "review" {
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

resource "azurerm_virtual_network" "review" {
  name                = "${var.resource_group_name}-vnet"
  location            = azurerm_resource_group.review.location
  resource_group_name = azurerm_resource_group.review.name
  address_space       = ["10.20.0.0/24"]
  tags                = var.tags
}

resource "azurerm_subnet" "review" {
  name                 = "review-vm"
  resource_group_name  = azurerm_resource_group.review.name
  virtual_network_name = azurerm_virtual_network.review.name
  address_prefixes     = ["10.20.0.0/27"]
}

resource "azurerm_network_security_group" "review" {
  name                = "${var.resource_group_name}-nsg"
  location            = azurerm_resource_group.review.location
  resource_group_name = azurerm_resource_group.review.name
  tags                = var.tags

  security_rule {
    name                   = "AllowSSH"
    priority               = 100
    direction              = "Inbound"
    access                 = "Allow"
    protocol               = "Tcp"
    source_port_range      = "*"
    destination_port_range = "22"
    # Azure rejects "*" (or other tag values) on the plural source_address_prefixes
    # field — it's only valid on the singular source_address_prefix. Use the
    # singular field for the default single-value case (typically "*") and only
    # switch to the plural list once it's tightened to more than one real CIDR.
    source_address_prefix      = length(var.ssh_source_address_prefixes) == 1 ? var.ssh_source_address_prefixes[0] : null
    source_address_prefixes    = length(var.ssh_source_address_prefixes) == 1 ? null : var.ssh_source_address_prefixes
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "AllowHTTP"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "AllowHTTPS"
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  # Default-deny for everything else is implicit in every NSG's built-in
  # DenyAllInBound rule (priority 65500) — no explicit deny rule needed.
}

resource "azurerm_subnet_network_security_group_association" "review" {
  subnet_id                 = azurerm_subnet.review.id
  network_security_group_id = azurerm_network_security_group.review.id
}
