/**
 * mcp-bridge-core — public barrel.
 *
 * Everything a domain needs is re-exported here, so a domain file only ever
 * imports from "../../core/index.js" (tools) or "../core/index.js" (entry).
 *
 * GENERIC CORE — do not edit per domain. Pull updates to the whole core/ dir
 * from github.com/jlwhitmire/mcp-bridge-core (see README § "Updating the core").
 */
export { startBridge, buildMcpServer } from "./server.js";
export type { BridgeOptions, ToolRegistration } from "./server.js";
export { readOnly, readWrite, getPool, closePool } from "./db.js";
export { ok, fail, safe, BYTES_PER_GB, round } from "./result.js";
export { isTokenConfigured, verifyBearer, MIN_TOKEN_LENGTH } from "./auth.js";

// Convenience re-export of the MCP server type so domain tools can type their
// register functions without importing the SDK path directly.
export type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
