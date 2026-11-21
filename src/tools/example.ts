/**
 * EXAMPLE DOMAIN TOOLS — copy this file, rename it, and replace the bodies with
 * your product's real aggregate queries. Delete this example once you have your
 * own tools.
 *
 * The golden rules for a bridge tool (why this file is shaped the way it is):
 *  1. Read tools use `readOnly(...)` — the query runs in BEGIN READ ONLY, so a
 *     bug can never mutate data. Write tools use `readWrite(...)` AND are marked
 *     with annotations.readOnlyHint:false so the AI client knows they change data.
 *  2. Expose AGGREGATES ONLY — counts, sums, status rows. NEVER return secrets,
 *     password/key material, raw PII, or user content. The whole point of a
 *     bridge is to hand an AI useful numbers without handing it the vault.
 *  3. Validate every input with zod. Return fail("...") for bad input; let the
 *     `safe()` wrapper swallow unexpected throws so internal details never leak.
 *  4. Wrap every handler in `safe("<tool_name>", ...)`.
 */
import { z } from "zod";
import { ok, fail, safe, readOnly, readWrite, type McpServer } from "../../core/index.js";

export function registerExampleTools(server: McpServer): void {
  // ---- READ: a simple aggregate count -------------------------------------
  server.registerTool(
    "get_example_counts",
    {
      title: "Example aggregate counts",
      description:
        "Template read tool. Returns an aggregate count from your database. Replace the query with your own. Read-only.",
      inputSchema: {
        // Example optional filter. Remove or change for your schema.
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
          .optional()
          .describe("Only count rows on/after this date (YYYY-MM-DD)"),
      },
    },
    safe("get_example_counts", async ({ since }: { since?: string }) => {
      const row = await readOnly(async (c) => {
        // TODO: replace `your_table` and columns with your real schema.
        const res = await c.query<{ total: number }>(
          `SELECT COUNT(*)::int AS total
             FROM your_table
            WHERE ($1::date IS NULL OR created_at >= $1::date)`,
          [since ?? null],
        );
        return res.rows[0] ?? { total: 0 };
      });
      return ok({ total: row.total, since: since ?? null });
    }),
  );

  // ---- WRITE: a guarded mutation ------------------------------------------
  // Delete this entirely if your bridge is read-only (recommended default).
  server.registerTool(
    "set_example_note",
    {
      title: "Set example note (WRITE)",
      description:
        "Template WRITE tool. Updates a note on a row. Replace with your own mutation, or delete if the bridge should stay read-only.",
      inputSchema: {
        id: z.number().int().positive().describe("Row id to update"),
        note: z.string().max(500).describe("Note text (<=500 chars)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe("set_example_note", async ({ id, note }: { id: number; note: string }) => {
      const row = await readWrite(async (c) => {
        // TODO: replace with your real UPDATE.
        const res = await c.query<{ id: number }>(
          `UPDATE your_table SET note = $2 WHERE id = $1 RETURNING id`,
          [id, note],
        );
        return res.rows[0] ?? null;
      });
      if (!row) return fail(`set_example_note: no row with id ${id}`);
      return ok({ updated: true, id: row.id });
    }),
  );
}
