# CI/CD and Release Mechanics Design Review
**Date:** 2026-08-04  
**Context:** First cloud deployment, two-person team, two environments (staging/prod), ~$100–160/month Azure target  
**Scope:** GitHub Actions → Azure Container Registry → Azure Container Apps, two container images, Prisma migrations, rollback strategy

---

## Executive Summary

This review specifies a minimal, debuggable CI/CD pipeline for a two-person team deploying a NestJS console API + Fastify worker to Azure Container Apps. The system is deliberately constrained to what two people can actually operate and debug: two container images, two environments only, federated OIDC auth from GitHub to Azure, and expand/contract database migrations enforced as a contract. The recommendation prioritizes safety over speed for a team with no ops/SRE staff — no silent failures, explicit alerts on issues the team must fix, and an honest statement of what *can* vs. *cannot* be rolled back.

---

## 1. Workflow Decomposition

### 1.1 Workflows Overview

| Workflow | Trigger | Purpose | Pushes images? | Can fail safely? |
|---|---|---|---|---|
| **Build & Test (CI)** | push to `main` | Unit/integration tests, lint, typecheck; build both images locally | No (only PR/draft) | Yes — doesn't push to ACR |
| **Push to Staging** | Build & Test success on `main` | Migrate DB, deploy to staging ACA environment | Yes — to ACR with `staging` + `<commit-sha>` tags | Yes — migration job fails → don't promote |
| **Release (GitHub Release)** | Semver tag (v0.1.0, etc.) | Build, test, tag, prepare release artifact | Yes — to ACR with `prod` + tag + digest labels | Yes — can be rolled back by retagging |
| **Deploy to Prod** | Manual approval in GitHub (deployment environment `prod`) | Migrate DB, deploy to prod ACA environment | No — uses already-pushed image by digest | Yes — migration job fails → don't shift traffic |
| **Rollback (manual)** | Dispatch workflow or manual CLI | Revert ACA revisions to prior version | No — uses existing revisions | Yes — instant, but not guaranteed to fix data issues |

### 1.2 Build & Test Workflow

**Trigger:** `on: [push]` to `main`, `on: pull_request`

**High-level steps:**

```yaml
name: Build & Test
on:
  push:
    branches: [main]
  pull_request:

env:
  NODE_VERSION: 24
  PNPM_VERSION: 10.0.0

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      # 1. Setup Node + pnpm with install caching
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      
      - run: pnpm install --frozen-lockfile
      
      # 2. Lint + typecheck (fast, fail early)
      - run: pnpm lint
      - run: pnpm typecheck
      
      # 3. Unit tests (Vitest) — mock Claude, no external calls
      - run: pnpm test
      
      # 4. Integration tests (Testcontainers + Postgres)
      # — only on main, not every PR, to keep CI time reasonable
      - if: github.ref == 'refs/heads/main'
        name: Integration tests (Postgres + Testcontainers)
        run: pnpm test:integration
      
      # 5. Build Docker images (don't push yet)
      - uses: docker/setup-buildx-action@v3
      
      - name: Build console-api image (no push)
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./apps/console-api/Dockerfile
          target: production
          tags: erria-console-api:test
          cache-from: type=gha
          cache-to: type=gha,mode=max
      
      - name: Build worker image (no push)
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./apps/worker/Dockerfile
          target: production
          tags: erria-worker:test
          cache-from: type=gha
          cache-to: type=gha,mode=max
      
      # 6. Summary
      - if: always()
        run: echo "Build & test passed — ready for staging deployment"
```

**Why this shape:**
- **No ACR push on CI:** The branch isn't production-ready yet; pushing would clutter the registry and risk mixing test artifacts with real deployments.
- **Caching:** `actions/setup-node` + `cache: pnpm` for dependencies; Docker buildx cache for image layers.
- **Integration tests only on main:** Full Testcontainers suite takes 5–10 minutes; PR checks stay fast by running only unit tests, integration on merge.
- **Both images build successfully:** Catches Dockerfile issues early.

**What this does NOT do:**
- Deploy anywhere
- Push to ACR
- Run against real Claude API (mocked in tests)

---

### 1.3 Push to Staging Workflow

**Trigger:** Build & Test success on `main` (use `workflow_run` or a separate step in the same workflow after tests pass)

**Shape:**

```yaml
name: Deploy to Staging
on:
  workflow_run:
    workflows: [Build & Test]
    branches: [main]
    types: [completed]

env:
  REGISTRY: erria-registry.azurecr.io
  ACR_RESOURCE_GROUP: erria-staging
  STAGE: staging

jobs:
  deploy-staging:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    
    permissions:
      id-token: write  # Required for OIDC
      contents: read
    
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
      
      # 1. OIDC login to Azure
      - name: Azure login via OIDC
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      
      # 2. Build and push images to ACR
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ./apps/console-api/Dockerfile
          target: production
          push: true
          tags: |
            ${{ env.REGISTRY }}/console-api:staging
            ${{ env.REGISTRY }}/console-api:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ./apps/worker/Dockerfile
          target: production
          push: true
          tags: |
            ${{ env.REGISTRY }}/worker:staging
            ${{ env.REGISTRY }}/worker:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      
      # 3. Run database migrations (BEFORE traffic shift)
      - name: Run Prisma migrations in staging
        run: |
          az containerapp job start \
            --resource-group ${{ env.ACR_RESOURCE_GROUP }} \
            --name erria-migrate-staging \
            --image "${{ env.REGISTRY }}/worker:${{ github.sha }}" \
            --command "npm run migrate:deploy"
      
      # 4. Wait for migration job to complete (with timeout)
      - name: Wait for migration job
        run: |
          # Poll job status with timeout (5 minutes)
          TIMEOUT=300
          ELAPSED=0
          while [ $ELAPSED -lt $TIMEOUT ]; do
            STATUS=$(az containerapp job show \
              --resource-group ${{ env.ACR_RESOURCE_GROUP }} \
              --name erria-migrate-staging \
              --query "properties.latestJobExecution.status" -o tsv)
            if [[ "$STATUS" == "Succeeded" ]]; then
              echo "Migration succeeded"
              exit 0
            elif [[ "$STATUS" == "Failed" ]]; then
              echo "Migration failed"
              exit 1
            fi
            sleep 10
            ELAPSED=$((ELAPSED + 10))
          done
          echo "Migration timeout after ${TIMEOUT}s"
          exit 1
      
      # 5. Update console-api container app
      - name: Deploy console-api to staging
        run: |
          az containerapp update \
            --resource-group ${{ env.ACR_RESOURCE_GROUP }} \
            --name erria-console-api-staging \
            --image "${{ env.REGISTRY }}/console-api:${{ github.sha }}"
      
      # 6. Update worker container app
      - name: Deploy worker to staging
        run: |
          az containerapp update \
            --resource-group ${{ env.ACR_RESOURCE_GROUP }} \
            --name erria-worker-staging \
            --image "${{ env.REGISTRY }}/worker:${{ github.sha }}"
      
      # 7. Basic health check (curl console app)
      - name: Health check staging console
        run: |
          URL=$(az containerapp show \
            --resource-group ${{ env.ACR_RESOURCE_GROUP }} \
            --name erria-console-api-staging \
            --query "properties.configuration.ingress.fqdn" -o tsv)
          curl -f https://$URL/health || exit 1
      
      # 8. Alert on failure
      - if: failure()
        name: Notify staging deployment failure
        run: |
          # Post to Teams / email / logging system
          echo "STAGING DEPLOYMENT FAILED: Migration or app update issue"
          echo "Commit: ${{ github.sha }}"
          echo "Check: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

**Key points:**

- **Migration BEFORE traffic shift:** Container Apps Job runs `prisma migrate deploy` before the new app revision receives traffic. If migration fails, the job fails, and the subsequent `az containerapp update` never runs.
- **Explicit wait:** The workflow polls the job status with a 5-minute timeout (verify this timeout is reasonable for your typical migration size). If migration hangs, the job fails explicitly.
- **Image tags:** Both `staging` (latest on staging) and `<commit-sha>` (unique per deploy) so rollback can target a specific commit without ambiguity.
- **Health check:** A basic `curl` to `/health` ensures the new revision started successfully. (Implement a simple health endpoint in the API: `GET /health` → `200 {status: "ok"}`.)
- **Failure is explicit:** If anything fails (migration, app update, health check), the workflow fails, teams/logs are notified, and no automatic rollback happens — the team must investigate.

**Verify:** The exact `az containerapp job start` syntax and how to pass the image reference; migration image may need to use `--image` or a predefined job execution context.

---

### 1.4 Release Workflow (Semver Tag)

**Trigger:** GitHub Release created (or tag pushed with `v*` pattern)

**Shape:**

```yaml
name: Release
on:
  release:
    types: [published]

env:
  REGISTRY: erria-registry.azurecr.io

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    
    steps:
      - uses: actions/checkout@v4
      
      # 1. Verify tests still pass (quick re-run on release tag)
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - uses: pnpm/action-setup@v4
        with:
          version: 10.0.0
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint && pnpm typecheck
      - run: pnpm test
      
      # 2. Build and push images with release tag
      - name: Azure login via OIDC
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      
      - uses: docker/setup-buildx-action@v3
      
      - name: Push console-api release image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./apps/console-api/Dockerfile
          target: production
          push: true
          tags: |
            ${{ env.REGISTRY }}/console-api:${{ github.ref_name }}
            ${{ env.REGISTRY }}/console-api:${{ github.sha }}
          cache-from: type=gha
      
      - name: Push worker release image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./apps/worker/Dockerfile
          target: production
          push: true
          tags: |
            ${{ env.REGISTRY }}/worker:${{ github.ref_name }}
            ${{ env.REGISTRY }}/worker:${{ github.sha }}
          cache-from: type=gha
```

**Why this shape:**
- **Not a rebuild if same commit:** If the release tag points to a commit already pushed to staging, you *could* skip the build and just re-tag the existing image by digest. However, for simplicity and auditability, rebuild (it's cached, so still fast).
- **Release images tagged with semver:** `console-api:v0.1.0`, so prod deploys reference the exact version.

**Verify:** Whether your ACR tier supports manifest metadata tagging; simpler alternative is just to rely on tag naming convention.

---

### 1.5 Deploy to Production Workflow

**Trigger:** Manual approval via GitHub Environments, or `workflow_dispatch` for on-demand deploys

**Shape:**

```yaml
name: Deploy to Production
on:
  workflow_dispatch:
    inputs:
      image_tag:
        description: 'Image tag to deploy (e.g., v0.1.0 or sha:abc123)'
        required: true

env:
  REGISTRY: erria-registry.azurecr.io
  ACR_RESOURCE_GROUP: erria-prod
  STAGE: prod

jobs:
  deploy-prod:
    runs-on: ubuntu-latest
    environment: prod  # Requires manual approval in GitHub
    
    permissions:
      id-token: write
      contents: read
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Azure login via OIDC
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      
      # 1. Run migrations with the specified image
      - name: Run Prisma migrations in prod
        run: |
          az containerapp job start \
            --resource-group ${{ env.ACR_RESOURCE_GROUP }} \
            --name erria-migrate-prod \
            --image "${{ env.REGISTRY }}/worker:${{ github.event.inputs.image_tag }}"
      
      # 2. Wait for migration
      - name: Wait for migration job
        run: |
          TIMEOUT=300
          ELAPSED=0
          while [ $ELAPSED -lt $TIMEOUT ]; do
            STATUS=$(az containerapp job show \
              --resource-group ${{ env.ACR_RESOURCE_GROUP }} \
              --name erria-migrate-prod \
              --query "properties.latestJobExecution.status" -o tsv)
            if [[ "$STATUS" == "Succeeded" ]]; then
              exit 0
            elif [[ "$STATUS" == "Failed" ]]; then
              exit 1
            fi
            sleep 10
            ELAPSED=$((ELAPSED + 10))
          done
          exit 1
      
      # 3. Update prod apps (traffic now shifts to new revision)
      - name: Deploy console-api to prod
        run: |
          az containerapp update \
            --resource-group ${{ env.ACR_RESOURCE_GROUP }} \
            --name erria-console-api-prod \
            --image "${{ env.REGISTRY }}/console-api:${{ github.event.inputs.image_tag }}"
      
      - name: Deploy worker to prod
        run: |
          az containerapp update \
            --resource-group ${{ env.ACR_RESOURCE_GROUP }} \
            --name erria-worker-prod \
            --image "${{ env.REGISTRY }}/worker:${{ github.event.inputs.image_tag }}"
      
      # 4. Health check
      - name: Health check prod console
        run: |
          URL=$(az containerapp show \
            --resource-group ${{ env.ACR_RESOURCE_GROUP }} \
            --name erria-console-api-prod \
            --query "properties.configuration.ingress.fqdn" -o tsv)
          curl -f https://$URL/health || exit 1
      
      # 5. Smoke test (optional: quick API call to verify basic flow)
      - name: Smoke test prod API
        run: |
          URL=$(az containerapp show \
            --resource-group ${{ env.ACR_RESOURCE_GROUP }} \
            --name erria-console-api-prod \
            --query "properties.configuration.ingress.fqdn" -o tsv)
          curl -f "https://$URL/api/queue?tier=&page=1" \
            -H "Authorization: Bearer ${{ secrets.PROD_TEST_TOKEN }}" || exit 1
      
      - if: failure()
        name: Notify prod deployment failure
        run: |
          echo "PROD DEPLOYMENT FAILED"
          echo "Image tag: ${{ github.event.inputs.image_tag }}"
          echo "Check: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

**Why this shape:**
- **Manual `image_tag` input:** Deploy can be triggered with `v0.1.0`, `sha:abc123`, `staging`, or any tag already pushed to ACR. No rebuild — use the exact image that passed staging.
- **GitHub Environments:** `environment: prod` gates this job with a manual approval in the GitHub UI. Only specified team members (configured in GitHub) can approve.
- **Same migration check:** Migration must succeed before traffic shifts; if it fails, team is notified and no app update happens.
- **Smoke test:** Quick call to `GET /api/queue` to verify the API is responsive. Uses a test token (stored in GitHub Secrets) to make an authenticated request. Catches issues like missing env vars, database connection failures, etc. that health checks alone wouldn't catch.

**Verify:** Whether Azure CLI's `az containerapp job start` blocks until completion or returns immediately (likely returns immediately, hence the poll loop). Also verify the exact query path for job execution status.

---

### 1.6 Rollback Workflow (Manual)

**Trigger:** `workflow_dispatch` — manually invoked when a deployment breaks

**Shape:**

```yaml
name: Rollback
on:
  workflow_dispatch:
    inputs:
      target_env:
        description: 'Environment to rollback (staging or prod)'
        required: true
        type: choice
        options: [staging, prod]
      target_revision:
        description: 'Revision to rollback to (leave blank for previous revision)'
        required: false

env:
  REGISTRY: erria-registry.azurecr.io

jobs:
  rollback:
    runs-on: ubuntu-latest
    environment: ${{ github.event.inputs.target_env }}  # Require approval for prod
    
    permissions:
      id-token: write
      contents: read
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Azure login via OIDC
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      
      - name: Rollback console-api to previous revision
        run: |
          RESOURCE_GROUP="erria-${{ github.event.inputs.target_env }}"
          # Get the previous revision (Azure CLI returns revisions sorted by creation time)
          PREV_REVISION=$(az containerapp revision list \
            --resource-group $RESOURCE_GROUP \
            --name erria-console-api-${{ github.event.inputs.target_env }} \
            --query "sort_by([].{name:name, created:createdTime}, &created)[-2].name" -o tsv)
          
          if [ -z "$PREV_REVISION" ]; then
            echo "No previous revision found"
            exit 1
          fi
          
          # Shift all traffic to the previous revision
          az containerapp revision copy \
            --resource-group $RESOURCE_GROUP \
            --name erria-console-api-${{ github.event.inputs.target_env }} \
            --revision $PREV_REVISION \
            --traffic-weight "$PREV_REVISION=100"
      
      - name: Rollback worker to previous revision
        run: |
          RESOURCE_GROUP="erria-${{ github.event.inputs.target_env }}"
          PREV_REVISION=$(az containerapp revision list \
            --resource-group $RESOURCE_GROUP \
            --name erria-worker-${{ github.event.inputs.target_env }} \
            --query "sort_by([].{name:name, created:createdTime}, &created)[-2].name" -o tsv)
          
          if [ -z "$PREV_REVISION" ]; then
            echo "No previous revision found"
            exit 1
          fi
          
          az containerapp revision copy \
            --resource-group $RESOURCE_GROUP \
            --name erria-worker-${{ github.event.inputs.target_env }} \
            --revision $PREV_REVISION \
            --traffic-weight "$PREV_REVISION=100"
      
      - name: Health check rolled-back environment
        run: |
          URL=$(az containerapp show \
            --resource-group erria-${{ github.event.inputs.target_env }} \
            --name erria-console-api-${{ github.event.inputs.target_env }} \
            --query "properties.configuration.ingress.fqdn" -o tsv)
          curl -f https://$URL/health || exit 1
      
      - name: Notify rollback complete
        run: |
          echo "Rollback to ${{ github.event.inputs.target_env }} complete"
          echo "Previous revision active; new revision retained for inspection"
```

**Key points:**
- **Instant:** Traffic repoints to prior revision in seconds (no rebuild, no migration).
- **Non-destructive:** The broken revision is left in place so the team can inspect logs.
- **Manual approval for prod:** Requires a team member to approve the rollback in GitHub UI, preventing accidental rollbacks.
- **Honest limitation:** This rolls back *code* only. If the broken revision already ran a migration that corrupted data, rolling back the code doesn't undo that. That requires a separate, data-dependent remediation (discussed in section 3).

**Verify:** `az containerapp revision` commands — the exact CLI syntax for querying and traffic-shifting revisions; query path may differ.

---

## 2. Azure Authentication: Federated OIDC vs. Service Principal

**Recommendation: Federated OIDC (OpenID Connect workload identity)**

### 2.1 Why OIDC over Service Principal Secret

| Aspect | OIDC | Service Principal Secret |
|---|---|---|
| **Secret storage** | None — GitHub Action exchanges token for Azure token | Service principal secret stored in GitHub Secrets |
| **Rotation** | Automatic (OIDC tokens expire in ~10 min) | Manual — secret never changes, lingering risk if exposed |
| **Audit trail** | Azure logs exactly which GitHub Action/workflow triggered the login | Generic "service principal" login |
| **Compromise scope** | Single GitHub repo + workflow limited by subject claim | Any workflow/action can use the secret |
| **Operational overhead** | Set up once, minimal maintenance | Secret rotation policy, occasional regeneration |

OIDC is the current best practice (2025+). GitHub Actions built-in OIDC provider + Azure AD federated credential = no stored secrets.

### 2.2 Azure Configuration

**One-time setup (do this once, then store the IDs in GitHub Secrets):**

```bash
# 1. Create an Azure AD application (service principal) in the same tenant
az ad app create --display-name "erria-github-actions"

# Get the app ID
APP_ID=$(az ad app list --display-name "erria-github-actions" --query "[0].appId" -o tsv)
TENANT_ID=$(az account show --query "tenantId" -o tsv)

# 2. Create a service principal from the app (required for federated credentials)
az ad sp create --id $APP_ID

# 3. Assign roles to the service principal
# For staging:
az role assignment create \
  --assignee $APP_ID \
  --role "Contributor" \
  --scope /subscriptions/$(az account show --query id -o tsv)/resourceGroups/erria-staging

# For prod:
az role assignment create \
  --assignee $APP_ID \
  --role "Contributor" \
  --scope /subscriptions/$(az account show --query id -o tsv)/resourceGroups/erria-prod

# Or more narrowly, assign specific ACR/Container App permissions (verify exact role names)
# az role assignment create --assignee $APP_ID --role "AcrPush" --scope /subscriptions/.../resourceGroups/erria-staging

# 4. Create a federated credential linking GitHub to the service principal
# (One credential per environment / GitHub environment, or one global)
az ad app federated-credential create \
  --id $APP_ID \
  --parameters '{
    "name": "github-main-staging",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:konica/erria-work-sample:ref:refs/heads/main",
    "audiences": ["api://AzureADTokenExchange"]
  }'

# For prod, restrict to release tags:
az ad app federated-credential create \
  --id $APP_ID \
  --parameters '{
    "name": "github-releases-prod",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:konica/erria-work-sample:ref:refs/tags/v*",
    "audiences": ["api://AzureADTokenExchange"]
  }'

# 5. Store these in GitHub Secrets (for the workflow to reference)
# gh secret set AZURE_CLIENT_ID --body "$APP_ID"
# gh secret set AZURE_TENANT_ID --body "$TENANT_ID"
# gh secret set AZURE_SUBSCRIPTION_ID --body "$(az account show --query id -o tsv)"
```

**In the workflow**, the `azure/login@v2` action exchanges the GitHub token for an Azure token automatically:

```yaml
- uses: azure/login@v2
  with:
    client-id: ${{ secrets.AZURE_CLIENT_ID }}
    tenant-id: ${{ secrets.AZURE_TENANT_ID }}
    subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
```

**Why this works:**
- GitHub Action checks if it's running in `token.actions.githubusercontent.com` OIDC provider.
- Azure AD verifies the token's `subject` claim matches one of the federated credentials (e.g., `repo:konica/erria-work-sample:ref:refs/heads/main`).
- If match, Azure AD issues a short-lived Azure token to the action.
- No service principal secret ever exists in GitHub.

**Verify:** Azure CLI version supports federated credentials (should be standard by now; if not, use `az ad app federated-credential` docs for exact syntax).

---

## 3. The Migration Ordering Problem

This is the core safety constraint for this architecture. **State this explicitly to the team:**

> During the traffic handoff from an old ACA revision to a new one, the old revision briefly runs against the new database schema. All migrations must be backward-compatible.

### 3.1 Expand/Contract Pattern

**Two-step migration process:**

**Step 1: Expand (forward-compatible)**
```sql
-- Add new column nullable (old code doesn't need it yet)
ALTER TABLE Escalation ADD COLUMN estimated_handoff_time INT DEFAULT NULL;

-- Add new index (optional, but doesn't break old code)
CREATE INDEX idx_escalation_created_at ON Escalation(created_at);
```

**Old code doesn't break** — it ignores the new column, the new code can read either old or new schema.

**Step 2: Contract (remove old, once old code is gone)**

This happens in a *separate* PR/deploy after confirming the new code is stable:

```sql
-- Remove old column only after confirmed new revision is live and stable
ALTER TABLE Escalation DROP COLUMN original_handoff_field;
```

### 3.2 The Ordering Guarantee

During deployment:

1. **Pipeline runs `prisma migrate deploy` as an ACA Job** — using the **new** image's migrations.
2. **New schema is live** — database has all new columns, indexes, etc.
3. **Old revision (still serving traffic) now runs against new schema** — must not break.
4. **Traffic gradually shifts to new revision** (ACA's native traffic-weight control).
5. **Old revision stops receiving traffic** → can be removed.

**If this ordering breaks:**
- Example: new code drops a column, old code still reads it → old revision crashes on 500.
- Example: new code adds a non-nullable column with no default, old code doesn't populate it → `NULL` constraint violation.

### 3.3 What Happens When Migration Fails

**Scenario:** `prisma migrate deploy` times out or errors mid-migration.

**Action:**

1. **Pipeline fails immediately** — the ACA Job exits non-zero.
2. **Workflow stops** — no `az containerapp update` runs.
3. **Database is left in an intermediate state** (partially migrated).
4. **Old revision keeps running against the old schema** (stable).
5. **Team is alerted** (workflow failure notification).
6. **Team investigates:**
   - Manual SQL inspection: `SELECT * FROM "_prisma_migrations" WHERE finished_at IS NULL;`
   - Rollback migration (or commit partial state depending on issue).
   - Re-trigger the workflow, or fix the migration and retry.

**Never auto-retry.** A failed migration is a deliberate stop — the team must understand why and fix it before proceeding.

### 3.4 Writing Backward-Compatible Migrations

**Good migration (expanding):**
```sql
-- Adding a new column, optional for now
ALTER TABLE Message ADD COLUMN confidence_score FLOAT DEFAULT 0.5;

-- Old code continues to work (ignores the new column)
-- New code can read/write it
```

**Bad migration (contracting without expansion phase):**
```sql
-- Removing a column that old code might still try to read
ALTER TABLE Message DROP COLUMN original_body;

-- Old revision crashes: cannot SELECT original_body anymore
-- WRONG — this breaks during the handoff window
```

**Good phased approach:**

**Commit 1 (PR 1):** Add migration + new code that reads the new column
```sql
ALTER TABLE Message ADD COLUMN new_field TEXT;
-- Deployed, old revision removed after traffic settles
```

**Commit 2 (PR 2, later):** Remove the old column
```sql
ALTER TABLE Message DROP COLUMN old_field;
-- Only safe after confirming all old revisions are gone
```

**Document this:** Add a migration guidelines section to CONTRIBUTING.md with examples.

---

## 4. Rollback: Code vs. Schema

**Be honest about the limits.**

### 4.1 Code Rollback (Fully Reversible)

**How:**
- Traffic repoints to prior ACA revision (instant, no downtime).
- Prior revision served by prior image — reverts all code changes.

**Timeline:** ~5 seconds.

**Example:** Deploy introduced a bug in tier-computation logic → revert by traffic shift → bug is gone.

**Caveat:** Only works if the prior revision is still in ACA (Azure retains the last N revisions; default is substantial). If you've deployed 50 times and only keep 10 revisions, rolling back to revision 11 means rebuilding it — slower but still possible.

### 4.2 Schema Rollback (Often Not Reversible)

**How:**
- Run a reverse migration (SQL) to undo the schema change.
- Old code continues to work.

**Timeline:** Minutes (depends on data volume and migration complexity).

**Examples:**

**Reversible:**
```sql
-- Forward
ALTER TABLE Account ADD COLUMN tier INT;
-- Backward (drop the column)
ALTER TABLE Account DROP COLUMN tier;
-- All data still exists; code reverts to prior behavior
```

**Hard/Irreversible:**
```sql
-- Forward
ALTER TABLE Account DROP COLUMN old_tier_name; -- Deleted data

-- Backward
-- Data is gone; cannot recover by reversing the migration
-- Only option: restore from backup
```

**Honest statement:**
- If the migration only *added* columns/indexes (Expand phase), rollback is as simple as running the reverse migration (drop column).
- If the migration *deleted* data, rollback requires a database restore from backup.
- **For v1:** Avoid data-destructive migrations. Any column removal must be preceded by a code-release window (Expand phase), then a *separate* PR to remove the column (Contract phase), only after confirming no old code is running.

### 4.3 Recommended Rollback Procedure

**Incident:** New deployment causes errors. Tier-computation logic is broken.

**Step 1: Immediate (code rollback via traffic shift)**
```bash
gh workflow run rollback.yml -f target_env=prod
# Approval required in GitHub UI
# ~30 seconds later, old revision handles traffic again
```

**Step 2: Investigate**
- Check Application Insights logs to understand the bug.
- Confirm database is consistent (run a sanity check query).
- Prepare a fix.

**Step 3: Re-deploy**
- Fix the code, commit to main.
- Pipeline rebuilds, tests, deploys to staging.
- Smoke test staging.
- Approve manual deploy to prod with the fixed image.

**Lesson:** Rollback buys you time to investigate; it doesn't fix data corruption. For that, you need a separate restore procedure (see section on backups in the Azure doc).

---

## 5. Promotion: Staging → Prod (Branch/Tag Scheme + Image Tagging)

### 5.1 Branch and Tag Strategy

**Recommendation: `main` branch for staging, semver tags for prod releases**

| What | Branch/Tag | Workflow | Image tags |
|---|---|---|---|
| **Development** | Feature branches (e.g., `feat/tier-escalation`) | PR checks (lint, test) — no deploy | None pushed to ACR |
| **Staging** | Merge to `main` | Build & Test + Push to Staging | `console-api:staging`, `console-api:<commit-sha>` |
| **Production release** | Create GitHub Release on commit (or tag `v0.1.0`) | Release workflow + Push release images | `console-api:v0.1.0`, `console-api:<commit-sha>` |
| **Production deploy** | (N/A — manual trigger) | Deploy to Prod (manual approval) | Uses image by tag (e.g., `v0.1.0`) or by digest |

### 5.2 Image Tagging Strategy

**Recommendation: Promote by digest, not rebuild**

**Why:** 
- Same image that passed staging tests runs in prod.
- No risk of build-time non-determinism (unlikely in practice, but theoretically safer).
- Faster (no rebuild).
- Audit trail: exact same layers, digest is immutable.

**Implementation:**

1. **Staging deployment tags image with `staging` + commit SHA:**
   ```yaml
   tags: |
     ${{ env.REGISTRY }}/console-api:staging
     ${{ env.REGISTRY }}/console-api:${{ github.sha }}
   ```

2. **Release workflow re-tags the *same* image by digest:**
   ```yaml
   # Instead of `docker build ... --push`, use:
   az acr import \
     --registry erria-registry \
     --source console-api@sha256:abc123... \
     --image console-api:v0.1.0
   
   # Or simply tag it:
   az acr repository update \
     --registry erria-registry \
     --image console-api@sha256:abc123... \
     --set-manifest console-api:v0.1.0
   ```

3. **Prod deploy references the release tag:**
   ```yaml
   image_tag: v0.1.0  # No rebuild; ACR pulls existing digest
   ```

**Simpler alternative (rebuild for clarity):**
If re-tagging is unclear, just rebuild in the Release workflow:
```yaml
docker build ... --tag console-api:v0.1.0 --push
```

It's cached, so it's still fast. Trade-off: slightly longer release, absolute certainty it's the right commit.

### 5.3 Rollback by Tag/Digest

**If prod deployment fails, roll back to prior release tag:**
```bash
gh workflow run deploy-prod.yml \
  -f image_tag=v0.0.9  # Previous release
```

**Or to a staging build:**
```bash
gh workflow run deploy-prod.yml \
  -f image_tag=$(git rev-parse HEAD~5)  # 5 commits ago
```

**Or manually tag a prior revision active:**
```bash
# If using traffic shifting, no tag needed — just traffic reweight
az containerapp revision copy \
  --revision prior-revision-name \
  --traffic-weight "prior-revision-name=100"
```

---

## 6. Secrets and Configuration

### 6.1 Boundary Lines

| Where | What | Why |
|---|---|---|
| **GitHub Secrets** | GitHub token (for releases/PRs), Azure OIDC IDs (`AZURE_CLIENT_ID`, etc.) | GitHub-specific, not deployable |
| **Azure Key Vault** | Claude API key, Keycloak admin password, Postgres password, Keycloak client secret | Sensitive, needs Vault's audit trail, accessed via managed identity |
| **ACA env vars** | Non-sensitive config: log level, environment name, Claude model version, region | Safe to check in code or pass via IaC; ACA can inject via YAML |
| **Docker image** | No secrets, no private keys; build-time secrets passed via `--secret` flag (not baked in) | Images are often inspected/audited; keeping them secret-free is safer |

### 6.2 Key Vault Integration in ACA

Each Container App gets a **system-assigned managed identity**. ACA natively supports **Key Vault references** in secret configuration:

```bicep
// In Bicep
resource containerApp 'Microsoft.App/containerApps@2024-08' = {
  name: 'console-api-prod'
  properties: {
    template: {
      containers: [
        {
          name: 'console-api'
          image: '${containerRegistry.properties.loginServer}/console-api:prod'
          env: [
            {
              name: 'CLAUDE_API_KEY'
              secretRef: 'claude-api-key'
            }
          ]
        }
      ]
      secrets: [
        {
          name: 'claude-api-key'
          keyVaultUrl: 'https://erria-kv-prod.vault.azure.net/secrets/claude-api-key'
          identity: 'system'  // Use system-assigned managed identity
        }
      ]
    }
  }
}
```

ACA automatically:
- Fetches the secret from Key Vault at container startup.
- Uses the container's managed identity (no service principal credentials needed).
- Refreshes the secret periodically.

### 6.3 Non-Secret Config (Overridable in Deployment)

For non-sensitive config that might change per environment (log level, feature flags, etc.), use ACA's `environment` properties:

```bash
az containerapp update \
  --resource-group erria-prod \
  --name console-api-prod \
  --image "..." \
  --set-env-vars LOG_LEVEL=debug FEATURE_AUDIT_SAMPLING_ENABLED=true
```

Or in Bicep:
```bicep
env: [
  { name: 'LOG_LEVEL', value: 'info' }
  { name: 'CLAUDE_MODEL', value: 'claude-sonnet-5' }
]
```

### 6.4 GitHub Secrets Checklist

Required secrets in GitHub (scope to staging + prod environments):

```
AZURE_CLIENT_ID              (OIDC)
AZURE_TENANT_ID              (OIDC)
AZURE_SUBSCRIPTION_ID        (OIDC)
PROD_TEST_TOKEN              (Bearer token for smoke test)
```

Optional (only if not using OIDC):
```
AZURE_CREDENTIALS            (JSON service principal — not recommended)
```

---

## 7. What You Are **Deliberately NOT** Building

### 7.1 Rationale Table

| Feature | Why not building it | When to revisit |
|---|---|---|
| **GitOps / ArgoCD** | Adds a declarative reconciliation loop the team must debug. For two people, imperative GitHub Actions deployment is simpler. ACA's built-in revision model already handles the "current state." | When team grows to 4+ people or multiple environments split across regions; even then, start with imperative. |
| **Progressive Delivery (Flagger, Argo Rollouts)** | Canary/progressive rollout tooling requires metric-based automated rollback. ACA's traffic-weight control already exists; team can manually adjust traffic 90/10 if desired, or use this for future complexity. | When deployment frequency reaches 10+/day and every 1% error spike must auto-roll back; for v1, manual approval is fine. |
| **Multi-stage approval matrix** | "DEV approval → QA approval → staging approval → prod approval" multiplies handoffs. Two people means the same person approves; explicit gates (GitHub Environments) are sufficient. | When team splits into dev/ops/security roles. For now, one manual gate (prod environment approval) is enough. |
| **Service mesh** | No east-west communication complexity here. Console API and worker call the database; no internal service-to-service routing needs load balancing, retry policies, or mTLS. | When architecture grows to 5+ internal services with dynamic endpoints. |
| **Event streaming (Event Grid, Kafka, Pub/Sub)** | Flows are simple request/response (console API → worker) and scheduled jobs. No fan-out or deferred processing requiring a queue. | When background work (e.g., follow-up reminders) becomes asynchronous and decoupled from trigger. For now, scheduled jobs are sufficient. |
| **Secrets rotation automation** | Azure Key Vault supports automatic secret rotation; GitHub Actions can trigger a secret-swap job. Overkill for a two-person team; manual rotation (once a year or on compromise) is acceptable. | When compliance requires automated rotation (SOC2, etc.) or secret compromise becomes a real incident. |
| **Multi-region active-active failover** | Single region is the explicit architectural decision. No-code fallback is IaC rebuild in a paired region; RTO is hours. | When uptime requirement shifts from "a handful of users during business hours" to "mission-critical 24/7." |
| **Custom Prometheus / Grafana stack** | Azure Monitor + Application Insights already provide request tracing, exception logs, and dependency tracking. Adding Prometheus/Grafana is observation redundancy. | When Application Insights retention or query complexity becomes a bottleneck. |
| **Automated capacity planning** | No surge forecasting needed; user base is fixed and small. Manual resizing of Postgres/ACA on observation is fine. | When user base becomes predictably variable (seasonal, etc.) and resize cost outweighs automation cost. |

---

## 8. Monorepo Concerns: Caching and Path Filters

### 8.1 pnpm Install Caching

GitHub Actions `setup-node@v4` with `cache: pnpm` automatically manages the cache:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: pnpm
```

This caches:
- `pnpm-lock.yaml` (dependency lock file)
- `node_modules/` across workspace packages

**Cache key:** Derived from `pnpm-lock.yaml` hash + Node version.

**Result:** First CI run installs all deps (~2 min); subsequent runs (same lock file) restore in ~10 sec.

**Important:** Monorepo structure (multiple `package.json` files in `packages/` and `apps/`) is automatically detected by pnpm and both setup-node and Docker layer caching should respect it.

### 8.2 Docker Layer Caching with Buildx

```yaml
- uses: docker/build-push-action@v6
  with:
    context: .
    file: ./apps/console-api/Dockerfile
    target: production
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

`cache-from: type=gha` and `cache-to: type=gha,mode=max` use GitHub Actions' built-in cache backend. Each Docker layer is cached separately:

- Layer 1: `FROM node:24-alpine`
- Layer 2: `COPY pnpm-lock.yaml /app/`
- Layer 3: `RUN pnpm install --frozen-lockfile`
- ...etc.

If `pnpm-lock.yaml` doesn't change, layer 3 is reused. Subsequent builds with the same dependencies are much faster (~10 sec vs. 2 min).

**Important:** For this to work across multiple images (console-api and worker), both `Dockerfile`s must be structured similarly:
```dockerfile
FROM node:24-alpine AS builder
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY packages/ packages/
COPY apps/console-api/package.json apps/console-api/

# pnpm install is the expensive layer; should be shared
RUN pnpm install --frozen-lockfile

# Build
RUN pnpm run build

FROM node:24-alpine AS production
# Copy only production deps and built assets
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/console-api/dist /app/dist
# etc.
```

Both images build up to the `pnpm install` layer, so that layer is cached and reused across builds.

### 8.3 Path Filters (Reduce Unnecessary Builds)

GitHub Actions `on.push.paths` filter can skip workflows for unrelated changes:

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'apps/console-api/**'
      - 'packages/**'
      - 'package.json'
      - 'pnpm-lock.yaml'
      - '.github/workflows/push-to-staging.yml'
```

This workflow only runs if changes touch console-api, shared packages, or workflow files. If someone changes only `README.md`, the workflow is skipped.

**Separate workflows for each image:**

```yaml
# push-worker.yml
on:
  push:
    branches: [main]
    paths:
      - 'apps/worker/**'
      - 'packages/**'
      - '.github/workflows/push-worker.yml'

jobs:
  build-worker:
    runs-on: ubuntu-latest
    steps:
      # Build only worker image
```

**Caveat:** If shared packages change, *both* images should rebuild. So `packages/**` should appear in both path filters.

---

## 9. Concrete GitHub Actions Versions and Flags (Verify These)

| Action | Version | Key flags | Note |
|---|---|---|---|
| `actions/checkout` | `v4` | `ref: <sha>` | Use to check out specific commit (for workflow_run workflows) |
| `actions/setup-node` | `v4` | `cache: pnpm` | Restores node_modules from cache |
| `pnpm/action-setup` | `v4` | `version: 10.0.0` | Installs specific pnpm version |
| `azure/login` | `v2` | `client-id`, `tenant-id`, `subscription-id` | OIDC login; no credentials stored |
| `docker/setup-buildx-action` | `v3` | (none) | Enables Docker buildx for layer caching |
| `docker/build-push-action` | `v6` | `cache-from: type=gha`, `cache-to: type=gha` | Layer caching via GitHub Actions backend |

**Verify:** These versions are current as of 2025. GitHub Actions updates occasionally; check the official docs if you encounter unexpected behavior.

---

## 10. Database Migrations in CI/CD Detail

### 10.1 Running Migrations as ACA Job

The worker image includes a `scripts/migrate.sh` entrypoint:

```bash
#!/bin/bash
# scripts/migrate.sh
set -e
source .env.production  # Load DB connection string from Key Vault / env var
cd packages/db
npx prisma migrate deploy
```

The workflow invokes this:

```yaml
- name: Run Prisma migrations
  run: |
    az containerapp job start \
      --resource-group erria-staging \
      --name erria-migrate-staging \
      --image "erria-registry.azurecr.io/worker:${{ github.sha }}"
      # Implicitly runs the default container command or specified --command
```

**Verify:** Whether `az containerapp job start` supports `--command` to override the entrypoint, or if you need a dedicated migration image / job definition.

### 10.2 Polling Job Status

```bash
az containerapp job show \
  --resource-group erria-staging \
  --name erria-migrate-staging \
  --query "properties.latestJobExecution.status" -o tsv
```

Returns: `Succeeded`, `Failed`, `Running`, `NotStarted`.

**Poll loop in workflow:**
```bash
TIMEOUT=300
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  STATUS=$(...)
  if [[ "$STATUS" == "Succeeded" ]]; then exit 0; fi
  if [[ "$STATUS" == "Failed" ]]; then exit 1; fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
done
exit 1  # Timeout
```

**Verify:** Exact query paths and status values (may differ between Azure CLI versions).

---

## 11. Monitoring and Alerting

**Out of scope for this CI/CD design** — covered in the Azure solution architecture document (§8) — but briefly:

- **Application Insights:** Tracks Claude API call latency/failures, database query duration, 5xx errors.
- **Container App metrics:** CPU, memory, replica count.
- **Key Vault audit logs:** Every secret access (for compliance).
- **Alert rules:**
  - Console API 5xx rate > 1% → notify team.
  - Worker Claude API failures → notify team (differentiate auth errors from transient).
  - Postgres CPU > 80% → notify team.
  - Deployment failures → notify team (automatic from GitHub Actions).

**Action Group:** Email / Teams notification routing to the team.

---

## 12. Appendix: Dockerfile Structure (Simplified)

Both images follow a similar multi-stage pattern for optimal layer caching:

### Console API Dockerfile

```dockerfile
FROM node:24-alpine AS builder
WORKDIR /app

# Copy workspace manifests (shared across all images)
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY packages/ packages/
COPY apps/console-api/package.json apps/console-api/

# Install (expensive layer; cached across images)
RUN apk add --no-cache python3 make g++
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY apps/console-api/ apps/console-api/

# Build
RUN pnpm --filter @erria/console-api run build

# Runtime stage
FROM node:24-alpine
WORKDIR /app

# Install runtime dependencies only (no build tools)
ENV NODE_ENV=production
RUN apk add --no-cache tini

# Copy production dependencies
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages packages/
COPY --from=builder /app/apps/console-api/dist apps/console-api/dist

# Health endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => r.statusCode === 200 || process.exit(1))"

# Signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/console-api/dist/main.js"]
```

### Worker Dockerfile

```dockerfile
FROM node:24-alpine AS builder
# ... same as console-api up to build step ...

# Build
RUN pnpm --filter @erria/worker run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# Copy runtime deps
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages packages/
COPY --from=builder /app/apps/worker/dist apps/worker/dist

# Entrypoint: worker can run as HTTP server or as scheduled job
ENTRYPOINT ["node", "apps/worker/dist/main.js"]
CMD ["--mode=http"]  # Default: HTTP server

# For scheduled jobs: `docker run ... -- --mode=job --job=follow-up-cadence`
```

---

## 13. Summary Checklist

**Before deploying to production:**

- [ ] Federated OIDC credentials configured in Azure AD.
- [ ] GitHub Secrets populated: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
- [ ] Two ACR images pushed and working locally.
- [ ] Staging environment deployed and smoke tests passing.
- [ ] Prod environment exists and is empty (or running prior version).
- [ ] Database migrations have been reviewed for backward-compatibility (expand/contract).
- [ ] Rollback runbook drafted (step-by-step for team).
- [ ] Monitoring alerts configured (Application Insights, Container Apps, Key Vault).
- [ ] GitHub Environments configured for manual approval gates.
- [ ] `az containerapp job` migration job tested locally (or in staging).
- [ ] Team members have access to GitHub Actions logs and Azure portal for debugging.

---

## 14. Key Decisions and Trade-offs

| Decision | Reasoning | Alternative |
|---|---|---|
| **Two images, not one** | Worker scales to zero; console always on. Separate scaling profiles justify separate images. | One image with mode flag — simpler, but less flexible if scaling patterns diverge. |
| **Promote by digest, not rebuild** | Same image that passed staging tests. Faster release. | Rebuild for explicit reproducibility. Trade: 2 min slower release for absolute certainty. |
| **Manual approval for prod, no auto-promotion** | Two people, internal users — no need for automatic rollout. Explicit approval is safer. | Auto-promote after staging tests pass. Trade: slower time-to-prod for team oversight. |
| **Expand/contract migrations, enforced** | Only safe pattern for old-revision-reads-new-schema problem. No silent data loss. | Ignore the constraint — risk of data corruption during handoff. |
| **OIDC over service principal secret** | No stored secrets, automatic rotation, audit trail. Industry best practice. | Service principal secret in GitHub Secrets — simpler to set up, but higher risk. |
| **Two environments only (staging/prod)** | Explicit architectural decision from Azure doc. Team capacity. | Add dev/test/staging/prod/DR — 3x operational overhead for marginal testing value. |

---

## 15. Open Questions (Verify These)

- **`az containerapp job` syntax:** Exact CLI flags for passing an image and waiting for completion. Verify polling loop syntax.
- **ACA revision lifetime:** How many prior revisions are retained by default? Can team retrieve revision history after cleanup?
- **Traffic weight precision:** Can ACA shift traffic 90/10 (canary)? Or only 0/100 (all or nothing)?
- **Migrate as Job vs. as part of revision init:** Is there a `preDeploymentCommand` hook in ACA? Or must migration be a separate Job?
- **Docker buildx GHA cache:** Does caching work reliably across matrix builds (different images)? Any gotchas?
- **Prisma 7 cold start:** Confirm that `@prisma/adapter-pg` achieves <100ms cold start for scale-to-zero worker.
- **Azure CLI version and command stability:** Verify all `az` commands are stable/current as of 2025.
