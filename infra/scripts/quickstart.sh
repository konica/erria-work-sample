#!/usr/bin/env bash
#
# One-shot Azure provisioning quickstart (ticket #113) — walks a devops engineer through
# infra/terraform/README.md's "One-time setup" (steps 1-6) and "Day to day" sections, which
# otherwise means running a dozen separate commands by hand. Run this once per machine/session,
# right after `az login`.
#
# Never auto-applies: this script always stops for an explicit human confirmation before running
# `terraform apply`, and never touches `terraform destroy` at all — tearing down stays a manual
# README step. See "Why this stays human-run" in infra/terraform/README.md for why provisioning
# itself is deliberately not a CI job.
#
# Usage: infra/scripts/quickstart.sh [path-to-ssh-public-key]
#   Defaults to ~/.ssh/erria-review.pub if no path is given.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="$SCRIPT_DIR/../terraform"
SSH_PUBLIC_KEY_PATH="${1:-$HOME/.ssh/erria-review.pub}"

# Must match infra/terraform/versions.tf's backend block and
# infra/scripts/bootstrap-state.sh's own defaults. Duplicated here for the same reason
# bootstrap-state.sh duplicates versions.tf's values instead of parsing that file: there's no
# single source of truth to read from without adding a parser, and all three places carry a
# comment pointing at the others so a change doesn't silently drift.
TFSTATE_RESOURCE_GROUP="erria-tfstate-us"
TFSTATE_STORAGE_ACCOUNT_DEFAULT="erriatfstateus"

confirm() {
  local prompt="$1" reply
  read -r -p "$prompt [y/N] " reply || true
  [[ "$reply" =~ ^[Yy]$ ]]
}

echo "==> Checking az login"
if ! account_json=$(az account show --output json 2>/dev/null); then
  echo "!! Not logged in. Run 'az login' first." >&2
  exit 1
fi
subscription_name=$(echo "$account_json" | jq -r '.name')
subscription_id=$(echo "$account_json" | jq -r '.id')
tenant_id=$(echo "$account_json" | jq -r '.tenantId')
echo "    Subscription: $subscription_name ($subscription_id)"
echo "    Tenant:       $tenant_id"
confirm "Provision against this subscription?" || { echo "Aborted."; exit 1; }

echo "==> Registering resource providers (skipping any already Registered)"
for namespace in Microsoft.Storage Microsoft.Compute Microsoft.Network Microsoft.Insights; do
  state=$(az provider show -n "$namespace" --query registrationState -o tsv)
  if [[ "$state" == "Registered" ]]; then
    echo "    $namespace: already Registered"
    continue
  fi
  echo "    $namespace: registering..."
  az provider register --namespace "$namespace"
  until [[ "$(az provider show -n "$namespace" --query registrationState -o tsv)" == "Registered" ]]; do
    sleep 5
  done
  echo "    $namespace: Registered"
done

echo "==> Checking Terraform state backend"
if az storage account show \
  --name "$TFSTATE_STORAGE_ACCOUNT_DEFAULT" \
  --resource-group "$TFSTATE_RESOURCE_GROUP" \
  --output none 2>/dev/null
then
  echo "    $TFSTATE_STORAGE_ACCOUNT_DEFAULT already exists in $TFSTATE_RESOURCE_GROUP; skipping bootstrap-state.sh"
  tfstate_storage_account="$TFSTATE_STORAGE_ACCOUNT_DEFAULT"
else
  echo "    Not found; running bootstrap-state.sh"
  bootstrap_output=$("$SCRIPT_DIR/bootstrap-state.sh" | tee /dev/stderr)
  # Extracts the actual account name from bootstrap-state.sh's own "State backend ready:
  # NAME/CONTAINER in RG." line rather than assuming the default — bootstrap-state.sh's header
  # comment says to edit its STORAGE_ACCOUNT and re-run if the default name is already taken
  # (names are globally unique across all of Azure), and this way that edit needs no matching
  # change here to still flow through to terraform init below.
  tfstate_storage_account=$(echo "$bootstrap_output" | sed -n 's#^State backend ready: \([^/]*\)/.*#\1#p')
fi

echo "==> terraform init"
terraform -chdir="$TERRAFORM_DIR" init -input=false \
  -backend-config="storage_account_name=$tfstate_storage_account"

if [[ ! -f "$TERRAFORM_DIR/terraform.tfvars" ]]; then
  cp "$TERRAFORM_DIR/terraform.tfvars.example" "$TERRAFORM_DIR/terraform.tfvars"
  echo
  echo "==> Created infra/terraform/terraform.tfvars from the example — fill in the real values,"
  echo "    then re-run this script. Stopping here on purpose: never applying placeholder values."
  exit 0
fi

if [[ ! -f "$SSH_PUBLIC_KEY_PATH" ]]; then
  echo "!! SSH public key not found at $SSH_PUBLIC_KEY_PATH." >&2
  echo "   Generate an RSA key first — Azure's VM SSH-key provisioning rejects ed25519 outright." >&2
  echo "   e.g. ssh-keygen -t rsa -b 4096 -f ${SSH_PUBLIC_KEY_PATH%.pub}" >&2
  exit 1
fi
ssh_public_key="$(cat "$SSH_PUBLIC_KEY_PATH")"
export TF_VAR_admin_ssh_public_key="$ssh_public_key"

echo "==> terraform plan"
plan_file="$(mktemp -t erria-quickstart-plan.XXXXXX)"
terraform -chdir="$TERRAFORM_DIR" plan -input=false -out="$plan_file"

confirm "Apply this plan?" || { echo "Not applying. Re-run this script when ready."; rm -f "$plan_file"; exit 0; }

echo "==> terraform apply"
terraform -chdir="$TERRAFORM_DIR" apply -input=false "$plan_file"
rm -f "$plan_file"

echo "==> Reading terraform outputs"
outputs=$(terraform -chdir="$TERRAFORM_DIR" output -json)
public_ip=$(echo "$outputs" | jq -r '.public_ip_address.value')
admin_username=$(echo "$outputs" | jq -r '.admin_username.value')

cat <<EOF

============================================================
Provisioning complete. Set these under repo Settings -> Secrets and variables -> Actions
(see deploy/README.md's "CI-driven deploy" section):

  Variables:
    DEPLOY_SSH_HOST=$public_ip
    DEPLOY_SSH_USER=$admin_username
    DEPLOY_PATH=/opt/erria
    DEPLOY_SSH_KNOWN_HOSTS=\$(run once the VM is reachable over SSH:)
      ssh-keyscan $public_ip

  Secret (cannot be produced by this script — the private key is never printed to a terminal):
    DEPLOY_SSH_KEY  =  the private half of the deploy SSH key
============================================================
EOF
