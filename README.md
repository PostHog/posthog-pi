# @posthog/pi

PostHog extension package for [pi](https://github.com/badlogic/pi-mono) coding agent.

It currently provides two capabilities:

1. **LLM Analytics for pi** — captures generations, tool executions, and traces as structured `$ai_*` events in PostHog.
2. **PostHog MCP bridge for pi** — connects pi to the PostHog MCP server and dynamically exposes PostHog MCP tools inside pi.

## Install

```bash
pi install npm:@posthog/pi
```

Or for project-local install:

```bash
pi install -l npm:@posthog/pi
```

## Quick start

### Use PostHog MCP inside pi

Set a PostHog personal API key and start pi:

```bash
export POSTHOG_PERSONAL_API_KEY="phx_your_personal_api_key"
pi
```

You can also pass the full auth header instead:

```bash
export POSTHOG_AUTH_HEADER="Bearer phx_your_personal_api_key"
pi
```

By default, the extension connects to:

- `https://mcp.posthog.com/mcp`
- MCP version header: `x-posthog-mcp-version: 2`

When connected, PostHog MCP tools are registered dynamically in pi and are callable like any other pi tool.

Useful commands:

- `/posthog-mcp-status` — show connection and config status
- `/posthog-mcp-reload` — reconnect and refresh MCP tools

### Send pi traces to PostHog LLM Analytics

Set your project API key:

```bash
export POSTHOG_API_KEY="phc_your_project_key"
pi
```

## Configuration

### MCP bridge

| Variable                       | Default                       | Description                                                      |
| ------------------------------ | ----------------------------- | ---------------------------------------------------------------- |
| `POSTHOG_MCP_ENABLED`          | `true`                        | Set to `false` to disable the MCP bridge                         |
| `POSTHOG_PERSONAL_API_KEY`     | _(none)_                      | Personal API key used for PostHog MCP auth                       |
| `POSTHOG_AUTH_HEADER`          | _(none)_                      | Full Authorization header, e.g. `Bearer phx_...`                 |
| `POSTHOG_MCP_URL`              | `https://mcp.posthog.com/mcp` | PostHog MCP endpoint                                             |
| `POSTHOG_MCP_VERSION`          | `2`                           | Value sent as `x-posthog-mcp-version`                            |
| `POSTHOG_MCP_FEATURES`         | _(all tools)_                 | Optional comma-separated PostHog MCP feature filter              |
| `POSTHOG_MCP_TOOLS`            | _(none)_                      | Optional comma-separated tool allowlist                          |
| `POSTHOG_MCP_SPILL_TO_FILE`    | `true`                        | Save large MCP responses to a temp file instead of inlining them |
| `POSTHOG_MCP_MAX_INLINE_CHARS` | `12000`                       | Max serialized response size before spilling to a file           |
| `POSTHOG_MCP_TEMP_DIR`         | `/tmp/posthog-mcp`            | Directory for large saved MCP responses                          |

Examples:

```bash
# expose all default PostHog MCP v2 tools
export POSTHOG_PERSONAL_API_KEY="phx_..."

# narrow the tool surface
export POSTHOG_MCP_FEATURES="sql,llm_analytics,error_tracking,flags,experiments"

# or allowlist exact tools
export POSTHOG_MCP_TOOLS="execute-sql,dashboard-get,feature-flag-get-all"

# keep large results out of context
export POSTHOG_MCP_SPILL_TO_FILE="true"
export POSTHOG_MCP_MAX_INLINE_CHARS="12000"
```

### LLM analytics / tracing

| Variable                         | Default                                                                       | Description                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POSTHOG_API_KEY`                | _(required for tracing)_                                                      | Your PostHog project API key                                                                                                                           |
| `POSTHOG_HOST`                   | `https://us.i.posthog.com`                                                    | PostHog instance URL                                                                                                                                   |
| `POSTHOG_PRIVACY_MODE`           | `false`                                                                       | When `true`, LLM input/output content is not sent to PostHog                                                                                           |
| `POSTHOG_ENABLED`                | `true`                                                                        | Set to `false` to disable analytics capture                                                                                                            |
| `POSTHOG_TRACE_GROUPING`         | `message`                                                                     | `message`: one trace per user prompt. `session`: group all generations in a session into one trace                                                     |
| `POSTHOG_SESSION_WINDOW_MINUTES` | `60`                                                                          | Minutes of inactivity before starting a new session window                                                                                             |
| `POSTHOG_PROJECT_NAME`           | cwd basename                                                                  | Project name included in all events                                                                                                                    |
| `POSTHOG_AGENT_NAME`             | project name                                                                  | Agent name (auto-detects subagent names from pi-subagents)                                                                                             |
| `POSTHOG_DISTINCT_ID`            | auto-discovered from PostHog personal API key (fallback: session id `pi:...`) | Override `distinct_id` used for all `$ai_*` events (for example `user@example.com`). When set, the extension also calls `identify()` on session start. |
| `POSTHOG_TAGS`                   | _(none)_                                                                      | Custom tags added to all events (format: `key1:val1,key2:val2`)                                                                                        |
| `POSTHOG_MAX_ATTRIBUTE_LENGTH`   | `12000`                                                                       | Max length for serialized tool input/output attributes                                                                                                 |

If `POSTHOG_DISTINCT_ID` is set, `@posthog/pi` calls `identify()` once on session start for that distinct ID. If the value looks like an email address, it is also sent as the `email` person property.

If `POSTHOG_DISTINCT_ID` is not set, `@posthog/pi` will try to discover your identity from `POSTHOG_PERSONAL_API_KEY` (or `personalApiKey` in `~/.pi/agent/posthog.json`) and use that as `distinct_id`. If discovery fails, it falls back to session IDs (`pi:...`).

## What gets captured

### `$ai_generation`

Captured on every LLM call (one per turn).

| Property                      | Description                                                       |
| ----------------------------- | ----------------------------------------------------------------- |
| `$ai_model`                   | Model name (e.g. `claude-sonnet-4-20250514`)                      |
| `$ai_provider`                | Provider name (e.g. `anthropic`, `openai`)                        |
| `$ai_latency`                 | LLM response duration in seconds (actual LLM time when available) |
| `$ai_input_tokens`            | Input token count                                                 |
| `$ai_output_tokens`           | Output token count                                                |
| `$ai_total_tokens`            | Total token count                                                 |
| `$ai_total_cost_usd`          | Total cost in USD                                                 |
| `$ai_input_cost_usd`          | Input cost in USD                                                 |
| `$ai_output_cost_usd`         | Output cost in USD                                                |
| `$ai_stop_reason`             | Why generation stopped (`stop`, `length`, `tool_calls`, `error`)  |
| `$ai_is_error`                | Whether the generation errored                                    |
| `$ai_error`                   | Error message (if any)                                            |
| `$ai_input`                   | Input messages (redacted in privacy mode)                         |
| `$ai_output_choices`          | Output choices (redacted in privacy mode)                         |
| `$ai_user_prompt`             | Raw user prompt text (redacted in privacy mode)                   |
| `$ai_trace_id`                | Trace ID for hierarchical grouping                                |
| `$ai_span_id`                 | Span ID for this generation                                       |
| `$ai_session_id`              | Session identifier                                                |
| `$ai_project_name`            | Project name                                                      |
| `$ai_agent_name`              | Agent name (includes subagent name if applicable)                 |
| `cache_read_input_tokens`     | Cache read token count                                            |
| `cache_creation_input_tokens` | Cache creation token count                                        |

### `$ai_span`

Captured for each tool execution (read, write, edit, bash, etc.).

| Property           | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| `$ai_span_name`    | Tool name                                                           |
| `$ai_latency`      | Tool execution duration in seconds                                  |
| `$ai_is_error`     | Whether the tool call errored                                       |
| `$ai_error`        | Error message (if any)                                              |
| `$ai_input_state`  | Tool input parameters (sensitive keys redacted, privacy mode aware) |
| `$ai_output_state` | Tool output result (sensitive keys redacted, privacy mode aware)    |
| `$ai_trace_id`     | Trace ID                                                            |
| `$ai_span_id`      | Span ID for this tool call                                          |
| `$ai_parent_id`    | Parent generation span ID                                           |
| `$ai_project_name` | Project name                                                        |
| `$ai_agent_name`   | Agent name                                                          |

### `$ai_trace`

Captured when an agent run completes (one per user prompt).

| Property                  | Description                                |
| ------------------------- | ------------------------------------------ |
| `$ai_trace_id`            | Trace ID                                   |
| `$ai_session_id`          | Session identifier                         |
| `$ai_latency`             | Total agent run duration in seconds        |
| `$ai_total_input_tokens`  | Accumulated input tokens across all turns  |
| `$ai_total_output_tokens` | Accumulated output tokens across all turns |
| `$ai_is_error`            | Whether the agent run ended in error       |
| `$ai_error`               | Error message (if any)                     |
| `$ai_project_name`        | Project name                               |
| `$ai_agent_name`          | Agent name                                 |

## Trace Grouping

- **`message` (default)**: Each user prompt creates a new trace. Multiple LLM turns within one prompt (e.g., tool use loops) are grouped under the same trace.
- **`session`**: All generations within a session window are grouped under one trace. A new trace starts after `sessionWindowMinutes` of inactivity.

## Privacy Mode

When `POSTHOG_PRIVACY_MODE=true`, all LLM input/output content, user prompts, tool inputs, and tool outputs are redacted (sent as `null`). Token counts, costs, latency, and model metadata are still captured.

Even when privacy mode is off, sensitive keys in tool inputs/outputs (e.g. `api_key`, `token`, `secret`, `password`, `authorization`) are automatically redacted.

## Subagent Detection

When used with [pi-subagents](https://github.com/badlogic/pi-mono), the extension automatically detects subagent names from `--append-system-prompt` CLI args and includes them in `$ai_agent_name` as `projectName/subagentName`.

## Requirements

- Node.js >= 22

## Development

### Local development with pi

Run the extension directly from source:

```bash
cd /path/to/posthog-pi
pnpm install

# Use a PostHog personal API key for MCP
export POSTHOG_PERSONAL_API_KEY="phx_..."

# Start pi with the local extension source
pi -e ./src/index.ts
```

Useful commands inside pi:

```text
/posthog-mcp-status
/posthog-mcp-reload
```

If you prefer to install the package into pi locally instead of using `-e`:

```bash
cd /path/to/posthog-pi
pi install -l .

# then launch pi normally
pi
```

If large MCP results are causing compaction or context pressure during development,
keep spill-to-file enabled (the default) or set it explicitly:

```bash
export POSTHOG_MCP_SPILL_TO_FILE="true"
export POSTHOG_MCP_MAX_INLINE_CHARS="12000"
export POSTHOG_MCP_TEMP_DIR="/tmp/posthog-mcp"
```

### Development commands

```bash
# Install dependencies
pnpm install

# Test with pi (without installing)
pi -e ./src/index.ts

# Type check
pnpm typecheck

# Lint (oxfmt)
pnpm lint

# Format
pnpm lint:fix

# Run tests (vitest)
pnpm test
```

## License

MIT
