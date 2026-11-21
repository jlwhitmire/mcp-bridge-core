import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Bearer token verification. Fails CLOSED: if MCP_BEARER_TOKEN is unset or
 * shorter than 32 chars, every request is rejected.
 *
 * GENERIC CORE FILE — do not edit per domain. (Extracted from the Eyes Only
 * Vault bridge, which this pattern is proven in production on.)
 */
export const MIN_TOKEN_LENGTH = 32;

export function isTokenConfigured(token = process.env.MCP_BEARER_TOKEN): token is string {
  return typeof token === "string" && token.length >= MIN_TOKEN_LENGTH;
}

export function verifyBearer(req: IncomingMessage, expected = process.env.MCP_BEARER_TOKEN): boolean {
  if (!isTokenConfigured(expected)) return false;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const target = Buffer.from(expected);
  return provided.length === target.length && timingSafeEqual(provided, target);
}
