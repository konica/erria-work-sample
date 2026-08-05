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
    resource_group_name  = "erria-tfstate-us"
    storage_account_name = "erriatfstateus" # must be globally unique; override with -backend-config if taken
    container_name       = "tfstate"
    key                  = "review.tfstate"
  }
}

provider "azurerm" {
  features {}

  # The provider otherwise tries to auto-register ~40+ resource providers it
  # supports on every run, including many this module never touches
  # (ApiManagement, MachineLearningServices, ...). We register exactly what
  # we need by hand (Storage, Compute, Network, Insights — see
  # infra/terraform/README.md); this only opts out of the blanket attempt.
  # (skip_provider_registration, not resource_provider_registrations, on
  # provider versions pinned to the 3.x series — the latter is a v4-only argument.)
  skip_provider_registration = true
}
