---
'@posthog/pi': minor
---

Show tool calls and the system prompt in generations, and fix the timing and parenting of generations and tool spans.

- `$ai_input` starts with the system prompt, assistant messages keep their tool calls as OpenAI-style `tool_calls`, and tool results carry `tool_call_id` and `name`.
- `$ai_output_choices` includes the response's tool calls, so a generation that only called tools no longer has an empty output.
- `$ai_generation` is sent on `message_end`, when the model's response ends, instead of on `turn_end`, after the tools ran. `$ai_latency` now covers the model call only, so generations no longer overlap their tool spans in the trace timeline.
- Each `$ai_span` is a child of the generation that made the tool call. Before, it was a child of the previous turn's generation, or had no parent in the first turn. A tool call made by another tool is a child of that tool's span.
- A failed tool's `$ai_error` is the text of its result instead of the result's JSON, so PostHog groups tool errors by their message.
