# Review environment — Terraform

Provisions the Azure resources for ticket #56: the review VM, its static IP, the NSG,
the backup storage account, an optional DNS record, and a budget alert. Grounded in
[ADR-0007](../../docs/adr/0007-mvp-deploys-to-one-vm-with-docker-compose.md) and the
[MVP deployment design](../../docs/superpowers/specs/2026-08-04-mvp-deployment-design.md).

This does **not** install or run the application — that's the compose overlay (#57) and
the deploy workflow (#58). This module's job ends at "a bare Ubuntu box with Docker,
reachable by SSH and on 80/443, at a known static IP."

## Why this stays human-run

Provisioning needs a real Azure subscription and, for DNS, access to a domain Erria
already owns — access an agent doesn't have. That's why #56 is `ready-for-human`. This
module doesn't remove that boundary; it makes what the human runs fast and repeatable
instead of manual portal clicking. `terraform apply` and `terraform destroy` are run
locally, by a human, with their own `az login`, indefinitely — not from CI. See
"CI's role" below for what *is* automated.

## One-time setup

1. `az login` (once per machine/session).
2. `../scripts/bootstrap-state.sh` — creates the storage account that holds Terraform's
   remote state. Plain `az` CLI, run once, not re-run. If the storage account name it
   picks is taken (names are globally unique), edit the script and re-run, then pass
   the same name to the `terraform init -backend-config` command it prints.
3. `terraform init`.
4. Copy `terraform.tfvars.example` to `terraform.tfvars` and fill in the real values.
   **Do not** put the SSH key here — see next step.
5. `export TF_VAR_admin_ssh_public_key="$(cat ~/.ssh/erria-review.pub)"`. Public key
   material isn't secret, but it's kept out of `.tfvars` for the same hygiene reason
   any credential-adjacent value is: one consistent pattern for "goes in the
   environment, not in a file that might get `git add -A`'d."

## Day to day

```
terraform plan
terraform apply
```

Outputs include the static public IP — point DNS at it (by hand, if
`manage_dns_in_azure = false`, which is the default) and feed it to ticket #58's deploy
workflow as the SSH target (a GitHub Actions repo variable, updated by hand when this
changes — deliberately not Key Vault; see the MVP deployment design's §7, which rejects
Key Vault at this stage as a moving part with no root secret it removes).

## Tearing down

```
terraform destroy
```

This **will fail** on the backup storage account (`prevent_destroy` in `storage.tf`) —
that's intentional. A routine teardown between review cycles gets you back to zero
compute cost without silently deleting backup history. To actually retire backups too,
remove that lifecycle block deliberately, or:

```
terraform destroy -target azurerm_linux_virtual_machine.review \
  -target azurerm_network_interface.review \
  -target azurerm_public_ip.review \
  -target azurerm_dns_a_record.review
```

## Checking `RegionIsOfferRestricted` before you assume the cost model

The `azurerm` provider has no data source for SKU-offer restrictions, so Terraform
can't catch this at plan time — it would otherwise surface as a raw ARM 400 partway
through apply. Run this once, before the first apply:

```
az vm list-skus --location westeurope --size Standard_B2s --all -o table
```

A restriction shows up in the `restrictions` column. It's the documented
new-subscription behavior, resolved via an Azure support request, not a code change.

## CI's role

A path-filtered GitHub Actions workflow runs `terraform plan` on PRs touching this
directory, using OIDC with **Reader**-only RBAC, and posts the plan for review. It never
applies and never destroys — see #58 (a separate, already-scoped ticket) for the
app-code deploy pipeline, which is unrelated to this module and assumes the VM already
exists.
