import { t } from "@lingui/core/macro";
import { errorCode } from "./user-error";

/**
 * The server's two refusals for an MCP connection identifier already in use: the database's
 * uniqueness check and the availability check across spaces. Other conflicts keep their own text.
 */
const IDENTIFIER_CONFLICTS = new Set([
  "An MCP server with that identifier already exists.",
  "An MCP server with that identifier already exists in one of these spaces.",
]);

/** Copy for an identifier conflict in the interface language, or null for any other failure. */
export function mcpIdentifierConflictText(cause: unknown): string | null {
  if (errorCode(cause) !== "CONFLICT") return null;
  const message =
    cause && typeof cause === "object" && "message" in cause
      ? (cause as { message: unknown }).message
      : null;
  if (typeof message !== "string" || !IDENTIFIER_CONFLICTS.has(message.trim())) return null;
  return t`A connection already uses this identifier. Choose another name or use the existing connection.`;
}
