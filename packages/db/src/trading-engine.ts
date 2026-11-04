import { createHash } from "node:crypto";
import { tradingSnapshotJsonSchema } from "@rakazo/contracts";
import {
  runTradingBaseline,
  TradingError,
  tradingAbs,
  tradingAssert,
  tradingCeil,
  tradingDecimal,
  tradingDecimalString,
  tradingFloorStep,
  tradingGrossNotional,
  tradingMax,
  tradingMin,
  tradingScale,
  validateTradingSnapshot,
} from "@rakazo/core";

/** Archive our engine and schema as audit evidence; never evaluate archived code in the API.
 * Only the currently loaded engine can execute. A different build requires a new approval. */
export const tradingEngineArtifact = JSON.stringify({
  revision: 1,
  node: process.versions.node,
  schema: tradingSnapshotJsonSchema(),
  algorithm: runTradingBaseline.toString(),
  validation: validateTradingSnapshot.toString(),
  assertion: tradingAssert.toString(),
  error: TradingError.toString(),
  arithmetic: Object.fromEntries(
    Object.entries({
      tradingAbs,
      tradingCeil,
      tradingDecimal,
      tradingDecimalString,
      tradingFloorStep,
      tradingGrossNotional,
      tradingMax,
      tradingMin,
      tradingScale,
    }).map(([name, value]) => [name, value.toString()]),
  ),
});
export const tradingDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export const tradingEngineHash = tradingDigest(tradingEngineArtifact);

export function tradingAlgorithmIdentity(kind: string, parameters: { margin: string }) {
  return `baseline-${tradingDigest(JSON.stringify({ baseline: kind, engine: tradingEngineHash, parameters }))}`;
}

/** Object key order is not part of the meaning of a signed trade intent. */
export function tradingCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tradingCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${tradingCanonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
