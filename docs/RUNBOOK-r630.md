# R630 Operations Runbook

How to deploy, route, verify, and maintain a domain's MCP bridge on the shared **Dell
PowerEdge R630** server. Copy-paste procedures. **You run every command on the server
yourself** (the assistant cannot SSH to the R630).

> Server: Dell PowerEdge R630, Ubuntu 20.04.6 (ESM). SSH as `mkeeper@cwp.memorialkeeper.com`.
> Deployment mode: Docker Compose, with Virtualmin/Apache handling normal web vhosts and a
> single Cloudflare Tunnel handling the `mcp.*` hostnames.

---

## The shared-server model (read this first)

One R630 hosts **many** domains. One Cloudflare Tunnel (`AM-mcp`) carries **all** the MCP
routes. Each domain gets:

| Per-domain resource | Eyes Only Vault | familyrecordkeeper (example) | Rule |
|---|---|---|---|
| Public hostname | `mcp.eyesonlyvault.com` | `mcp.familyrecordkeeper.com` | one per domain |
| Host loopback port | `127.0.0.1:3100` | `127.0.0.1:3101` | **must be unique per domain** |
| Container | `eyesonlyvault` bridge | `familyrecordkeeper` bridge | one per domain |
| Bearer token | its own | its own | never shared |
| Database | its own `DATABASE_URL` | its own `DATABASE_URL` | never shared |
| Tunnel route | in `AM-mcp` | in `AM-mcp` | all routes live in the one tunnel |

**The unique-port rule is the one that bites.** Two bridges cannot both publish
`127.0.0.1:3100`. Before deploying a new domain, check what's taken:

```bash
sudo ss -ltnp | grep 127.0.0.1:31   # see which 31xx loopback ports are already in use
```

Pick the next free one (EOV = 3100, so familyrecordkeeper = 3101).

---

## Cloudflare Tunnel

- Tunnel name: **AM-mcp**, ID `f3edf23d-f7cf-4038-8222-65666779fef5`.
- It is a **token-run / dashboard-managed** tunnel: ingress routes are configured in the
  Cloudflare dashboard (Zero Trust → Networks → Tunnels → **AM-mcp** → **Public Hostname**
  / **Routes**), **not** in a local `config.yml`.
- To add a new domain, add a Public Hostname entry in that tab:
  - **Subdomain**: `mcp`  **Domain**: `familyrecordkeeper.com`
  - **Service**: `HTTP`  **URL**: `localhost:3101`  (the unique loopback port you picked)
- Cloudflare provisions the DNS CNAME automatically. No server restart needed for a route
  add.

---

## Deploy a new domain bridge

### 1. Get the code onto the server
Clone the domain's own bridge repo (the one you created from `mcp-bridge-core` — see the
main README "Quick start"):

```bash
cd /opt   # or wherever your domain stacks live
git clone https://github.com/jlwhitmire/familyrecordkeeper-mcp-bridge.git
cd familyrecordkeeper-mcp-bridge
```

### 2. Create `.env`

```bash
cp .env.example .env
# generate a strong token
echo "MCP_BEARER_TOKEN=$(openssl rand -hex 32)" >> .env   # 64 hex chars = 32 bytes, well over the 32-char minimum
# then edit .env to set DATABASE_URL (this domain's own DB) and, if 3100 is taken, MCP_PORT
nano .env
```

### 3. Add the hardened service to your server compose
Paste the block from `docker-compose.snippet.yml` into this domain's `docker-compose.yml`,
then add a **port override** so the tunnel can reach it on your chosen UNIQUE loopback port.
Keep it loopback-only (`127.0.0.1:`), never `0.0.0.0`:

```yaml
# docker-compose.mcp-port.yml  (override file)
services:
  mcp-bridge:
    ports:
      - "127.0.0.1:3101:3100"   # host 3101 (unique) -> container 3100
```

### 4. Build and start

```bash
docker compose -f docker-compose.yml -f docker-compose.mcp-port.yml up -d --build mcp-bridge
docker compose logs -f mcp-bridge     # watch it come up
```

---

## Verify live

From the server (loopback), then from the public edge:

```bash
# health (no auth) — expect {"status":"ok","authConfigured":true}
curl -s http://127.0.0.1:3101/health

# /mcp with no token — expect HTTP 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3101/mcp

# tools/list through the public hostname (needs the Accept header for the streamable transport)
TOKEN=$(grep MCP_BEARER_TOKEN .env | cut -d= -f2)
curl -s https://mcp.familyrecordkeeper.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Seeing your tool names in that last response means the whole chain (Cloudflare → tunnel →
loopback → container → auth → MCP) is working.

---

## Token management

- The token lives only in the repo-root `.env` as `MCP_BEARER_TOKEN`. The container reads it
  at start. Confirm what's actually loaded:

```bash
docker exec <container> printenv MCP_BEARER_TOKEN
```

- **Rotation:**

```bash
cp .env .env.bak.$(date +%F)
NEW=$(openssl rand -hex 32)
sed -i "s|^MCP_BEARER_TOKEN=.*|MCP_BEARER_TOKEN=$NEW|" .env
docker compose -f docker-compose.yml -f docker-compose.mcp-port.yml up -d mcp-bridge
```

  Then update the token wherever the bridge is registered (Abacus — see below).

---

## Register the bridge in Abacus

Each domain's bridge is registered as its **own remote MCP server** (exactly like the
existing `eyesonlyvault_mcp` one):

- **URL**: `https://mcp.familyrecordkeeper.com/mcp`
- **Auth header**: `Authorization: Bearer <that domain's MCP_BEARER_TOKEN>`

Once registered, its tools appear to the AI alongside any other configured servers.

---

## Updating an already-deployed bridge

When you push new tool code to the domain's repo, pull and rebuild on the R630:

```bash
cd /opt/familyrecordkeeper-mcp-bridge
git pull
docker compose -f docker-compose.yml -f docker-compose.mcp-port.yml up -d --build mcp-bridge
docker compose logs -f mcp-bridge
```

To also pick up fixes to the generic core, pull them from `mcp-bridge-core` first (README §
"Pulling later core updates"), commit, push, then run the lines above.

---

## Per-domain deployment checklist

- [ ] Picked a **unique** loopback port (`ss -ltnp | grep 127.0.0.1:31`).
- [ ] Generated a fresh `MCP_BEARER_TOKEN` (`openssl rand -hex 32`).
- [ ] Set this domain's own `DATABASE_URL` in `.env`.
- [ ] Pasted the hardened compose service + the loopback port override.
- [ ] `docker compose up -d --build` succeeded; `/health` returns `authConfigured:true`.
- [ ] Added the `mcp.<domain>` Public Hostname route in the AM-mcp tunnel → `localhost:<port>`.
- [ ] `/mcp` with no token returns 401; `tools/list` over HTTPS returns your tools.
- [ ] Registered the bridge as a remote MCP server in Abacus with its own URL + token.
