# mcp-bridge-core

A reusable, **domain-agnostic MCP (Model Context Protocol) bridge** for exposing a
Postgres-backed app's **aggregate metrics and safe write actions** to AI tools (Abacus,
Claude, etc.) over an authenticated HTTPS endpoint.

This repo is the **shared foundation** extracted from the production Eyes Only Vault
bridge so that **any future domain** (e.g. `familyrecordkeeper.com`) can stand up its own
bridge in minutes **without ever touching the Eyes Only Vault project**. You clone this
repo, replace the example tools with your domain's tools, and deploy. The generic
plumbing is shared; only the tool definitions differ per domain.

> **Why a standalone repo?** Each project runs on its own supercomputer/VM that cannot
> see another project's filesystem. GitHub is the shared hub: this repo is the single
> place the plumbing lives, and every domain pulls from it.

---

## What you get

```
mcp-bridge-core/
├── core/                 # GENERIC PLUMBING — do not edit per domain
│   ├── server.ts         #   startBridge(): HTTP server, /health, /mcp, bearer auth, stateless transport, graceful shutdown
│   ├── auth.ts           #   fail-closed bearer-token check (>=32 chars, timing-safe compare)
│   ├── db.ts             #   pg Pool, readOnly()/readWrite() transaction helpers, type coercion
│   ├── result.ts         #   ok()/fail()/safe() response helpers, BYTES_PER_GB, round()
│   └── index.ts          #   public barrel — domains import everything from here
├── src/                  # YOUR DOMAIN — edit freely
│   ├── index.ts          #   entry point: name the bridge + list your tool modules
│   └── tools/
│       └── example.ts     #   example READ + WRITE tools (replace with yours)
├── scripts/smoke.mjs     # MCP client smoke test (lists tools, calls a read tool)
├── Dockerfile            # multi-stage build; runs as non-root; CMD node dist/src/index.js
├── docker-compose.snippet.yml  # hardened service block to paste into your server compose
├── .env.example          # the env vars the bridge reads
├── docs/
│   ├── ARCHITECTURE.md   # request lifecycle, design rationale, file-by-file tour
│   └── RUNBOOK-r630.md   # operational runbook: Cloudflare Tunnel routing, ports, tokens, verify-live
└── README.md             # this file
```

**The split is the whole idea:** `core/` is identical across every domain and should be
pulled, not forked. `src/` is where a domain's knowledge of its own tables lives. They
compile together as one project (`tsconfig` `include: ["core","src"]`), so there is no npm
publishing step and no runtime path-alias trickery — just relative imports of compiled JS.

---

## Quick start — stand up a new domain bridge

There are two ways to consume this repo. **Clone-as-template is recommended** for a new
domain; use a submodule only if you want many domains to track core updates automatically.

### Option A — Clone as a template (recommended)

On the new project's VM:

```bash
# 1. Clone the shared core into your new project
git clone https://github.com/jlwhitmire/mcp-bridge-core.git familyrecordkeeper-mcp-bridge
cd familyrecordkeeper-mcp-bridge

# 2. Detach from this repo and start your own history
rm -rf .git && git init

# 3. Install and confirm it compiles out of the box
pnpm install
pnpm run typecheck      # expect: no errors

# 4. Make it yours (see "Writing domain tools" below)
#    - edit src/index.ts   : rename the bridge, list your tool modules
#    - edit src/tools/*.ts  : replace example.ts with your real tools

# 5. Create your domain's own repo and push
#    (create an empty github.com/jlwhitmire/familyrecordkeeper-mcp-bridge first)
git add -A && git commit -m "Initial familyrecordkeeper MCP bridge from mcp-bridge-core"
git remote add origin https://github.com/jlwhitmire/familyrecordkeeper-mcp-bridge.git
git push -u origin main
```

**Pulling later core updates into a template clone:** because you detached, add this repo
as an upstream and cherry-pick the `core/` directory when you want fixes:

```bash
git remote add upstream https://github.com/jlwhitmire/mcp-bridge-core.git
git fetch upstream
git checkout upstream/main -- core      # overwrite ONLY core/ with the latest
pnpm run typecheck && git add core && git commit -m "Update mcp-bridge core from upstream"
```

You never hand-edit `core/`, so this overwrite is always safe.

### Option B — Git submodule (many domains, auto-tracked core)

If you prefer that `core/` stay a live reference to this repo:

```bash
# in your domain project
git submodule add https://github.com/jlwhitmire/mcp-bridge-core.git core-upstream
# point tsconfig include + your imports at core-upstream/core instead of core
# update the core later with:
git submodule update --remote core-upstream
```

Most people should use Option A — it is simpler and the clone compiles and runs with zero
configuration.

---

## Writing domain tools

A tool is a function that registers one capability on the MCP server. You write these in
`src/tools/` and list them in `src/index.ts`. `src/tools/example.ts` is a complete,
heavily-commented reference — copy it.

```ts
import { z } from "zod";
import { readOnly, readWrite, ok, fail, safe, type McpServer } from "../../core/index.js";

export function registerExampleTools(server: McpServer): void {
  // A READ tool — uses readOnly() (transaction is READ ONLY at the DB level)
  server.tool(
    "get_example_counts",
    "Return aggregate counts. Aggregates only — never rows, PII, or secrets.",
    {},
    safe(async () => {
      const rows = await readOnly(async (c) => (await c.query("select count(*)::int as n from your_table")).rows);
      return ok({ total: rows[0]?.n ?? 0 });
    }),
  );

  // A WRITE tool — uses readWrite() and declares it mutates state
  server.tool(
    "set_example_note",
    "Set a note. A mutating action.",
    { note: z.string().min(1).max(500) },
    { annotations: { readOnlyHint: false } },
    safe(async ({ note }) => {
      await readWrite(async (c) => c.query("update your_table set note = $1 where id = 1", [note]));
      return ok({ saved: true });
    }),
  );
}
```

### The four golden rules for domain tools

1. **Reads use `readOnly()`, writes use `readWrite()`.** `readOnly()` opens a `READ ONLY`
   transaction, so a read tool physically cannot mutate data even if the SQL is wrong.
2. **Aggregates only — never return rows of PII or any secret.** Counts, sums, GB totals,
   statuses. The bridge is reachable by AI tools; treat every response as if it could be
   logged. No emails, no tokens, no raw user records.
3. **Validate every input with `zod`.** The third argument to `server.tool()` is a zod
   shape. Writes must declare `{ annotations: { readOnlyHint: false } }`.
4. **Wrap every handler in `safe()`.** It catches exceptions and returns a structured
   error instead of leaking a stack trace to the caller.

That's the entire contract. Everything else (auth, transport, pooling, shutdown) is handled
by `core/` and you never touch it.

---

## Security model

- **Fail-closed bearer auth.** `/mcp` rejects every request unless the `Authorization:
  Bearer <token>` header matches `MCP_BEARER_TOKEN`, which must be **≥32 characters**. If no
  token is configured the endpoint refuses all traffic. Comparison is timing-safe.
- **`/health` needs no auth** (so the container healthcheck and tunnel can probe it) and
  returns only `{status, authConfigured}` — never data.
- **Read-only by default.** Read tools run inside `READ ONLY` transactions.
- **Stateless transport.** A fresh MCP server + transport is built per request; there is no
  cross-request session state to leak or corrupt.
- **1 MB request cap**, enforced before parsing.
- **Hardened container.** Runs as a non-root user; the compose snippet adds a read-only
  root filesystem, `cap_drop: ALL`, `no-new-privileges`, a tmpfs `/tmp`, and a memory limit.
- **Loopback-only exposure.** The container port is published to `127.0.0.1` only; the
  public edge is a Cloudflare Tunnel (see the runbook). The bridge never listens on
  `0.0.0.0` on the host.

---

## Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `MCP_BEARER_TOKEN` | **yes** | ≥32-char secret. Generate with `openssl rand -hex 32`. |
| `DATABASE_URL` | **yes** | Postgres connection string for this domain's own database. |
| `MCP_PORT` | no | Listen port inside the container. Defaults to `3100`. |
| `APP_NAME` | no | `application_name` shown in Postgres. Defaults to `mcp-bridge`. |

Never commit `.env`. `.gitignore` already excludes it (and keeps `.env.example`).

---

## Deploying

The bridge is a small Docker container that each domain runs on the shared R630 server
behind one Cloudflare Tunnel. Each domain gets its **own container, own token, own
database, own tunnel route, and a UNIQUE host loopback port** (Eyes Only Vault already uses
`3100`, so the next domain uses `3101`, and so on).

The full, copy-paste operational procedure — compose service block, picking a free port,
adding the tunnel route, verify-live curls, token rotation, and registering the bridge in
Abacus as a remote MCP server — lives in **[docs/RUNBOOK-r630.md](docs/RUNBOOK-r630.md)**.

For the design rationale and a file-by-file tour of `core/`, see
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Reference implementation

The **Eyes Only Vault** bridge is the production reference implementation of this pattern
(its tool files — metrics, phase, users, deletion queue, storage, logs — are the real-world
examples these generic tools were distilled from). This repo is self-contained, though:
**consuming projects depend only on `mcp-bridge-core`, never on the Eyes Only Vault repo.**

---

## License / ownership

Private. Internal tooling for jlwhitmire's projects.
