# Foundation 08: standard read-only integration

The synthetic load example uses the existing MCP connector, encrypted credentials and per-Bot grants. Its query cannot select another workspace or supply identity or credentials. Results carry a synthetic source, version, date and candidate-only marker; they do not become trading evidence automatically. See the [integration guide](../integration/eTraderBot-readonly-tool-example.md).

Tool status and bounded, allowlisted summaries are persisted with the actual call. The UI distinguishes calls from distinct tools, handles missing traces, and does not infer success from chat steps or a completed Run. The additive migration adds a nullable JSONB summary with a size bound; existing records remain unchanged.

Unicode connection names derive stable identifiers, existing identifiers survive renaming, and actual identifier conflicts are reported at creation and workspace-availability changes.

## Historical acceptance

Independent browser and real-model acceptance covered synthetic MCP success, source failure and recovery, workspace switching, and membership removal. Follow-up browser checks covered recorded call states and identifier conflicts in Chinese and English narrow layouts. Implementation tests separately cover timeout, malformed results and actual cached-tool refusal after grant revocation.

A real model actually invoking a cached tool after revocation and receiving refused remains unverified. Tool invisibility and cross-workspace RPC rejection do not establish that result. Browser timeout and malformed-source scenarios, Graphile multi-process behavior, Electron, native mobile, real-market operation and full CI remain outside this evidence. Raw logs, screenshots and database snapshots are retained locally.
