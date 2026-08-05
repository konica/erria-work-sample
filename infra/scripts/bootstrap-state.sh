#!/usr/bin/env bash
# One-time setup of the Terraform remote state backend. Run once, by a human
# with an authenticated `az login`, before the first `terraform init` in
# infra/terraform/. Deliberately plain az CLI, not Terraform — the backend
# can't manage its own storage account.
#
# Safe to re-run: every step no-ops if the resource already exists.
set -euo pipefail

RESOURCE_GROUP="erria-tfstate-us"
# centralus: matches infra/terraform/variables.tf's `location` default. Not
# strictly required to match (state storage isn't tied to the resources it
# describes), but keeping them the same avoids a second region to track for
# no benefit. See that file's description for why this isn't West Europe —
# the original ADR-0007 choice is RegionIsOfferRestricted on this subscription.
#
# Named "-us" / "us" rather than reusing the original erria-tfstate /
# erriatfstate: an earlier westeurope-then-centralindia attempt already
# claimed those names (resource group names are subscription-unique
# regardless of region; storage account names are unique across all of
# Azure), and that resource group couldn't be deleted to free them up in
# this session. It's an orphaned, empty-of-real-data leftover — safe to
# delete by hand whenever convenient, not urgent.
LOCATION="centralus"
STORAGE_ACCOUNT="erriatfstateus" # must be globally unique; if taken, pick another
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
