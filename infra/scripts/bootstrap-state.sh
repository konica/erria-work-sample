#!/usr/bin/env bash
# One-time setup of the Terraform remote state backend. Run once, by a human
# with an authenticated `az login`, before the first `terraform init` in
# infra/terraform/. Deliberately plain az CLI, not Terraform — the backend
# can't manage its own storage account.
#
# Safe to re-run: every step no-ops if the resource already exists.
set -euo pipefail

RESOURCE_GROUP="erria-tfstate"
# centralindia, not westeurope: the current subscription's storage account
# creation is blocked in West Europe ("region not accepting new customers"),
# matching the same subscription-wide restriction that forced the VM SKU/
# region choice in infra/terraform/variables.tf. Keep this in sync with that
# file's `location` default.
LOCATION="centralindia"
STORAGE_ACCOUNT="erriatfstate" # must be globally unique; if taken, pick another
                                 # and pass -backend-config="storage_account_name=..."
                                 # to `terraform init`.
CONTAINER="tfstate"

az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

az storage account create \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --min-tls-version TLS1_2 \
  --output none

ACCOUNT_KEY=$(az storage account keys list \
  --resource-group "$RESOURCE_GROUP" \
  --account-name "$STORAGE_ACCOUNT" \
  --query '[0].value' -o tsv)

az storage container create \
  --name "$CONTAINER" \
  --account-name "$STORAGE_ACCOUNT" \
  --account-key "$ACCOUNT_KEY" \
  --output none

echo "State backend ready: $STORAGE_ACCOUNT/$CONTAINER in $RESOURCE_GROUP."
echo "If STORAGE_ACCOUNT differs from infra/terraform/versions.tf's backend block, run:"
echo "  terraform init -backend-config=\"storage_account_name=$STORAGE_ACCOUNT\""
