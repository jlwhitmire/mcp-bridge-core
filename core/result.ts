import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool result helpers + the `safe` wrapper that stops internal errors (which
 * may contain connection strings etc.) from ever reaching the caller.
 *
 * GENERIC CORE FILE — do not edit per domain.
 */

/** JSON tool result (text content + structuredContent for capable clients). */
export function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wrap a tool handler: any thrown error becomes an isError result with a
 * generic message (details go to the container log, never to the caller).
 */
export function safe<A>(tool: string, fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      console.error(`[mcp-bridge] ${tool} failed:`, err instanceof Error ? err.message : err);
      return fail(`${tool}: internal error (see mcp-bridge logs)`);
    }
  };
}

export const BYTES_PER_GB = 1024 ** 3;
export const round = (n: number, dp = 4): number => Math.round(n * 10 ** dp) / 10 ** dp;
