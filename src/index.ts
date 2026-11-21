/**
 * Bridge entry point — THIS FILE IS YOURS TO EDIT.
 *
 * Rename the bridge and register your domain's tool modules here. The generic
 * plumbing (HTTP server, bearer auth, stateless MCP transport, DB pool,
 * read-only transactions, graceful shutdown) all lives in ../core and is
 * driven by this one call.
 */
import { startBridge } from "../core/index.js";
import { registerExampleTools } from "./tools/example.js";

startBridge({
  // TODO: rename to "<yourdomain>-mcp-bridge", e.g. "familyrecordkeeper-mcp-bridge".
  name: "example-mcp-bridge",
  version: "0.1.0",
  tools: [
    registerExampleTools,
    // ...add your other tool modules here. Each is a (server) => void function.
  ],
});
