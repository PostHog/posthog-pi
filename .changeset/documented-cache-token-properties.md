---
'@posthog/pi': minor
---

Send cache token counts as the documented `$ai_cache_read_input_tokens` and `$ai_cache_creation_input_tokens` (previously `cache_read_input_tokens` and `cache_creation_input_tokens`), and set `$ai_cache_reporting_exclusive: true` because pi already reports `$ai_input_tokens` without cached tokens. PostHog now prices cached tokens correctly. Insights that filter on the old property names need updating.
