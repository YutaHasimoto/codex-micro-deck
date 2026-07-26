/**
 * Produce an actionable plugin log message without leaking task text, thread
 * identifiers, home-directory paths, or multi-line process output.
 */
export function safeActionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = raw
    .replace(/codex:\/\/threads\/[0-9a-f%-]+/gi, "codex://threads/<redacted>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{20,}\b/gi, "<thread-id>")
    .replace(/\/Users\/[^\s"']+/g, "<user-path>")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return (sanitized || "Unknown action failure").slice(0, 180);
}
