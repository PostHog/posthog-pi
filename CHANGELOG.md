# @posthog/pi

## 0.5.0

### Minor Changes

- 48edc67: Show tool calls and the system prompt in generations, and fix the timing and parenting of generations and tool spans.

    - `$ai_input` starts with the system prompt, assistant messages keep their tool calls as OpenAI-style `tool_calls`, and tool results carry `tool_call_id` and `name`.
    - `$ai_output_choices` includes the response's tool calls, so a generation that only called tools no longer has an empty output.
    - `$ai_generation` is sent on `message_end`, when the model's response ends, instead of on `turn_end`, after the tools ran. `$ai_latency` now covers the model call only, so generations no longer overlap their tool spans in the trace timeline.
    - Each `$ai_span` is a child of the generation that made the tool call. Before, it was a child of the previous turn's generation, or had no parent in the first turn. A tool call made by another tool is a child of that tool's span.
    - Each `$ai_span` sets `$ai_span_type: 'tool'`, as PostHog's Claude Agent SDK and OpenAI Agents integrations do.
    - A failed tool's `$ai_error` is the text of its result instead of the result's JSON, so PostHog groups tool errors by their message.

## 0.4.0

### Minor Changes

- afa598f: Send cache token counts as the documented `$ai_cache_read_input_tokens` and `$ai_cache_creation_input_tokens` (previously `cache_read_input_tokens` and `cache_creation_input_tokens`), and set `$ai_cache_reporting_exclusive: true` because pi already reports `$ai_input_tokens` without cached tokens. PostHog now prices cached tokens correctly. Insights that filter on the old property names need updating.

## 0.3.1

### Patch Changes

- 51f1feb: Declare TypeBox as a host-provided peer dependency to avoid duplicate runtime modules and Pi's extension dependency warning.

## 0.3.0

### Minor Changes

- a953ec1: Migrate Pi dependencies to the `@earendil-works` packages with a minimum supported version of 0.80.1.

## 0.2.0

### Minor Changes

- 5f49e9f: Add PostHog MCP bridge for pi that connects to the PostHog MCP server and dynamically registers MCP tools inside pi. Includes spill-to-file for large results, tool allowlist filtering, and configurable auth/endpoint settings.
- a53c872: Add support for loading PostHog settings from `~/.pi/agent/posthog.json`.

    This makes it easier to persist MCP and analytics configuration without relying only on environment variables, and improves local setup ergonomics for the pi extension.

### Patch Changes

- d70f723: Preserve structured user message content blocks when capturing pi context for LLM analytics events.

    When user content is already an array (for example `[{ type: 'text', text: '...' }]`), keep it structured instead of stringifying it. This improves downstream trace rendering in PostHog.

## 0.1.1

### Patch Changes

- aceee6d: Testing the new release process

## 0.1.0

### Minor Changes

- Initial release
