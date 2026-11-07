// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import {
  clearBusinessResultDrafts,
  readBusinessResultDrafts,
  writeBusinessResultDrafts,
} from "./business-result-draft";

const draft = { summary: "Kept", disagreements: "", unresolved: "", proposal: "" };
const basis = { resultEvidenceId: "result-1", evidenceIds: ["e-1"] };

beforeEach(() => localStorage.clear());

it("keeps drafts per business with the version they started from", () => {
  writeBusinessResultDrafts("space-a", { drafts: { k: draft }, bases: { k: basis } });
  expect(readBusinessResultDrafts("space-a")).toEqual({
    drafts: { k: draft },
    bases: { k: basis },
  });
  expect(readBusinessResultDrafts("space-b")).toEqual({ drafts: {}, bases: {} });
  expect(readBusinessResultDrafts(null)).toEqual({ drafts: {}, bases: {} });
});

it("drops empty drafts and drafts without a starting version", () => {
  writeBusinessResultDrafts("space-a", {
    drafts: { empty: { ...draft, summary: "" }, orphan: draft },
    bases: { empty: basis },
  });
  expect(localStorage.getItem("rakazo.businessResultDrafts.space-a")).toBeNull();
  localStorage.setItem(
    "rakazo.businessResultDrafts.space-a",
    JSON.stringify({ drafts: { k: draft, bad: { summary: 1 } }, bases: { bad: basis } }),
  );
  expect(readBusinessResultDrafts("space-a")).toEqual({ drafts: {}, bases: {} });
  localStorage.setItem("rakazo.businessResultDrafts.space-a", "{not json");
  expect(readBusinessResultDrafts("space-a")).toEqual({ drafts: {}, bases: {} });
});

it("clears every business's drafts on sign-out and leaves other storage alone", () => {
  writeBusinessResultDrafts("space-a", { drafts: { k: draft }, bases: { k: basis } });
  writeBusinessResultDrafts("space-b", { drafts: { k: draft }, bases: { k: basis } });
  localStorage.setItem("rakazo:space-id", "space-a");
  clearBusinessResultDrafts();
  expect(readBusinessResultDrafts("space-a").drafts).toEqual({});
  expect(readBusinessResultDrafts("space-b").drafts).toEqual({});
  expect(localStorage.getItem("rakazo:space-id")).toBe("space-a");
});
