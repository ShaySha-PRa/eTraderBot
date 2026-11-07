/**
 * Unsent business-cycle results, kept per business on this device so a reload (including the
 * one after losing access to a business) does not discard what was typed. Restoring a draft
 * only fills the form; sending it always takes the person's own click.
 */
export const BUSINESS_RESULT_DRAFT_PREFIX = "rakazo.businessResultDrafts.";

export type BusinessResultDraft = {
  summary: string;
  disagreements: string;
  unresolved: string;
  proposal: string;
};
/** The evidence and result version a draft was started from, so a late send is still checked. */
export type BusinessResultBasis = { resultEvidenceId: string | null; evidenceIds: string[] };
export type StoredBusinessResultDrafts = {
  drafts: Record<string, BusinessResultDraft>;
  bases: Record<string, BusinessResultBasis>;
};

const empty: StoredBusinessResultDrafts = { drafts: {}, bases: {} };

function storageKey(spaceId: string) {
  return `${BUSINESS_RESULT_DRAFT_PREFIX}${spaceId}`;
}

function isDraft(value: unknown): value is BusinessResultDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return ["summary", "disagreements", "unresolved", "proposal"].every(
    (field) => typeof draft[field] === "string",
  );
}

function isBasis(value: unknown): value is BusinessResultBasis {
  if (!value || typeof value !== "object") return false;
  const basis = value as Record<string, unknown>;
  return (
    (basis.resultEvidenceId === null || typeof basis.resultEvidenceId === "string") &&
    Array.isArray(basis.evidenceIds) &&
    basis.evidenceIds.every((id) => typeof id === "string")
  );
}

/** Drafts saved for this business; anything unreadable is dropped rather than half-restored. */
export function readBusinessResultDrafts(spaceId: string | null): StoredBusinessResultDrafts {
  if (!spaceId) return empty;
  try {
    const raw = localStorage.getItem(storageKey(spaceId));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as { drafts?: unknown; bases?: unknown };
    const drafts: Record<string, BusinessResultDraft> = {};
    const bases: Record<string, BusinessResultBasis> = {};
    for (const [key, draft] of Object.entries(parsed.drafts ?? {})) {
      const basis = (parsed.bases as Record<string, unknown> | undefined)?.[key];
      // A draft without its starting version could overwrite a newer result, so both must load.
      if (isDraft(draft) && isBasis(basis)) {
        drafts[key] = draft;
        bases[key] = basis;
      }
    }
    return { drafts, bases };
  } catch {
    return empty;
  }
}

export function writeBusinessResultDrafts(
  spaceId: string | null,
  { drafts, bases }: StoredBusinessResultDrafts,
): void {
  if (!spaceId) return;
  try {
    const kept = Object.entries(drafts).filter(
      ([key, draft]) => bases[key] && Object.values(draft).some(Boolean),
    );
    if (kept.length === 0) {
      localStorage.removeItem(storageKey(spaceId));
      return;
    }
    localStorage.setItem(
      storageKey(spaceId),
      JSON.stringify({
        drafts: Object.fromEntries(kept),
        bases: Object.fromEntries(kept.map(([key]) => [key, bases[key]])),
      }),
    );
  } catch {
    // Without storage the draft lives only in memory, as before.
  }
}

/** Signing out leaves no unsent business result for whoever uses this browser next. */
export function clearBusinessResultDrafts(): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    for (const key of keys)
      if (key?.startsWith(BUSINESS_RESULT_DRAFT_PREFIX)) localStorage.removeItem(key);
  } catch {
    // Without storage no draft was saved.
  }
}
