# Architecture

This document explains **how the bridge works** and **why it is shaped this way**, then
gives a file-by-file tour of `core/`. Read this before changing anything in `core/` (though
normally you never should — you only add tools in `src/`).

---

## The one-paragraph version

An AI tool speaks MCP over HTTPS to `https://mcp.<yourdomain>/mcp`. Cloudflare terminates
TLS and forwards the request through a named tunnel to a loopback port on the R630, where
this container is listening. The container checks a bearer token, builds a **fresh,
stateless** MCP server for that single request, runs the requested tool inside a Postgres
transaction (read-only for read tools), and returns an **aggregate** JSON result. Then it
tears the per-request server down. No session state, no PII, no secrets ever leave.

---

## Request lifecycle

```
AI tool (Abacus / Claude)
    │  MCP over HTTPS, Authorization: Bearer <token>
    ▼
https://mcp.<domain>/mcp
    │  (Cloudflare edge terminates TLS)
    ▼
Cloudflare Tunnel "AM-mcp"  ──route──▶  http://localhost:<unique loopback port>
    ▼
mcp-bridge container  (core/server.ts)
    │  1. GET /health?  → 200 {status:"ok"} with NO auth  (healthcheck / probe)
    │  2. POST /mcp?    → verify Bearer token (core/auth.ts); 401 if missing/short/wrong
    │  3. reject body > 1 MB before parsing
    │  4. build a fresh McpServer + StreamableHTTPServerTransport for THIS request
    │  5. dispatch to the tool handler (src/tools/*.ts)
    ▼
core/db.ts  →  readOnly()/readWrite() transaction  →  Postgres
    ▼
core/result.ts  →  ok()/fail() shapes the JSON  →  back up the chain
```

---

## Design decisions (the "why")

### Stateless transport
Every request constructs its own `McpServer` and `StreamableHTTPServerTransport`, handles
the one request, and disposes of them. There is **no shared session map**, so there is
nothing to leak between callers, nothing to corrupt under concurrency, and no memory to
grow unbounded. It costs a tiny per-request allocation and buys a dramatically smaller
attack and bug surface. This is the single most important design choice.

### Fails closed
Auth is deny-by-default. If `MCP_BEARER_TOKEN` is unset or shorter than 32 characters,
`/mcp` rejects everything. There is no "dev mode" that disables auth. The only unauthenticated
route is `/health`, which returns no data.

### Read-only by construction
`readOnly()` wraps the handler in a `BEGIN TRANSACTION READ ONLY` ... `COMMIT`. A read tool
that accidentally contains an `UPDATE` fails at the database, not in review. Write tools must
opt in by using `readWrite()` and declaring `annotations.readOnlyHint: false`.

### Aggregates only
The bridge exists to answer "how many / how much / what status", not "show me the records".
This is a convention enforced by discipline (and code review), not by the framework — which
is exactly why the example tools and the golden rules hammer on it. Treat every response as
publicly loggable.

### Bounded everything
1 MB body cap, a connection pool capped at 4, a 10 s statement timeout, and a container
memory limit. A misbehaving caller cannot exhaust the host.

### Graceful shutdown
`SIGTERM`/`SIGINT` → stop accepting connections → `closePool()` → exit. Postgres
connections are released cleanly on container stop/restart.

---

## The ToolRegistration contract

The seam between generic core and domain code is one type:

```ts
export type ToolRegistration = (server: McpServer) => void;
```

`src/index.ts` calls `startBridge({ name, version?, tools, port? })`. For each registration
function in `tools`, the core calls it with the freshly-built `McpServer` so it can register
its capabilities. That is the entire extension API. A domain never imports the HTTP server,
the transport, or the auth code — it imports helpers (`readOnly`, `ok`, `safe`, …) from the
barrel and registers tools. This is what lets `core/` be pulled wholesale from upstream
without ever conflicting with domain code.

---

## File-by-file tour of `core/`

### `core/server.ts`
The heart. Exports `startBridge(opts)` and `buildMcpServer(opts)`.
- `buildMcpServer()` makes an `McpServer` and runs every `ToolRegistration` against it.
- `startBridge()` creates the Node HTTP server, routes `GET /health` (no auth) and
  `POST /mcp` (bearer-checked), enforces the 1 MB cap, builds a per-request server +
  `StreamableHTTPServerTransport`, and wires `SIGTERM`/`SIGINT` to `closePool()` + exit.
- `BridgeOptions`: `{ name, version?, tools, port? }`. `port` defaults to `MCP_PORT` or 3100.

### `core/auth.ts`
- `MIN_TOKEN_LENGTH = 32`.
- `isTokenConfigured()` — true only if `MCP_BEARER_TOKEN` is set and long enough.
- `verifyBearer(header)` — constant-time (`timingSafeEqual`) comparison of the presented
  token against the configured one. Returns false for any missing/short/mismatched token.

### `core/db.ts`
- A single `pg` `Pool` (lazily created), `max: 4`, `statement_timeout: 10000`,
  `application_name: process.env.APP_NAME ?? "mcp-bridge"`.
- Type parsers so `NUMERIC`/`INT8` come back as JS numbers and `DATE` as a string.
- `readOnly(fn)` — runs `fn(client)` inside a `READ ONLY` transaction.
- `readWrite(fn)` — runs `fn(client)` inside a read-write transaction (BEGIN/COMMIT, ROLLBACK on throw).
- `getPool()` / `closePool()` — pool access and graceful teardown.

### `core/result.ts`
- `ok(data)` / `fail(message)` — the standard MCP tool result envelopes.
- `safe(handler)` — wraps a handler so any thrown error becomes a `fail()` instead of a
  leaked stack trace.
- `BYTES_PER_GB` and `round(n, dp)` — small helpers for human-friendly aggregate numbers.

### `core/index.ts`
The public barrel. Domains import **only** from here. Re-exports `startBridge`,
`buildMcpServer`, the `BridgeOptions`/`ToolRegistration` types, the db helpers, the result
helpers, the auth helpers, and the `McpServer` type.

---

## Build & runtime shape

`tsconfig.json` has `rootDir: "."` and `include: ["core","src"]`, so `tsc` emits
`dist/core/*.js` and `dist/src/*.js` preserving the tree. That is why:
- the entry imports `../core/index.js` and tools import `../../core/index.js` (relative to
  the **compiled** location under `dist/`), and
- `package.json` `start` and the Docker `CMD` run `node dist/src/index.js`.

Node resolves plain relative `.js` imports at runtime; it does **not** read `tsconfig`
path aliases. Keeping everything as compiled relative imports is what makes the clone
"just run" with no bundler and no module-alias loader.
