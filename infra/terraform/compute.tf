# Static public IP, NIC, and the review VM itself.
#
# The IP must be Standard SKU + Static allocation — a dynamic IP changes on
# stop/deallocate and silently breaks both the DNS A record and Caddy's TLS
# renewal (see ticket #56).

resource "azurerm_public_ip" "review" {
  name                = "${var.resource_group_name}-pip"
  location            = azurerm_resource_group.review.location
  resource_group_name = azurerm_resource_group.review.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_network_interface" "review" {
  name                = "${var.resource_group_name}-nic"
  location            = azurerm_resource_group.review.location
  resource_group_name = azurerm_resource_group.review.name
  tags                = var.tags

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.review.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.review.id
  }
}

resource "azurerm_linux_virtual_machine" "review" {
  name                = "${var.resource_group_name}-vm"
  location            = azurerm_resource_group.review.location
  resource_group_name = azurerm_resource_group.review.name
  size                = var.vm_size
  admin_username      = var.admin_username
  tags                = var.tags

  network_interface_ids = [azurerm_network_interface.review.id]

  # Password auth disabled at the platform level — not merely unconfigured.
  disable_password_authentication = true

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = var.os_disk_size_gb
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
    admin_username = var.admin_username
    swap_size_mb   = var.swap_size_mb
  }))

  depends_on = [azurerm_subnet_network_security_group_association.review]
}
