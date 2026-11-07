# Foundation 09: continuous-team acceptance and fixes

The business tool now maps each operation to the service's strict input shape. Invalid commands are rejected before service calls; unknown failures after service entry retain uncertain-result semantics. Supervisor assignment keeps its original request identity and role checks.

After successfully obtaining a newer lease fence, the executor marks older running attempts interrupted and records when invalidation was confirmed. It preserves waiting and terminal attempts, tool-call history, current fences and existing result evidence. This is not a backfill of all historical completed runs.

## Historical acceptance

Independent real-model and browser checks covered supervisor-created work, professional results, human waiting and continuation, replacement specialists, imported Skill editing and later reading, and the synthetic read-only integration. Follow-up checks confirmed supervisor dispatch and recovery after a real application process interruption and natural lease expiry.

A separate deterministic OS-process test kills the executor after business persistence but before effect recording, waits for the original lease to expire, answers the recovered human wait through HTTP, and compares request keys, effect keys, full evidence and comment rows. This establishes bounded replay behavior, not semantic deduplication when a model chooses a different request key. The real-model interruption was not claimed to hit that exact write boundary.

The real-model cached-tool refusal gap from [08](eTraderBot-foundation-08-readonly-tool-example.md) remains. Historical authorization and executor-turn-checkpoint baseline failures are not claimed resolved. Wakeup evidence uses the memory driver; Graphile multi-process, native surfaces, real markets and full CI remain unverified. Raw private acceptance records remain local; upload-time checks are reported separately.
