---
'@posthog/pi': patch
---

Fit `$ai_generation` events to the PostHog AI event size limit.

PostHog rejects AI events above `983040` bytes with HTTP 413, which fails the entire flush batch and silently drops unrelated queued events with it. Generation properties follow the conversation, so one large tool result, model response, or user prompt can push a single event over that limit on its own.

`buildAiGeneration` now measures the serialized event and clips conversation content (`$ai_input`, `$ai_output_choices`, `$ai_user_prompt`) until it fits. Message structure, roles, and order survive; each clipped string is marked with `...[truncated N chars]`. The cap is searched against the real serialized size rather than computed in closed form, so the event keeps as much content as the budget allows — a computed cap wastes roughly half of it, because each clipped string also carries a fixed truncation marker. Content that clipping cannot fit, such as tens of thousands of tiny strings, is replaced with a placeholder so the event still lands.

Set `POSTHOG_MAX_EVENT_BYTES` (default `900000`) to lower the budget. Values above the PostHog limit are clamped. Events that already fit are captured unchanged.
