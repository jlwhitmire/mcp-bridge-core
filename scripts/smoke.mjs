// Smoke test: node scripts/smoke.mjs <url>  — needs MCP_BEARER_TOKEN in env.
// Lists tools, then calls get_example_counts once. Adapt the `calls` array to
// your real tools. Write tools only run when SMOKE_WRITE=1.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.argv[2] ?? "http://localhost:3100/mcp");
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` } },
});
const client = new Client({ name: "bridge-smoke", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).sort().join(", "));

const calls = [["get_example_counts", {}]];
if (process.env.SMOKE_WRITE === "1") {
  calls.push(["set_example_note", { id: 1, note: "smoke-test" }]);
}
for (const [name, args] of calls) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    console.log(`\n## ${name} ${JSON.stringify(args)} -> ${r.isError ? "ERROR" : "ok"}\n${text.slice(0, 900)}`);
  } catch (e) {
    console.log(`\n## ${name} ${JSON.stringify(args)} -> THROWN ${e.message.slice(0, 300)}`);
  }
}
await client.close();
