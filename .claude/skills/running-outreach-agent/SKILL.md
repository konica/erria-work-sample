---
name: running-outreach-agent
description: Use when launching, running, or smoke-testing this repo's apps (console-api, worker, console-web) — or when install/boot fails with EPERM symlink from pnpm, ENOENT copyfile from .pnpm-store, PrismaConfigEnvError, ERR_MODULE_NOT_FOUND for @erria/db/dist/index.js, Missing required environment variable DATABASE_URL, "port is already allocated" on compose up, a Prisma migration stuck in a failed state, or a dev server that answers on localhost but is unreachable from the host.
---

# Running the Erria outreach agent

## Overview

Three runtime processes:

| App | Stack | Port | What it serves |
|---|---|---|---|
| `console-api` | NestJS (Express) | 3000 | `/health`, `/api/queue`, `/api/accounts/:id` |
| `worker` | Fastify | 3100 | `/health`, plus a `--job=<name>` CLI stub |
| `console-web` | React 19 + Vite | 5173 | the queue UI; proxies `/api` and `/internal` to :3000 |

There is no drafting/tiering/escalation *flow* to drive — `@erria/domain` holds that logic but no
app imports it. The console renders whatever rows are already in the database.

The filesystem traps are already fixed in `/etc/sandbox-persistent.sh` (sourced before every Bash
call). Preflight it, then run four steps in order.

## Quick reference

`pnpm bootstrap` now detects three of these itself (Ticket #115) and prints the fix inline instead
of the raw error — those rows say **Automatic** below. Everything else is still manual, mostly
because it's sandbox-specific preflight that has no business in a script meant to run on a real
developer's machine.

| Symptom | Cause | Fix |
|---|---|---|
| `EPERM: operation not permitted, symlink` on install | Repo is a virtiofs mount from a Windows host — no symlinks | Preflight (manual — sandbox-specific) |
| `ENOENT ... copyfile '.pnpm-store/...'` | pnpm store defaulted onto that same mount | Preflight (manual — sandbox-specific) |
| `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL` | `.env` missing at install time — only in checkouts/worktrees predating `c1e6d2f` | Step 1 (manual — historical, already fixed at that commit) |
| `Bind for :::5432 failed: port is already allocated` | A leftover Postgres container from an earlier session holds 5432 | **Automatic** — `pnpm bootstrap` reuses the container if it belongs to this repo's own `erria` stack, otherwise prints the inspect/backup/remove sequence below instead of letting Compose's bind error surface |
| `Following migration have failed: <name>` | An aborted `migrate` run left the bookkeeping row failed though the DDL completed | **Automatic** — `pnpm bootstrap` prints the exact `prisma migrate resolve --applied` hotfix once every table the migration creates is confirmed present |
| `ERR_MODULE_NOT_FOUND` for `@erria/db/dist/index.js` | `@erria/db` not compiled; `dev` is `tsx watch`, which won't build deps | **Automatic** on `pnpm bootstrap --start` — fails fast with "run `pnpm build`" instead of a raw Node crash |
| `Missing required environment variable DATABASE_URL` at boot | Apps read `process.env` and never load `.env` | Step 4 (manual — bootstrap still expects the environment already loaded) |
| App answers on `localhost` but not from the host | Bound to loopback; published ports forward to `eth0` | [Reaching it from the host](#reaching-it-from-the-host) (manual — sandbox-specific) |
| Vite: `Blocked request. This host is not allowed.` | Vite rejects unknown `Host` headers even when the socket is open | Same section (manual — sandbox-specific) |
| `Failed to build optional crypto binding` (ssh2, `make: g++: No such file`) | Optional native dep, no compiler in image | Ignore — harmless (manual — nothing to fix) |

## Preflight

`/etc/sandbox-persistent.sh` bind-mounts each `node_modules` onto the sandbox overlay (the virtiofs
mount rejects the symlinks pnpm needs) and pins `npm_config_store_dir` off that mount. Confirm both:

```bash
cd /c/Data/Projects/ERRIA/work_sample
ln -s /tmp node_modules/.__t && rm node_modules/.__t   # must succeed
pnpm config get store-dir                              # must NOT be under /c/Data
```

If the symlink fails, that block is missing from `/etc/sandbox-persistent.sh` — restore it there
rather than mounting by hand, so it survives sandbox restarts and covers worktrees too. It loops
over the main checkout plus `.claude/worktrees/*/`, guarded by `mountpoint -q` so it is idempotent.

## 1. Install and create `.env`

```bash
pnpm install
cp .env.example .env      # defaults match compose.yaml
```

Either order works as of `c1e6d2f`: `prisma.config.ts` reads `process.env.DATABASE_URL` rather
than Prisma's `env()` helper, so the `postinstall` `prisma generate` no longer throws when `.env`
is absent. In a worktree checked out before that commit, `.env` must exist first.

## 2. Postgres + schema

Use the repo's compose stack — **not** a hand-rolled `docker run`. `compose:up` also applies
migrations, and the fixed project name (`erria`) keeps one stack across worktrees.

```bash
pnpm compose:up      # docker compose up -d --wait, then prisma migrate deploy
```

Verify: `pnpm --filter @erria/db exec prisma migrate status` → `Database schema is up to date!`

### If 5432 is already allocated

Earlier sessions left ad-hoc containers behind. Look before you delete — one may hold demo rows
that no seed script can regenerate (there is no seed script in this repo):

```bash
docker ps -a --format '{{.Names}} {{.Status}} {{.Ports}}'
docker exec <name> psql -U erria -d erria_dev -tAc \
  "select relname, n_live_tup from pg_stat_user_tables order by n_live_tup desc"
```

Credentials match `.env` (`erria`/`erria`/`erria_dev`), so an existing container is usually usable
as-is. Keep it if it holds data; otherwise `docker rm -f <name>` and re-run `compose:up`. Dump
first either way: `docker exec <name> pg_dump -U erria -d erria_dev > backup.sql`.

### If a migration is stuck "failed"

An aborted run can mark `20260803052443_init` failed even though every table exists. Confirm the
schema really is complete before touching the bookkeeping — all 11 `CREATE TABLE`s from the
migration must be present:

```bash
docker exec <name> psql -U erria -d erria_dev -tAc \
  "select table_name from information_schema.tables where table_schema='public' order by 1"
grep -oP 'CREATE TABLE "\K[^"]+' packages/db/prisma/migrations/*/migration.sql | sort
```

If they match (12 tables = 11 models + `_prisma_migrations`), use Prisma's documented hotfix rather
than wiping the volume:

```bash
pnpm --filter @erria/db exec prisma migrate resolve --applied "20260803052443_init"
```

## 3. Build workspace packages

`@erria/db` resolves via its `main` field to `dist/index.js`. Only `console-api` imports it today,
so skipping this breaks `console-api` alone — but the worker declares the dep, so build both.

```bash
pnpm build     # needs no exported env; prisma.config.ts loads .env itself
```

Note `@erria/domain` declares `main: ./dist/index.js` but has no `src/index.ts`, so that file is
never emitted. Harmless today because nothing imports the package by name — but the first code to
do so must add the barrel file or import module paths directly.

## 4. Launch — export `.env` yourself

No app loads `.env`; they read `process.env` and throw at boot without it. Use `setsid nohup` so
the servers outlive the Bash call that starts them.

```bash
set -a && . ./.env && set +a
setsid nohup pnpm --filter console-api dev > /tmp/api.log 2>&1 < /dev/null &
setsid nohup pnpm --filter worker      dev > /tmp/wrk.log 2>&1 < /dev/null &
setsid nohup pnpm --filter console-web dev > /tmp/web.log 2>&1 < /dev/null &
for i in $(seq 1 90); do
  curl -sf localhost:3000/health >/dev/null && curl -sf localhost:3100/health >/dev/null \
    && curl -sf localhost:5173/ >/dev/null && { echo "ALL UP after ${i}s"; break; }
  grep -qiE 'Error|ERR_|EADDRINUSE' /tmp/api.log /tmp/wrk.log /tmp/web.log \
    && { grep -iE 'Error|ERR_' /tmp/api.log /tmp/wrk.log /tmp/web.log | head -3; break; }
  sleep 1
done
```

`GET /` on :3000 and :3100 is a 404 — neither app defines a root route. Health-check the paths.

## Reaching it from the host

The sandbox reaches the host only through published ports, and publishing forwards to `eth0`. A
server on loopback never sees that traffic: healthy inside, dead port outside.

**Bind `::`, never `::1` or `127.0.0.1`.** Prefer `::` over `0.0.0.0` — Node opens it dual-stack,
so one socket takes IPv6 and IPv4-mapped connections and works whichever stack the forward uses.

Current state, all three already correct:

- `console-api` — `app.listen(port)`; Nest binds `::` by default. Nothing to do.
- `worker` — passes `host: '0.0.0.0'` explicitly in `src/main.ts`. IPv4-only, but reachable.
- `console-web` — `server.host: '::'` in `vite.config.ts`, plus `server.allowedHosts: true`.
  Binding alone is not enough: a forwarded request carries a non-localhost `Host` header and Vite
  rejects it with "Blocked request". That flag disables DNS-rebinding protection and affects
  `vite dev` only, never `vite build`.

Verify by reachability, never by reading source:

```bash
IP=$(hostname -I | awk '{print $1}')
curl -s --noproxy '*' "http://$IP:3000/health"    # {"status":"ok"}
curl -s --noproxy '*' "http://$IP:3100/health"    # {"status":"ok"}
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' "http://$IP:5173/"   # 200
```

`--noproxy '*'` is required — without it the sandbox HTTP proxy intercepts and the probe reports a
failure that has nothing to do with the bind.

To inspect sockets (`ss`/`netstat` are absent), read `/proc/net/tcp6`: `::` is all zeros, `::1`
ends in `01000000`.

Then, on the **host**:

```bash
sbx ports $SANDBOX_VM_ID --publish 5173:5173/tcp    # UI; enough on its own
sbx ports $SANDBOX_VM_ID --publish 3000:3000/tcp    # optional, direct API
```

Port 5173 alone suffices for the UI — the browser only talks to Vite, which proxies `/api`
server-side.

## Drive it

```bash
curl -s localhost:3000/health                      # {"status":"ok"}
curl -s localhost:3100/health                      # {"status":"ok"}
curl -s localhost:3000/api/queue                   # {"items":[...],"total":N,...}
curl -s localhost:3000/api/accounts/<uuid>         # account + vessels + contacts + pendingMessage
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/accounts/00000000-0000-0000-0000-000000000000  # 404
pnpm --filter worker exec tsx src/main.ts --job=followup-cadence   # stub line, exit 0
pnpm --filter worker exec tsx src/main.ts --job=bogus-job          # "Unknown job: ...", exit 1
```

The `--job=` branch returns before the `DATABASE_URL` check, so it needs neither the database nor
the exported environment — the cheapest proof the worker's entrypoint resolves.

### Seeing the UI

`chromium-cli` is not installed, but Playwright's browser cache is
(`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`), and `playwright-core` is present in
the npx cache — locate it with `find / -maxdepth 8 -type d -name playwright-core`. Drive it with a
few lines of Node:

```js
import { chromium } from '<playwright-core>/index.mjs';
const browser = await chromium.launch({
  executablePath: '/home/agent/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args: ['--no-sandbox', '--no-proxy-server'],   // --no-proxy-server, same reason as --noproxy
});
const page = await (await browser.newContext()).newPage();
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.screenshot({ path: '/tmp/console-web.png', fullPage: true });
```

Wait for a row's text before screenshotting, or you capture the "Loading queue…" state. **Look at
the PNG** — a blank frame means it never rendered. One console 404 for `/favicon.ico` is expected;
`index.html` declares none.

## Common mistakes

- **`pkill -f 'tsx watch'` kills your own shell** (exit 144 / silent death): `-f` matches full
  command lines, and yours contains the pattern. Use a bracket: `pkill -f 'ts[x] watch'`.
- **Killing the watcher orphans its child.** `tsx watch` spawns a separate `node ... src/main.ts`
  that keeps holding the port. Kill both: `pkill -f 'ts[x] watch'; pkill -f 'main[.]ts'`.
- **`ss` and `netstat` do not exist in this image.** `ss -ltnp | grep :3000` prints nothing whether
  or not something is listening — that empty output is not evidence. Probe with `curl` instead.
- **`curl` to a non-loopback address without `--noproxy '*'`.** It goes through the sandbox proxy
  and fails for reasons unrelated to your app. Loopback is in `NO_PROXY`; `eth0` is not.
- **Reading a killed process's piped output.** `timeout 20 pnpm ... | grep` loses block-buffered
  output on SIGTERM and looks like silent success. Redirect to a file, then read the file.
- **Re-running `pnpm install` to fix a boot error.** Install does not build workspace packages;
  step 3 is separate.
- **Treating `pnpm test` as proof the app runs.** It uses Testcontainers and never boots any app.
- **Trusting the README's Status section.** It has lagged the code more than once. Check the tree.

## Teardown

```bash
pkill -f 'ts[x] watch'; pkill -f 'main[.]ts'; pkill -f 'vit[e]'
pnpm compose:down     # keeps the volume; compose:reset wipes it
```
