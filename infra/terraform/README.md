# Review environment — Terraform

Provisions the Azure resources for ticket #56: the review VM, its static IP, the NSG,
the backup storage account, an optional DNS record, and a budget alert. Grounded in
[ADR-0007](../../docs/adr/0007-mvp-deploys-to-one-vm-with-docker-compose.md) and the
[MVP deployment design](../../docs/superpowers/specs/2026-08-04-mvp-deployment-design.md).

This does **not** install or run the application — that's the compose overlay (#57) and
the deploy workflow (#58). This module's job ends at "a bare Ubuntu box with Docker,
reachable by SSH and on 80/443, at a known static IP."

**Region/SKU deviate from the ticket, deliberately.** ADR-0007 specifies West Europe and
`Standard_B2s` (~$44/month total). On the subscription this was first applied against,
`Standard_B2s` was `RegionIsOfferRestricted` in every region checked (West Europe, North
Europe, and every APAC/US region tried), and its `Bsv2`/`DASv5`/`DCasv6` cousins that
*were* offered sat at exactly 0 vCPU quota everywhere too — the signature of a brand-new
subscription still under Azure's account-verification hold, not a real capacity limit.
**Central US** turned out to be the one region where the D-series v6/v7 lineup is both
unrestricted and has real (10 vCPU) quota right now. Defaults here are `centralus` +
`Standard_D2als_v6` (2 vCPU/4 GiB, AMD, non-burstable) — it matches the doc's original
4 GiB memory budget exactly and, being non-burstable, doesn't carry the B-series
CPU-credit-throttling caveat the deployment design flagged for Keycloak startup and
`prisma migrate deploy`. All-in cost is ~$75/month instead of ~$44/month, driven by the
region/SKU swap rather than oversizing. This was a PM-approved deviation for the MVP
phase, not an oversight; re-run the SKU/region check below if the subscription's
restrictions ever change — they're very likely tied to account age/verification, not
permanent.

## Why this stays human-run

Provisioning needs a real Azure subscription and, for DNS, access to a domain Erria
already owns — access an agent doesn't have. That's why #56 is `ready-for-human`. This
module doesn't remove that boundary; it makes what the human runs fast and repeatable
instead of manual portal clicking. `terraform apply` and `terraform destroy` are run
locally, by a human, with their own `az login`, indefinitely — not from CI. See
"CI's role" below for what *is* automated.

## One-time setup

1. `az login` (once per machine/session).
2. Register the resource providers this module needs, if this is a new-ish subscription
   (`az provider show -n Microsoft.Storage --query registrationState` to check first):
   ```
   az provider register --namespace Microsoft.Storage
   az provider register --namespace Microsoft.Compute
   az provider register --namespace Microsoft.Network
   az provider register --namespace Microsoft.Insights
   ```
   Each is asynchronous — poll `az provider show -n <namespace> --query registrationState`
   until `Registered` before moving on. `versions.tf` sets
   `skip_provider_registration = true` on the provider, specifically so Terraform doesn't
   also try to auto-register its full list of ~40 supported providers (most of which this
   module never touches) on every plan/apply — that blanket attempt is what fails first on
   a fresh subscription, before you ever get to the four above.
3. `../scripts/bootstrap-state.sh` — creates the storage account that holds Terraform's
   remote state. Plain `az` CLI, run once, not re-run. If the storage account name it
   picks is taken (names are globally unique), edit the script and re-run, then pass
   the same name to the `terraform init -backend-config` command it prints.
4. `terraform init`.
5. Copy `terraform.tfvars.example` to `terraform.tfvars` and fill in the real values.
   **Do not** put the SSH key here — see next step.
6. `export TF_VAR_admin_ssh_public_key="$(cat ~/.ssh/erria-review.pub)"`. Public key
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

## Troubleshooting: "provider produced inconsistent result" / spurious 404s

Real Azure eventual-consistency behavior, not a config bug — most often on
`azurerm_network_security_group`, `azurerm_network_interface`, and immediately
after resource-group creation. A `terraform apply` can error out on a resource
that the underlying `PUT` actually succeeded on; a moment later `az <resource>
show` confirms it exists while Terraform's state doesn't know about it yet.

The recovery pattern, in order:
1. Verify directly with the `az` CLI (`az network nsg show`, `az storage
   account show`, etc.) before assuming a resource is really missing —
   Terraform's own refresh can report false negatives here even when `az`
   succeeds moments later.
2. If it genuinely exists but Terraform's state doesn't know: `terraform
   import <address> <resource-id>` (the same ID `az ... --query id` prints),
   then re-run `apply`.
3. If refresh itself keeps flip-flopping on which resources are "gone",
   `terraform apply -refresh=false` applies directly against the
   already-reconciled state instead of re-triggering the flaky reads.

## Checking `RegionIsOfferRestricted` before you assume the cost model

The `azurerm` provider has no data source for SKU-offer restrictions, so Terraform
can't catch this at plan time — it would otherwise surface as a raw ARM 400 partway
through apply. Run this once, before the first apply:

```
az vm list-skus --location centralus --size Standard_D2als_v6 --all -o table
```

A restriction shows up in the `restrictions` column. It's the documented
new-subscription behavior, resolved via an Azure support request, not a code change.

## CI's role

A path-filtered GitHub Actions workflow runs `terraform plan` on PRs touching this
directory, using OIDC with **Reader**-only RBAC, and posts the plan for review. It never
applies and never destroys — see #58 (a separate, already-scoped ticket) for the
app-code deploy pipeline, which is unrelated to this module and assumes the VM already
exists.
