export function deriveMcpSlug(name: string): string {
  const normalized = name.trim().normalize("NFC").toLowerCase();
  const base = normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^[_-]+|-+$/g, "");
  // Preserve the established ASCII naming rule. Stored slugs are never re-derived on update.
  if (!/\P{ASCII}/u.test(normalized)) return base.slice(0, 64) || `mcp-${Date.now()}`;

  // FNV-1a over the full Unicode name: identical in browsers and workers, even when the
  // readable prefix drops characters or is truncated. Database uniqueness remains authoritative.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(normalized)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  const prefix = (base || "mcp").slice(0, 47).replace(/-+$/g, "");
  return `${prefix}-${hash.toString(16).padStart(16, "0")}`;
}
