import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createServer } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { registerAnalyticsExtension } from './analytics-extension.js'

vi.mock('./utils.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./utils.js')>()),
    readConfigFile: () => ({}),
}))

afterEach(() => vi.unstubAllEnvs())

it('delivers $groups on every AI event through the real Node SDK', async () => {
    const received: Array<{ event: string; properties: Record<string, unknown> }> = []
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks)
        const decoded = request.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body
        received.push(...JSON.parse(decoded.toString()).batch)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
    vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
    vi.stubEnv('POSTHOG_HOST', `http://127.0.0.1:${address.port}`)
    vi.stubEnv('POSTHOG_ENABLED', 'true')
    vi.stubEnv('POSTHOG_PRIVACY_MODE', 'false')
    vi.stubEnv('POSTHOG_DISTINCT_ID', 'user-123')
    vi.stubEnv('POSTHOG_GROUPS', '{"workspace":"foobar","organization":0}')

    type Handler = (event: unknown) => unknown
    const handlers = new Map<string, Handler>()
    const pi = {
        on(event: string, handler: Handler) {
            handlers.set(event, handler)
        },
    }
    async function emit(event: string, payload: Record<string, unknown> = {}) {
        await handlers.get(event)?.({ type: event, ...payload })
    }

    try {
        registerAnalyticsExtension(pi as unknown as ExtensionAPI)
        await emit('session_start')
        await emit('agent_start')
        await emit('turn_start', { turnIndex: 0, timestamp: Date.now() })
        const message = {
            role: 'assistant',
            model: 'test-model',
            provider: 'test-provider',
            content: [{ type: 'text', text: 'Hello' }],
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            stopReason: 'stop',
            timestamp: Date.now(),
        }
        await emit('message_end', { message })
        await emit('tool_execution_start', { toolCallId: 'call_1', toolName: 'bash', args: { command: 'ls' } })
        await emit('tool_execution_end', {
            toolCallId: 'call_1',
            toolName: 'bash',
            result: { content: [{ type: 'text', text: 'file.txt' }] },
            isError: false,
        })
        await emit('turn_end', { turnIndex: 0, message })
        await emit('agent_end', { messages: [message] })
    } finally {
        try {
            await emit('session_shutdown')
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        }
    }

    const aiEvents = received.filter((event) => event.event.startsWith('$ai_'))
    expect(aiEvents.map((event) => event.event)).toEqual(['$ai_generation', '$ai_span', '$ai_trace'])
    for (const event of aiEvents) {
        expect(event.properties.$groups).toEqual({ workspace: 'foobar', organization: 0 })
    }
    expect(received.some((event) => event.event === '$groupidentify')).toBe(false)
})
