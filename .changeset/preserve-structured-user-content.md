---
'@posthog/pi': patch
---

Preserve structured user message content blocks when capturing pi context for LLM analytics events.

When user content is already an array (for example `[{ type: 'text', text: '...' }]`), keep it structured instead of stringifying it. This improves downstream trace rendering in PostHog.
