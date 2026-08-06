# Workstation setup — Ansible

Installs the tools [`../scripts/quickstart.sh`](../scripts/quickstart.sh) shells out to, so a new
machine can run the Azure provisioning walkthrough in [`../terraform/README.md`](../terraform/README.md)
without hand-assembling two third-party apt repositories.

This targets **operator workstations**, not the review VM. The VM installs its own software from
`../terraform/cloud-init.yaml.tftpl`; nothing here touches it.

It installs tools only — it never runs `az login`, `terraform apply`, or `quickstart.sh` itself.
Provisioning stays human-run for the reasons in the Terraform README's "Why this stays human-run".

If you do not already have Ansible, start at [Install Ansible first](#install-ansible-first) —
nothing below runs without it, and the version your distro ships may be too old.

## What it installs

| Package | Why |
|---|---|
| `terraform` | `quickstart.sh` runs `init` / `plan` / `apply` / `output`. Pinned — see below. |
| `azure-cli` | `quickstart.sh`'s login check, provider registration and storage lookup; all of `bootstrap-state.sh`. |
| `jq` | Parses `az account show` and `terraform output -json`. |
| `openssh-client` | `ssh-keygen` for the admin key, `ssh-keyscan` for `DEPLOY_SSH_KNOWN_HOSTS`. |
| `curl`, `unzip`, `gnupg`, `ca-certificates`, `apt-transport-https` | Repo setup, and the README's DuckDNS re-point step. |

On most machines only the first two are actually missing; the rest are listed so a bare host ends
up runnable in one pass instead of failing partway through the script on a missing `jq`.

## Install Ansible first

Ansible only has to exist on the machine you run the command *from* — the control node. For the
common case, setting up the laptop you are sitting at, the control node and the target are the
same machine.

`ansible-core` is enough; the larger `ansible` bundle is not needed. Every task here uses an
`ansible.builtin.*` module, so there are no collections to install and no `requirements.yml` to
apply.

### Debian / Ubuntu

```bash
sudo apt-get update
sudo apt-get install -y ansible-core
```

Then check what that actually gave you — see [Minimum version](#minimum-version). Ubuntu 22.04's
`ansible-core` is 2.12, one release too old for this playbook; on 22.04 use the pipx route below
instead.

### macOS

```bash
brew install ansible
```

Homebrew tracks upstream closely, so this is always new enough. macOS works fine as a control
node; it cannot be a *target* — the playbook asserts a Debian-family host and stops.

### Any OS with Python 3 — pipx

The portable route, and the one to use when the distro package is too old or missing:

```bash
sudo apt-get install -y pipx        # or: python3 -m pip install --user pipx
pipx install ansible-core
pipx ensurepath                     # then restart the shell so ~/.local/bin is on PATH
```

### Windows

There is no native Windows control node. Install Ubuntu under WSL2 and follow the Debian/Ubuntu
route inside it.

### Minimum version

**ansible-core 2.13 or newer.** The Terraform pin uses the `apt` module's
`allow_change_held_packages`, added in 2.13, alongside `allow_downgrade`, added in 2.12. An older
control node is worse than a clean refusal: the run writes both apt repositories and *then* fails
at "Install Terraform" with `Unsupported parameters for (ansible.builtin.apt) module:
allow_change_held_packages`, leaving a half-configured host.

| Control node | Ships | Usable |
|---|---|---|
| Ubuntu 22.04 | ansible-core 2.12 | No — use pipx |
| Ubuntu 24.04 | ansible-core 2.16 | Yes |
| Ubuntu 25.10 / 26.04 | ansible-core 2.19 / 2.20 | Yes |
| Debian 12 | ansible-core 2.14 | Yes |
| Debian 13 | ansible-core 2.19 | Yes |
| Homebrew / pipx | current upstream | Yes |

### Verify before running the playbook

```bash
ansible --version
ansible -i infra/ansible/localhost.ini provisioning_workstations -m ansible.builtin.ping
```

The first line of `ansible --version` must read 2.13 or higher. The ping should answer
`SUCCESS => {"ping": "pong"}`. If it prints `[WARNING]: No hosts matched` instead, the inventory
or group name is wrong — the same trap described under "Running it" below.

## Requirements on the target

Debian-family host (the playbook asserts this and stops otherwise). On macOS use
`brew install azure-cli terraform` instead; on RHEL-family hosts, the vendors' yum repos.

`python3`, plus — for a remote target — SSH access and a way to become root (`--ask-become-pass`,
or a passwordless sudo rule). You do not need Ansible on the target: the playbook bootstraps
`python3-apt` over `raw` before using any apt module, so a stock host works as-is.

## Running it

Against the machine you are sitting at:

```bash
ansible-playbook -i infra/ansible/localhost.ini \
  infra/ansible/install-provisioning-tools.yml --ask-become-pass
```

Use that committed `localhost.ini` rather than the shorter `-i localhost, -c local`: the ad-hoc
form drops the host into `ungrouped`, where `hosts: provisioning_workstations` never matches it,
and the run quietly installs nothing.

Against other machines:

```bash
cp infra/ansible/inventory.example.ini infra/ansible/inventory.ini   # then edit
ansible-playbook -i infra/ansible/inventory.ini infra/ansible/install-provisioning-tools.yml
```

Dry run first if you like — `--check --diff` works, which is the reason for the `python3-apt`
bootstrap described below. It is idempotent: a second run reports `changed=0`.

## Two decisions worth knowing about

### Terraform is version-pinned and held

`terraform_version` defaults to the same value `.github/workflows/terraform-plan.yml` pins, so a
workstation produces the same plan CI does. `../terraform/versions.tf` only requires `>= 1.9`, but
a *newer* local Terraform rewrites `.terraform.lock.hcl` and state in ways CI's older binary then
refuses to read. The package is also `dpkg` held, so a routine `apt upgrade` cannot silently undo
the pin.

Override deliberately with `-e terraform_version=1.10.5`; the playbook sets
`allow_change_held_packages` so an explicit change still goes through. **If you bump it, bump the
workflow too** — the whole point is that the two match.

### The azure-cli suite is probed, not assumed

`packages.microsoft.com` lags new Ubuntu releases by months. Both Microsoft's documented
copy-paste line and `curl -sL https://aka.ms/InstallAzureCLIDeb | bash` derive the apt suite from
the host's own codename, so on a too-new release they point apt at a URL that 404s and the install
fails with a confusing "Release file not found" rather than "unsupported release".

The playbook sends a `HEAD` to the repo's `Release` file for the host's codename first. On 200 it
uses that codename; on 404 it falls back to `azure_cli_fallback_suite` (default `noble`) and says
so in its output. The `azure-cli` package is Python plus a bundled interpreter, so an older-LTS
build runs fine on a newer host. This is self-healing — the day Microsoft publishes the host's
release, it switches over with no edit here.

Concretely, at the time of writing: Ubuntu 26.04 (`resolute`) → 404, falls back to `noble`.

### Why `python3-apt` is bootstrapped over `raw`

`ansible.builtin.apt` and `apt_repository` are both implemented against the `python3-apt`
bindings. The `apt` module can auto-install them during a normal run, but fails outright under
`--check`, and `apt_repository` never auto-installs them. `raw` needs no bindings, so it is the
one thing that can break the cycle — hence the two `pre_tasks`.

## After it finishes

The playbook prints what it cannot do for you:

1. **An RSA keypair.** `quickstart.sh` exits if `~/.ssh/erria-review.pub` is missing, and Azure
   rejects ed25519 for VM provisioning: `ssh-keygen -t rsa -b 4096 -f ~/.ssh/erria-review`
2. **`az login`** against the target subscription.
3. **A filled-in `../terraform/terraform.tfvars`.** On a first run `quickstart.sh` copies the
   example and stops on purpose rather than applying placeholder values. Fill it in and re-run.

Then:

```bash
az login
infra/scripts/quickstart.sh          # optional arg: path to your SSH public key
```
