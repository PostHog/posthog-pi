# @posthog/pi

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
