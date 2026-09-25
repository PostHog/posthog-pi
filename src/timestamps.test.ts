import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PostHog } from 'posthog-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAiGeneration, buildAiSpan, buildAiTrace } from './events.js'
import type { PostHogPiConfig, TurnState } from './types.js'
import { formatMcpToolResult } from './utils.js'

const config: PostHogPiConfig = {
    apiKey: 'test-key',
    host: 'https://example.test',
    privacyMode: false,
    enabled: true,
    traceGrouping: 'message',
    sessionWindowMinutes: 60,
    tags: {},
    maxAttributeLength: 12000,
    maxEventBytes: 900000,
}

const originalTimezone = process.env.TZ

afterEach(() => {
    vi.useRealTimers()
    if (originalTimezone === undefined) {
        delete process.env.TZ
    } else {
        process.env.TZ = originalTimezone
    }
})

describe('UTC timestamps', () => {
    it('emits all integration telemetry with canonical UTC timestamps through posthog-node', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2025-07-04T12:34:56.789-07:00'))

        const requestBodies: string[] = []
        const client = new PostHog(config.apiKey, {
            host: config.host,
            disableCompression: true,
            flushAt: 20,
            flushInterval: 100_000,
            fetch: async (_url, options) => {
                expect(typeof options.body).toBe('string')
                requestBodies.push(options.body as string)
                return new Response('{}', { status: 200 })
            },
        })
        const turnState: TurnState = {
            traceId: 'trace-123',
            spanId: 'span-456',
            startTime: Date.now() - 500,
            model: 'test-model',
            provider: 'test-provider',
            input: null,
            sessionId: 'session-789',
        }
        client.identify({ distinctId: 'session-789', properties: {} })
        const events = [
            buildAiGeneration(turnState, { stopReason: 'stop', llmLatencyMs: 500 }, config, 'project', 'agent'),
            buildAiSpan(
                turnState.traceId,
                turnState.spanId,
                'read',
                null,
                null,
                250,
                false,
                null,
                config,
                'project',
                'agent',
                turnState.sessionId
            ),
            buildAiTrace(
                turnState.traceId,
                5000,
                undefined,
                false,
                null,
                config,
                'project',
                'agent',
                turnState.sessionId
            ),
        ]

        for (const event of events) {
            client.capture(event)
        }
        await client.shutdown()

        expect(requestBodies).toHaveLength(1)
        const payload = JSON.parse(requestBodies[0]) as {
            sent_at: string
            batch: Array<{ event: string; timestamp: string; properties: Record<string, unknown> }>
        }
        expect(payload.sent_at).toBe('2025-07-04T19:34:56.789Z')
        expect(payload.batch.map((event) => [event.event, event.timestamp])).toEqual([
            ['$identify', '2025-07-04T19:34:56.789Z'],
            ['$ai_generation', '2025-07-04T19:34:56.789Z'],
            ['$ai_span', '2025-07-04T19:34:56.789Z'],
            ['$ai_trace', '2025-07-04T19:34:56.789Z'],
        ])
        expect(payload.batch.map((event) => event.properties.$ai_latency)).toEqual([undefined, 0.5, 0.25, 5])
    })

    it('writes report timestamps as the equivalent UTC instant', async () => {
        process.env.TZ = 'Asia/Kathmandu'
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2025, 0, 2, 3, 4, 5, 678))
        const tempDir = await mkdtemp(join(tmpdir(), 'posthog-pi-timestamp-'))

        try {
            const result = await formatMcpToolResult({
                toolName: 'execute-sql',
                result: { content: [{ type: 'text', text: 'large result' }], isError: false },
                config: { spillToFile: true, maxInlineChars: 1, tempDir },
            })
            const report = JSON.parse(await readFile(result.details.filePath!, 'utf8')) as { timestamp: string }

            expect(report.timestamp).toBe('2025-01-01T21:19:05.678Z')
        } finally {
            await rm(tempDir, { recursive: true, force: true })
        }
    })
})
