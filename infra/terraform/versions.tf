terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.100"
    }
  }

  # Bootstrapped once via infra/scripts/bootstrap-state.sh (plain `az` CLI, not
  # Terraform) to avoid the chicken-and-egg of Terraform managing the backend
  # it depends on. See infra/terraform/README.md.
  backend "azurerm" {
    resource_group_name  = "erria-tfstate"
    storage_account_name = "erriatfstate" # must be globally unique; override with -backend-config if taken
    container_name       = "tfstate"
    key                  = "review.tfstate"
  }
}

provider "azurerm" {
  features {}
}
