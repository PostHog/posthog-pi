import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getIdentifyProperties, registerAnalyticsExtension } from './analytics-extension.js'
import { readConfigFile } from './utils.js'

vi.mock('./utils.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./utils.js')>()),
    readConfigFile: vi.fn<typeof readConfigFile>(() => ({})),
}))

describe('getIdentifyProperties', () => {
    it('sets email when distinct id looks like an email', () => {
        expect(getIdentifyProperties('user@example.com')).toEqual({ email: 'user@example.com' })
    })

    it('does not set email for non-email distinct ids', () => {
        expect(getIdentifyProperties('pi:84aab8dd')).toEqual({})
    })

    it('does not set email for values with spaces', () => {
        expect(getIdentifyProperties('user @example.com')).toEqual({})
    })
})

const captured = vi.hoisted(
    () =>
        [] as Array<{
            event: string
            properties: Record<string, unknown>
            groups?: Record<string, string | number>
            at: number
        }>
)

vi.mock('posthog-node', () => ({
    PostHog: class {
        capture(message: {
            event: string
            properties: Record<string, unknown>
            groups?: Record<string, string | number>
        }) {
            captured.push({ ...message, at: Date.now() })
        }
        identify() {}
        async shutdown() {}
    },
}))

type Handler = (event: unknown, ctx: unknown) => unknown

/** A stand-in for Pi's ExtensionAPI that records handlers so a test can emit events. */
function fakePi() {
    const handlers = new Map<string, Handler[]>()
    const pi = {
        on(event: string, handler: Handler) {
            handlers.set(event, [...(handlers.get(event) ?? []), handler])
        },
    }
    const ctx = { getSystemPrompt: () => 'You are a CAD agent.' }
    async function emit(event: string, payload: Record<string, unknown> = {}) {
        for (const handler of handlers.get(event) ?? []) {
            await handler({ type: event, ...payload }, ctx)
        }
    }
    return { pi: pi as unknown as ExtensionAPI, emit }
}

const usage = {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
}

describe('registerAnalyticsExtension', () => {
    const envKeys = [
        'POSTHOG_API_KEY',
        'POSTHOG_PRIVACY_MODE',
        'POSTHOG_ENABLED',
        'POSTHOG_DISTINCT_ID',
        'POSTHOG_GROUPS',
    ] as const
    const savedEnv: Record<string, string | undefined> = {}

    beforeEach(() => {
        for (const key of envKeys) savedEnv[key] = process.env[key]
        process.env.POSTHOG_API_KEY = 'phc_test'
        process.env.POSTHOG_PRIVACY_MODE = 'false'
        process.env.POSTHOG_ENABLED = 'true'
        process.env.POSTHOG_DISTINCT_ID = 'user@example.com'
        delete process.env.POSTHOG_GROUPS
        vi.mocked(readConfigFile).mockReturnValue({})
        captured.length = 0
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-11-04T12:00:00.000Z'))
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.useRealTimers()
        for (const key of envKeys) {
            if (savedEnv[key] === undefined) delete process.env[key]
            else process.env[key] = savedEnv[key]
        }
    })

    /** One agent run in Pi's event order: a turn that calls a tool, then a turn that answers. */
    async function runAgent() {
        const { pi, emit } = fakePi()
        registerAnalyticsExtension(pi)

        const userMessage = { role: 'user', content: 'List the files', timestamp: Date.now() }
        await emit('session_start')
        await emit('input', { text: 'List the files' })
        await emit('agent_start')

        // Turn 0: the model calls a tool
        await emit('turn_start', { turnIndex: 0, timestamp: Date.now() })
        await emit('context', { messages: [userMessage] })
        const firstRequestStart = Date.now()
        vi.advanceTimersByTime(3000)
        const toolCallMessage = {
            role: 'assistant',
            content: [
                { type: 'text', text: 'Let me look.' },
                { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
            ],
            model: 'test-model',
            provider: 'test-provider',
            usage,
            stopReason: 'toolUse',
            timestamp: firstRequestStart,
            durationMs: 3000,
        }
        await emit('message_start', { message: toolCallMessage })
        await emit('message_end', { message: toolCallMessage })
        const generationEnd = Date.now()

        await emit('tool_execution_start', { toolCallId: 'call_1', toolName: 'bash', args: { command: 'ls' } })
        vi.advanceTimersByTime(2000)
        const toolResult = {
            role: 'toolResult',
            toolCallId: 'call_1',
            toolName: 'bash',
            content: [{ type: 'text', text: 'a.txt\n' }],
            isError: false,
            timestamp: Date.now(),
        }
        await emit('tool_execution_end', {
            toolCallId: 'call_1',
            toolName: 'bash',
            result: { content: toolResult.content },
            isError: false,
            durationMs: 2000,
        })
        await emit('turn_end', { turnIndex: 0, message: toolCallMessage, toolResults: [toolResult] })

        // Turn 1: the model answers
        await emit('turn_start', { turnIndex: 1, timestamp: Date.now() })
        await emit('context', { messages: [userMessage, toolCallMessage, toolResult] })
        const secondRequestStart = Date.now()
        vi.advanceTimersByTime(1000)
        const answer = {
            role: 'assistant',
            content: [{ type: 'text', text: 'There is one file, a.txt.' }],
            model: 'test-model',
            provider: 'test-provider',
            usage,
            stopReason: 'stop',
            timestamp: secondRequestStart,
            durationMs: 1000,
        }
        await emit('message_end', { message: answer })
        await emit('turn_end', { turnIndex: 1, message: answer, toolResults: [] })
        await emit('agent_end', { messages: [toolCallMessage, toolResult, answer] })

        return { generationEnd }
    }

    it.each(['environment', 'file'] as const)('attributes every AI event to groups from %s', async (source) => {
        const groups = { workspace: 'foobar', organization: 0 }
        if (source === 'environment') process.env.POSTHOG_GROUPS = JSON.stringify(groups)
        else vi.mocked(readConfigFile).mockReturnValue({ groups })

        await runAgent()

        expect(captured.map((event) => event.event)).toEqual([
            '$ai_generation',
            '$ai_span',
            '$ai_generation',
            '$ai_trace',
        ])
        for (const event of captured) expect(event.groups).toEqual(groups)
    })

    it('replaces file groups with the environment mapping rather than mixing workspaces', async () => {
        vi.mocked(readConfigFile).mockReturnValue({ groups: { workspace: 'file-workspace', company: 'old' } })
        process.env.POSTHOG_GROUPS = '{"workspace":"env-workspace"}'

        await runAgent()

        for (const event of captured) expect(event.groups).toEqual({ workspace: 'env-workspace' })
    })

    it('allows an empty environment mapping to clear file groups', async () => {
        vi.mocked(readConfigFile).mockReturnValue({ groups: { workspace: 'file-workspace' } })
        process.env.POSTHOG_GROUPS = '{}'

        await runAgent()

        for (const event of captured) expect(event.groups).toEqual({})
    })

    it('leaves group attribution unset when not configured', async () => {
        await runAgent()

        for (const event of captured) expect(event.groups).toBeUndefined()
    })

    it.each([
        '',
        'not-json',
        'null',
        '[]',
        '"workspace"',
        '{"workspace":true}',
        '{"workspace":null}',
        '{"workspace":{}}',
        '{"workspace":[]}',
        '{"workspace":""}',
        '{"workspace":"   "}',
        '{" ":"secret-workspace"}',
        '{"workspace":1e400}',
    ])('ignores invalid environment groups without interrupting capture: %s', async (value) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.mocked(readConfigFile).mockReturnValue({ groups: { workspace: 'file-workspace' } })
        process.env.POSTHOG_GROUPS = value

        await runAgent()

        expect(captured).toHaveLength(4)
        for (const event of captured) expect(event.groups).toBeUndefined()
        expect(warn).toHaveBeenCalledExactlyOnceWith(
            '@posthog/pi: invalid groups configuration; expected an object mapping non-empty group types to non-empty strings or finite numbers'
        )
    })

    it('ignores invalid group values in the config file', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.mocked(readConfigFile).mockReturnValue(JSON.parse('{"groups":{"workspace":false}}'))

        await runAgent()

        expect(captured).toHaveLength(4)
        for (const event of captured) expect(event.groups).toBeUndefined()
        expect(warn).toHaveBeenCalledOnce()
    })

    it('keeps group attribution in privacy mode', async () => {
        process.env.POSTHOG_PRIVACY_MODE = 'true'
        process.env.POSTHOG_GROUPS = '{"workspace":"foobar"}'

        await runAgent()

        for (const event of captured) expect(event.groups).toEqual({ workspace: 'foobar' })
    })

    it('captures nothing when disabled even if groups are configured', async () => {
        process.env.POSTHOG_ENABLED = 'false'
        process.env.POSTHOG_GROUPS = '{"workspace":"foobar"}'

        await runAgent()

        expect(captured).toEqual([])
    })

    it('sends each generation when its response ends, before the tools it called', async () => {
        const { generationEnd } = await runAgent()

        expect(captured.map((e) => e.event)).toEqual(['$ai_generation', '$ai_span', '$ai_generation', '$ai_trace'])

        const [firstGeneration, toolSpan, secondGeneration] = captured
        // The generation covers the model call only, and ends before the tool starts.
        expect(firstGeneration!.at).toBe(generationEnd)
        expect(firstGeneration!.properties.$ai_latency).toBe(3)
        const toolStart = toolSpan!.at - (toolSpan!.properties.$ai_latency as number) * 1000
        expect(toolStart).toBeGreaterThanOrEqual(firstGeneration!.at)
        expect(toolSpan!.properties.$ai_latency).toBe(2)
        expect(secondGeneration!.properties.$ai_latency).toBe(1)
    })

    it('makes each tool span a child of the generation that called the tool', async () => {
        await runAgent()

        const [firstGeneration, toolSpan, secondGeneration] = captured
        expect(toolSpan!.properties.$ai_parent_id).toBe(firstGeneration!.properties.$ai_span_id)
        expect(secondGeneration!.properties.$ai_span_id).not.toBe(firstGeneration!.properties.$ai_span_id)
    })

    it('sends the tool calls, tool call ids and system prompt', async () => {
        await runAgent()

        const [firstGeneration, , secondGeneration] = captured
        const toolCalls = [
            { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
        ]

        expect(firstGeneration!.properties.$ai_output_choices).toEqual([
            { role: 'assistant', content: 'Let me look.', tool_calls: toolCalls },
        ])
        expect(secondGeneration!.properties.$ai_input).toEqual([
            { role: 'system', content: 'You are a CAD agent.' },
            { role: 'user', content: 'List the files' },
            { role: 'assistant', content: 'Let me look.', tool_calls: toolCalls },
            { role: 'tool', tool_call_id: 'call_1', name: 'bash', content: 'a.txt\n' },
        ])
        expect(firstGeneration!.properties.$ai_user_prompt).toBe('List the files')
        expect(secondGeneration!.properties.$ai_user_prompt).toBeUndefined()
    })

    it('sends a generation on turn_end when message_end did not send it', async () => {
        process.env.POSTHOG_GROUPS = '{"workspace":"foobar"}'
        const { pi, emit } = fakePi()
        registerAnalyticsExtension(pi)
        await emit('session_start')
        await emit('agent_start')
        await emit('turn_start', { turnIndex: 0, timestamp: Date.now() })
        await emit('context', { messages: [] })
        const answer = {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi' }],
            model: 'test-model',
            provider: 'test-provider',
            usage,
            stopReason: 'stop',
            // A message built before the request, as Pi's faux provider does: not the request start
            timestamp: Date.now() - 60_000,
        }
        vi.advanceTimersByTime(500)
        await emit('turn_end', { turnIndex: 0, message: answer, toolResults: [] })

        expect(captured.map((e) => e.event)).toEqual(['$ai_generation'])
        expect(captured[0]!.properties.$ai_latency).toBe(0.5)
        expect(captured[0]!.groups).toEqual({ workspace: 'foobar' })
    })

    it('sends no message content in privacy mode', async () => {
        process.env.POSTHOG_PRIVACY_MODE = 'true'
        await runAgent()

        for (const event of captured) {
            expect(event.properties.$ai_input ?? null).toBeNull()
            expect(event.properties.$ai_output_choices ?? null).toBeNull()
        }
    })
})
