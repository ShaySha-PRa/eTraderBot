import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  startReadonlySourceExample,
  startSyntheticLoadSource,
} from "../examples/readonly-source.js";

// Local, explicit configuration only. Does not load .env, start Rakazo or touch a database.
const { values } = parseArgs({
  options: { config: { type: "string" }, component: { type: "string", default: "both" } },
});
const stops: Array<() => Promise<void>> = [];
try {
  if (!values.config) throw new Error("Configuration file is required");
  const component = z.enum(["both", "source", "mcp"]).parse(values.component);
  const config = z
    .strictObject({
      workspaceId: z.string().min(1).max(128),
      credential: z.string().startsWith("synthetic-").min(16),
      port: z.number().int().min(1024).max(65535).default(8098),
      sourcePort: z.number().int().min(1024).max(65535).default(8099),
      sourceUrl: z.string().url().optional(),
      timeoutMs: z.number().int().min(10).max(30_000).default(2000),
    })
    .parse(JSON.parse(await readFile(values.config, "utf8")));
  let sourceUrl = config.sourceUrl ?? `http://127.0.0.1:${config.sourcePort}/forecast`;
  if (component !== "mcp") {
    const source = await startSyntheticLoadSource({ ...config, port: config.sourcePort });
    stops.push(source.close);
    sourceUrl = source.url;
    process.stdout.write(`Synthetic read-only source: ${source.url}\n`);
  }
  if (component !== "source") {
    const bridge = await startReadonlySourceExample({ ...config, sourceUrl });
    stops.push(bridge.close);
    process.stdout.write(`Synthetic read-only MCP: ${bridge.endpoint}\n`);
  }
  const stop = async () => {
    for (const close of stops.splice(0).reverse()) await close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void stop();
    });
} catch {
  for (const close of stops.reverse()) await close().catch(() => undefined);
  // Never print the parsed config or validation input: it contains a credential.
  process.stderr.write(
    "Could not start synthetic example. Check --config, --component and unused ports.\n",
  );
  process.exitCode = 1;
}
