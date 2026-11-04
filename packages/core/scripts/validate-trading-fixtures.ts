import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { TradingSnapshotSchema } from "@rakazo/contracts";
import { runTradingBaseline, TradingError } from "../src/trading/algorithms.js";

// Historical fixtures are checked at the first instant both data and rules were observed.
// This is an offline contract check, not permission to submit historical decisions.
const directory = process.argv[2] ?? "docs/integration/fixtures/snapshots";
const files = globSync(`${directory}/{retailer,generator,storage}/*.json`)
  .filter((file) => !file.endsWith(".query.json") && !file.endsWith(".provenance.json"))
  .sort();
if (!files.length) throw new Error("No snapshot fixtures found");

const results = files.map((file) => {
  try {
    const snapshot = TradingSnapshotSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    const replayTime = new Date(
      Math.max(
        Date.parse(snapshot.source.observedAt),
        Date.parse(snapshot.rules.source.observedAt),
      ),
    );
    const decision = runTradingBaseline(snapshot, "fixture-check-v1", { margin: "0" }, replayTime);
    return { file: path.relative(directory, file), ok: true, lines: decision.lines.length };
  } catch (error) {
    return {
      file: path.relative(directory, file),
      ok: false,
      code: error instanceof TradingError ? error.code : "INVALID_INPUT",
      message: error instanceof Error ? error.message : "Invalid snapshot",
    };
  }
});
const passed = results.filter((result) => result.ok).length;
console.log(
  JSON.stringify({ total: files.length, passed, failed: files.length - passed, results }, null, 2),
);
if (passed !== files.length) process.exitCode = 1;
