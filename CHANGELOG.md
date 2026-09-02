# @posthog/pi

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
