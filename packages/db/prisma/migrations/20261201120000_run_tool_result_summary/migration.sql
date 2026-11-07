-- Additive: old API/worker versions omit this optional display-only value.
-- Never backfill unknown historical tool results from free-form messages or parameters.
ALTER TABLE run_tool_calls ADD COLUMN "resultSummary" JSONB;
ALTER TABLE run_tool_calls ADD CONSTRAINT "run_tool_calls_result_summary_size"
  CHECK ("resultSummary" IS NULL OR octet_length("resultSummary"::text) <= 8192);
