# posthog-pi

PostHog LLM Analytics extension for [pi](https://github.com/badlogic/pi-mono) coding agent. Captures LLM generations, tool executions, and conversation traces, sending them to PostHog as structured `$ai_*` events for the [LLM Analytics dashboard](https://posthog.com/docs/ai-engineering/observability).

## Install

```bash
pi install git:github.com/PostHog/posthog-pi
```

Or for project-local install:

```bash
pi install -l git:github.com/PostHog/posthog-pi
```

## Configuration

Set environment variables:

| Variable                         | Default                    | Description                                                                                        |
| -------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `POSTHOG_API_KEY`                | _(required)_               | Your PostHog project API key                                                                       |
| `POSTHOG_HOST`                   | `https://us.i.posthog.com` | PostHog instance URL                                                                               |
| `POSTHOG_PRIVACY_MODE`           | `false`                    | When `true`, LLM input/output content is not sent to PostHog                                       |
| `POSTHOG_ENABLED`                | `true`                     | Set to `false` to disable the extension                                                            |
| `POSTHOG_TRACE_GROUPING`         | `message`                  | `message`: one trace per user prompt. `session`: group all generations in a session into one trace |
| `POSTHOG_SESSION_WINDOW_MINUTES` | `60`                       | Minutes of inactivity before starting a new session window                                         |
| `POSTHOG_PROJECT_NAME`           | cwd basename               | Project name included in all events                                                                |
| `POSTHOG_AGENT_NAME`             | project name               | Agent name (auto-detects subagent names from pi-subagents)                                         |
| `POSTHOG_TAGS`                   | _(none)_                   | Custom tags added to all events (format: `key1:val1,key2:val2`)                                    |
| `POSTHOG_MAX_ATTRIBUTE_LENGTH`   | `12000`                    | Max length for serialized tool input/output attributes                                             |

Example:

```bash
export POSTHOG_API_KEY="phc_your_project_key"
export POSTHOG_TAGS="team:platform,env:production"
pi
```

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
