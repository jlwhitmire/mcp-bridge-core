import pg from "pg";

/**
 * Lazy Postgres pool. Read tools run inside `BEGIN READ ONLY` so a bug in a
 * query can never mutate data; the only write path is `readWrite`, used by
 * explicitly-marked write tools.
 *
 * GENERIC CORE FILE — do not edit per domain. The only thing a domain supplies
 * is the DATABASE_URL env var (its own database) and, optionally, APP_NAME
 * (shown as the Postgres application_name for easy identification).
 */
let pool: pg.Pool | null = null;

// NUMERIC -> JS number (money / GB values with <=4 dp are well within float precision).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
// INT8 (COUNT/SUM of bigint) -> number; byte totals stay < 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// DATE -> plain YYYY-MM-DD string (avoid timezone shifts).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not configured");
    pool = new pg.Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
      application_name: process.env.APP_NAME ?? "mcp-bridge",
    });
    pool.on("error", (err) => console.error("[mcp-bridge] pg pool error:", err.message));
  }
  return pool;
}

async function inTx<T>(mode: "READ ONLY" | "READ WRITE", fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(`BEGIN ${mode}`);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Run one or more SELECTs in a read-only transaction. Use this for every read tool. */
export function readOnly<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return inTx("READ ONLY", fn);
}

/** Run a mutation in a read-write transaction. Use ONLY in tools you have marked as WRITE. */
export function readWrite<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return inTx("READ WRITE", fn);
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}
