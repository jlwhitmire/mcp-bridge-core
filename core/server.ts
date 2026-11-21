/**
 * Generic MCP bridge core (Streamable HTTP, stateless).
 *
 *   GET  /health  -> 200 {status:"ok"}          (no auth; Docker healthcheck)
 *   POST /mcp     -> MCP JSON-RPC               (Bearer <MCP_BEARER_TOKEN>)
 *
 * GENERIC CORE FILE — do not edit per domain. A domain supplies only its name
 * and its list of tool-registration functions via startBridge().
 *
 * Design notes (why it is shaped this way):
 *  - Stateless mode: a fresh McpServer + transport is built per request, so
 *    there is no shared session state to leak or corrupt between callers.
 *  - Fails closed: /mcp rejects every request unless a >=32-char bearer token
 *    matches (see auth.ts).
 *  - Body cap: requests over 1 MB are rejected before parsing.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isTokenConfigured, verifyBearer } from "./auth.js";
import { closePool } from "./db.js";

/** A tool-registration function: given the MCP server, register one or more tools on it. */
export type ToolRegistration = (server: McpServer) => void;

export interface BridgeOptions {
  /** Unique bridge name, e.g. "familyrecordkeeper-mcp-bridge". Shown to MCP clients. */
  name: string;
  /** Semver string for the bridge. Defaults to "0.1.0". */
  version?: string;
  /** The domain's tool-registration functions. Each receives the McpServer and registers tools. */
  tools: ToolRegistration[];
  /** Listen port. Defaults to process.env.MCP_PORT or 3100. */
  port?: number;
}

const MAX_BODY_BYTES = 1024 * 1024;

/** Build a fresh McpServer with all the domain's tools registered. */
export function buildMcpServer(opts: BridgeOptions): McpServer {
  const server = new McpServer({ name: opts.name, version: opts.version ?? "0.1.0" });
  for (const register of opts.tools) register(server);
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Payload too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

async function handleMcp(opts: BridgeOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    return;
  }
  // Stateless mode: fresh server + transport per request.
  const server = buildMcpServer(opts);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, await readJson(req));
}

/**
 * Start the bridge HTTP server. Returns the node http.Server (useful in tests).
 * Registers SIGTERM/SIGINT handlers that drain the DB pool and exit cleanly.
 */
export function startBridge(opts: BridgeOptions): Server {
  const port = opts.port ?? Number(process.env.MCP_PORT ?? 3100);

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health") {
      sendJson(res, 200, { status: "ok", authConfigured: isTokenConfigured() });
      return;
    }

    if (url.pathname === "/mcp") {
      if (!verifyBearer(req)) {
        res.setHeader("WWW-Authenticate", `Bearer realm="${opts.name}"`);
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      handleMcp(opts, req, res).catch((err: unknown) => {
        console.error("[mcp] request failed:", err);
        if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  });

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(
      `[${opts.name}] listening on :${port}` +
        (isTokenConfigured() ? "" : " — WARNING: MCP_BEARER_TOKEN unset/short, all /mcp calls will be rejected"),
    );
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => httpServer.close(() => void closePool().finally(() => process.exit(0))));
  }

  return httpServer;
}
