import { describe, it, expect } from 'vitest'
import { buildAiGeneration, buildAiSpan, buildAiTrace, mapStopReason } from './events.js'
import type { TurnState, LastAssistantInfo, PostHogPiConfig } from './types.js'

const defaultConfig: PostHogPiConfig = {
    apiKey: 'test-key',
    host: 'https://us.i.posthog.com',
    privacyMode: false,
    enabled: true,
    traceGrouping: 'message',
    sessionWindowMinutes: 60,
    tags: {},
    maxAttributeLength: 12000,
    maxEventBytes: 900000,
}

const privacyConfig: PostHogPiConfig = {
    ...defaultConfig,
    privacyMode: true,
}

const configWithTags: PostHogPiConfig = {
    ...defaultConfig,
    tags: { team: 'platform', env: 'staging' },
}

const configWithDistinctId: PostHogPiConfig = {
    ...defaultConfig,
    distinctId: 'user@example.com',
}

describe('mapStopReason', () => {
    it('maps known stop reasons', () => {
        expect(mapStopReason('stop')).toBe('stop')
        expect(mapStopReason('length')).toBe('length')
        expect(mapStopReason('toolUse')).toBe('tool_calls')
        expect(mapStopReason('error')).toBe('error')
        expect(mapStopReason('aborted')).toBe('stop')
    })

    it('returns null for undefined', () => {
        expect(mapStopReason(undefined)).toBeNull()
    })

    it('passes through unknown reasons', () => {
        expect(mapStopReason('custom_reason')).toBe('custom_reason')
    })
})

describe('buildAiGeneration', () => {
    const turnState: TurnState = {
        traceId: 'trace-123',
        spanId: 'span-456',
        startTime: Date.now() - 1000,
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        input: [{ role: 'user', content: 'Hello' }],
        sessionId: 'session-789',
        userPrompt: 'Hello',
    }

    it('builds generation event with all fields', () => {
        const assistantInfo: LastAssistantInfo = {
            model: 'claude-sonnet-4-20250514',
            provider: 'anthropic',
            stopReason: 'stop',
            outputText: 'Hi there!',
            usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165 },
            cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
        }

        const result = buildAiGeneration(turnState, assistantInfo, defaultConfig, 'my-project', 'my-project')

        expect(result.event).toBe('$ai_generation')
        expect(result.distinctId).toBe('session-789')
        expect(result.properties.$ai_model).toBe('claude-sonnet-4-20250514')
        expect(result.properties.$ai_provider).toBe('anthropic')
        expect(result.properties.$ai_input_tokens).toBe(100)
        expect(result.properties.$ai_output_tokens).toBe(50)
        expect(result.properties.$ai_total_tokens).toBe(165)
        expect(result.properties.$ai_total_cost_usd).toBe(0.003)
        expect(result.properties.$ai_stop_reason).toBe('stop')
        expect(result.properties.$ai_is_error).toBe(false)
        expect(result.properties.$ai_trace_id).toBe('trace-123')
        expect(result.properties.$ai_span_id).toBe('span-456')
        expect(result.properties.$ai_lib).toBe('@posthog/pi')
        expect(result.properties.$ai_framework).toBe('pi')
        expect(result.properties.$ai_project_name).toBe('my-project')
        expect(result.properties.$ai_agent_name).toBe('my-project')
        expect(result.properties.cache_read_input_tokens).toBe(10)
        expect(result.properties.cache_creation_input_tokens).toBe(5)
    })

    it('includes output choices from outputText', () => {
        const assistantInfo: LastAssistantInfo = {
            stopReason: 'stop',
            outputText: 'Generated response',
        }
        const result = buildAiGeneration(turnState, assistantInfo, defaultConfig, 'proj', 'agent')
        expect(result.properties.$ai_output_choices).toEqual([{ role: 'assistant', content: 'Generated response' }])
    })

    it('includes user prompt when not in privacy mode', () => {
        const assistantInfo: LastAssistantInfo = { stopReason: 'stop' }
        const result = buildAiGeneration(turnState, assistantInfo, defaultConfig, 'proj', 'agent')
        expect(result.properties.$ai_user_prompt).toBe('Hello')
    })

    it('excludes user prompt in privacy mode', () => {
        const assistantInfo: LastAssistantInfo = { stopReason: 'stop' }
        const result = buildAiGeneration(turnState, assistantInfo, privacyConfig, 'proj', 'agent')
        expect(result.properties.$ai_user_prompt).toBeUndefined()
    })

    it('redacts input in privacy mode', () => {
        const assistantInfo: LastAssistantInfo = { stopReason: 'stop' }
        const result = buildAiGeneration(turnState, assistantInfo, privacyConfig, 'proj', 'agent')
        expect(result.properties.$ai_input).toBeNull()
        expect(result.properties.$ai_output_choices).toBeNull()
    })

    it('marks error generations', () => {
        const assistantInfo: LastAssistantInfo = {
            stopReason: 'error',
            errorMessage: 'Rate limited',
        }

        const result = buildAiGeneration(turnState, assistantInfo, defaultConfig, 'proj', 'agent')

        expect(result.properties.$ai_is_error).toBe(true)
        expect(result.properties.$ai_error).toBe('Rate limited')
        expect(result.properties.$ai_stop_reason).toBe('error')
        expect(result.properties.$ai_output_choices).toEqual([{ role: 'assistant', content: 'Rate limited' }])
    })

    it('uses LLM latency when available', () => {
        const assistantInfo: LastAssistantInfo = {
            stopReason: 'stop',
            llmLatencyMs: 500,
        }
        const result = buildAiGeneration(turnState, assistantInfo, defaultConfig, 'proj', 'agent')
        expect(result.properties.$ai_latency).toBe(0.5)
    })

    it('includes custom tags', () => {
        const assistantInfo: LastAssistantInfo = { stopReason: 'stop' }
        const result = buildAiGeneration(turnState, assistantInfo, configWithTags, 'proj', 'agent')
        expect(result.properties.team).toBe('platform')
        expect(result.properties.env).toBe('staging')
    })

    it('uses configured distinct id when provided', () => {
        const assistantInfo: LastAssistantInfo = { stopReason: 'stop' }
        const result = buildAiGeneration(
            turnState,
            assistantInfo,
            configWithDistinctId,
            'proj',
            'agent',
            'user@example.com'
        )
        expect(result.distinctId).toBe('user@example.com')
    })

    it('falls back to pi-agent when neither configured distinct id nor session id exists', () => {
        const assistantInfo: LastAssistantInfo = { stopReason: 'stop' }
        const noSessionTurn: TurnState = { ...turnState, sessionId: undefined }
        const result = buildAiGeneration(noSessionTurn, assistantInfo, defaultConfig, 'proj', 'agent')
        expect(result.distinctId).toBe('pi-agent')
    })
})

describe('buildAiSpan', () => {
    it('builds span event for tool execution', () => {
        const result = buildAiSpan(
            'trace-123',
            'parent-span-456',
            'bash',
            { command: 'ls -la' },
            { output: 'file1.txt\nfile2.txt' },
            250,
            false,
            null,
            defaultConfig,
            'my-project',
            'my-project',
            'session-789'
        )

        expect(result.event).toBe('$ai_span')
        expect(result.distinctId).toBe('session-789')
        expect(result.properties.$ai_trace_id).toBe('trace-123')
        expect(result.properties.$ai_parent_id).toBe('parent-span-456')
        expect(result.properties.$ai_span_name).toBe('bash')
        expect(result.properties.$ai_latency).toBe(0.25)
        expect(result.properties.$ai_is_error).toBe(false)
        expect(result.properties.$ai_input_state).toBe('{"command":"ls -la"}')
        expect(result.properties.$ai_lib).toBe('@posthog/pi')
        expect(result.properties.$ai_framework).toBe('pi')
        expect(result.properties.$ai_project_name).toBe('my-project')
        expect(result.properties.$ai_agent_name).toBe('my-project')
    })

    it('redacts tool input/output in privacy mode', () => {
        const result = buildAiSpan(
            'trace-123',
            undefined,
            'read',
            { path: '/secret/file.txt' },
            'secret content',
            100,
            false,
            null,
            privacyConfig,
            'proj',
            'agent',
            'session-789'
        )

        expect(result.properties.$ai_input_state).toBeNull()
        expect(result.properties.$ai_output_state).toBeNull()
    })

    it('redacts sensitive keys in tool input', () => {
        const result = buildAiSpan(
            'trace-123',
            undefined,
            'bash',
            { command: 'curl', api_key: 'sk-secret-123', headers: { authorization: 'Bearer tok' } },
            'ok',
            100,
            false,
            null,
            defaultConfig,
            'proj',
            'agent'
        )

        const inputState = result.properties.$ai_input_state as string
        expect(inputState).toContain('[REDACTED]')
        expect(inputState).not.toContain('sk-secret-123')
        expect(inputState).not.toContain('Bearer tok')
        expect(inputState).toContain('curl')
    })

    it('captures error info', () => {
        const result = buildAiSpan(
            'trace-123',
            'parent-span',
            'bash',
            { command: 'bad-cmd' },
            'command not found',
            50,
            true,
            'command not found',
            defaultConfig,
            'proj',
            'agent'
        )

        expect(result.properties.$ai_is_error).toBe(true)
        expect(result.properties.$ai_error).toBe('command not found')
    })

    it('includes custom tags', () => {
        const result = buildAiSpan(
            'trace-123',
            undefined,
            'read',
            {},
            'ok',
            100,
            false,
            null,
            configWithTags,
            'proj',
            'agent'
        )
        expect(result.properties.team).toBe('platform')
        expect(result.properties.env).toBe('staging')
    })

    it('uses configured distinct id when provided', () => {
        const result = buildAiSpan(
            'trace-123',
            undefined,
            'read',
            {},
            'ok',
            100,
            false,
            null,
            configWithDistinctId,
            'proj',
            'agent',
            'session-789',
            'user@example.com'
        )
        expect(result.distinctId).toBe('user@example.com')
    })

    it('falls back to pi-agent when neither configured distinct id nor session id exists', () => {
        const result = buildAiSpan(
            'trace-123',
            undefined,
            'read',
            {},
            'ok',
            100,
            false,
            null,
            defaultConfig,
            'proj',
            'agent'
        )
        expect(result.distinctId).toBe('pi-agent')
    })
})

describe('buildAiTrace', () => {
    it('builds trace event', () => {
        const result = buildAiTrace(
            'trace-123',
            5000,
            { input: 500, output: 200 },
            false,
            null,
            defaultConfig,
            'my-project',
            'my-project',
            'session-789'
        )

        expect(result.event).toBe('$ai_trace')
        expect(result.distinctId).toBe('session-789')
        expect(result.properties.$ai_trace_id).toBe('trace-123')
        expect(result.properties.$ai_latency).toBe(5)
        expect(result.properties.$ai_total_input_tokens).toBe(500)
        expect(result.properties.$ai_total_output_tokens).toBe(200)
        expect(result.properties.$ai_is_error).toBe(false)
        expect(result.properties.$ai_lib).toBe('@posthog/pi')
        expect(result.properties.$ai_framework).toBe('pi')
        expect(result.properties.$ai_project_name).toBe('my-project')
        expect(result.properties.$ai_agent_name).toBe('my-project')
    })

    it('captures error traces', () => {
        const result = buildAiTrace(
            'trace-123',
            1000,
            undefined,
            true,
            'Context overflow',
            defaultConfig,
            'proj',
            'agent',
            'session-789'
        )

        expect(result.properties.$ai_is_error).toBe(true)
        expect(result.properties.$ai_error).toBe('Context overflow')
        expect(result.properties.$ai_total_input_tokens).toBeNull()
        expect(result.properties.$ai_total_output_tokens).toBeNull()
    })

    it('includes custom tags', () => {
        const result = buildAiTrace('trace-123', 1000, undefined, false, null, configWithTags, 'proj', 'agent')
        expect(result.properties.team).toBe('platform')
        expect(result.properties.env).toBe('staging')
    })

    it('uses configured distinct id when provided', () => {
        const result = buildAiTrace(
            'trace-123',
            1000,
            undefined,
            false,
            null,
            configWithDistinctId,
            'proj',
            'agent',
            'session-789',
            'user@example.com'
        )
        expect(result.distinctId).toBe('user@example.com')
    })

    it('falls back to pi-agent when neither configured distinct id nor session id exists', () => {
        const result = buildAiTrace('trace-123', 1000, undefined, false, null, defaultConfig, 'proj', 'agent')
        expect(result.distinctId).toBe('pi-agent')
    })
})

// PostHog rejects AI events above 983_040 bytes with HTTP 413 and drops the
// whole flush batch, so generation events must always fit that limit.
const POSTHOG_AI_EVENT_LIMIT_BYTES = 983_040

const assistantInfo: LastAssistantInfo = { stopReason: 'stop', outputText: 'done' }

function serializedBytes(properties: Record<string, unknown>): number {
    return Buffer.byteLength(JSON.stringify(properties), 'utf8')
}

function generationFor(input: unknown[], userPrompt: string, config: PostHogPiConfig = defaultConfig) {
    const turnState: TurnState = {
        traceId: 'trace-123',
        spanId: 'span-456',
        startTime: Date.now() - 1000,
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        input,
        sessionId: 'session-789',
        userPrompt,
    }
    return buildAiGeneration(turnState, assistantInfo, config, 'proj', 'agent')
}

describe('buildAiGeneration event size limit', () => {
    it('fits a turn whose tool result alone exceeds the PostHog limit', () => {
        const result = generationFor(
            [
                { role: 'user', content: 'read the log' },
                { role: 'tool', content: 'A'.repeat(1_200_000) },
            ],
            'read the log'
        )

        expect(serializedBytes(result.properties)).toBeLessThanOrEqual(POSTHOG_AI_EVENT_LIMIT_BYTES)
        expect(result.properties.$ai_input).toEqual([
            { role: 'user', content: 'read the log' },
            { role: 'tool', content: expect.stringContaining('[truncated ') },
        ])
    })

    it('fits a turn whose output text exceeds the PostHog limit', () => {
        const bigOutput: LastAssistantInfo = { stopReason: 'stop', outputText: 'B'.repeat(1_500_000) }
        const turnState: TurnState = {
            traceId: 'trace-123',
            spanId: 'span-456',
            startTime: Date.now() - 1000,
            model: 'claude-sonnet-4-20250514',
            provider: 'anthropic',
            input: [{ role: 'user', content: 'write the file' }],
            sessionId: 'session-789',
            userPrompt: 'write the file',
        }

        const result = buildAiGeneration(turnState, bigOutput, defaultConfig, 'proj', 'agent')

        expect(serializedBytes(result.properties)).toBeLessThanOrEqual(POSTHOG_AI_EVENT_LIMIT_BYTES)
        expect(result.properties.$ai_output_choices).toEqual([
            { role: 'assistant', content: expect.stringContaining('[truncated ') },
        ])
    })

    it('fits multi-byte content, where characters cost more than one byte', () => {
        const result = generationFor(
            [
                { role: 'user', content: 'describe' },
                { role: 'tool', content: '🦀'.repeat(400_000) },
            ],
            'describe'
        )

        expect(serializedBytes(result.properties)).toBeLessThanOrEqual(POSTHOG_AI_EVENT_LIMIT_BYTES)
    })

    it('fits a turn with many messages', () => {
        const input = Array.from({ length: 400 }, (_, index) => ({
            role: 'tool',
            content: `${index}:${'C'.repeat(4000)}`,
        }))

        const result = generationFor(input, 'summarize')

        expect(serializedBytes(result.properties)).toBeLessThanOrEqual(POSTHOG_AI_EVENT_LIMIT_BYTES)
        expect(result.properties.$ai_input).toHaveLength(400)
    })

    it('omits conversation content that clipping cannot fit', () => {
        const input = [
            {
                role: 'tool',
                content: Array.from({ length: 80_000 }, (_, index) => `s${index}${'D'.repeat(30)}`),
            },
        ]

        const result = generationFor(input, 'summarize')

        expect(serializedBytes(result.properties)).toBeLessThanOrEqual(POSTHOG_AI_EVENT_LIMIT_BYTES)
        expect(result.properties.$ai_input).toEqual([
            { role: 'system', content: '[omitted: input exceeded the PostHog AI event size limit]' },
        ])
        expect(result.properties.$ai_output_choices).toBeNull()
        expect(result.properties.$ai_user_prompt).toBeUndefined()
    })

    it('uses the available budget instead of clipping further than needed', () => {
        // Every clipped string also carries a `...[truncated N chars]` marker, so
        // a cap computed from the budget alone overshoots and wastes roughly half
        // the available bytes. The cap must be found against the real serialized
        // size, keeping as much conversation content as the budget allows.
        const input = Array.from({ length: 400 }, (_, index) => ({
            role: 'tool',
            content: `m${index}:${'H'.repeat(5000)}`,
        }))

        const result = generationFor(input, 'summarize', { ...defaultConfig, maxEventBytes: 900_000 })
        const bytes = serializedBytes(result.properties)

        expect(bytes).toBeLessThanOrEqual(900_000)
        expect(bytes).toBeGreaterThan(0.9 * 900_000)
        expect(result.properties.$ai_input).toHaveLength(400)
    })

    it('leaves turns that already fit untouched', () => {
        const input = [
            { role: 'user', content: 'read the log' },
            { role: 'tool', content: 'E'.repeat(2_000) },
        ]

        const result = generationFor(input, 'read the log')

        expect(result.properties.$ai_input).toEqual(input)
        expect(result.properties.$ai_user_prompt).toBe('read the log')
    })

    it('honors a smaller configured budget', () => {
        const result = generationFor([{ role: 'tool', content: 'F'.repeat(200_000) }], 'read the log', {
            ...defaultConfig,
            maxEventBytes: 20_000,
        })

        expect(serializedBytes(result.properties)).toBeLessThanOrEqual(20_000)
    })

    it('clamps a configured budget above the PostHog limit', () => {
        const result = generationFor([{ role: 'tool', content: 'G'.repeat(2_000_000) }], 'read the log', {
            ...defaultConfig,
            maxEventBytes: 50_000_000,
        })

        expect(serializedBytes(result.properties)).toBeLessThanOrEqual(POSTHOG_AI_EVENT_LIMIT_BYTES)
    })
})
