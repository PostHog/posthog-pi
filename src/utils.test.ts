import { describe, it, expect } from 'vitest'
import {
    buildPostHogMcpUrl,
    formatMcpToolResult,
    getAgentName,
    getPostHogAuthHeader,
    getProjectName,
    jsonSchemaToTypeBox,
    redactForPrivacy,
    safeStringify,
    serializeAttribute,
    stringifyMcpContent,
} from './utils.js'

describe('redactForPrivacy', () => {
    it('returns value when privacy mode is off', () => {
        expect(redactForPrivacy('hello', false)).toBe('hello')
        expect(redactForPrivacy({ key: 'val' }, false)).toEqual({ key: 'val' })
    })

    it('returns null when privacy mode is on', () => {
        expect(redactForPrivacy('hello', true)).toBeNull()
        expect(redactForPrivacy({ key: 'val' }, true)).toBeNull()
    })
})

describe('safeStringify', () => {
    it('stringifies objects', () => {
        expect(safeStringify({ a: 1 })).toBe('{"a":1}')
    })

    it('returns undefined for null/undefined', () => {
        expect(safeStringify(null)).toBeUndefined()
        expect(safeStringify(undefined)).toBeUndefined()
    })

    it('handles circular references', () => {
        const obj: Record<string, unknown> = {}
        obj.self = obj
        const result = safeStringify(obj)
        expect(result).toBeDefined()
    })
})

describe('serializeAttribute', () => {
    it('serializes simple values', () => {
        expect(serializeAttribute({ a: 1 }, 1000)).toBe('{"a":1}')
        expect(serializeAttribute('hello', 1000)).toBe('hello')
    })

    it('redacts sensitive keys', () => {
        const input = {
            command: 'curl',
            api_key: 'sk-secret-123',
            apiKey: 'another-secret',
            token: 'my-token',
            password: 'pass123',
            authorization: 'Bearer xyz',
            normal_field: 'visible',
        }
        const result = serializeAttribute(input, 10000)
        expect(result).toContain('[REDACTED]')
        expect(result).not.toContain('sk-secret-123')
        expect(result).not.toContain('another-secret')
        expect(result).not.toContain('my-token')
        expect(result).not.toContain('pass123')
        expect(result).not.toContain('Bearer xyz')
        expect(result).toContain('curl')
        expect(result).toContain('visible')
    })

    it('redacts nested sensitive keys', () => {
        const input = {
            headers: { Authorization: 'Bearer secret' },
            config: { api_key: 'hidden' },
        }
        const result = serializeAttribute(input, 10000)
        expect(result).not.toContain('secret')
        expect(result).not.toContain('hidden')
    })

    it('truncates long output', () => {
        const longStr = 'a'.repeat(200)
        const result = serializeAttribute(longStr, 50)
        expect(result).not.toBeNull()
        expect(result!.length).toBeLessThan(200)
        expect(result).toContain('...[truncated')
    })

    it('handles circular references', () => {
        const obj: Record<string, unknown> = { name: 'test' }
        obj.self = obj
        const result = serializeAttribute(obj, 1000)
        expect(result).toContain('[Circular]')
        expect(result).toContain('test')
    })

    it('handles deep nesting', () => {
        let obj: Record<string, unknown> = { value: 'deep' }
        for (let i = 0; i < 20; i++) {
            obj = { nested: obj }
        }
        const result = serializeAttribute(obj, 10000)
        expect(result).toContain('[DepthLimit]')
    })

    it('returns null for undefined and null', () => {
        expect(serializeAttribute(undefined, 1000)).toBeNull()
        expect(serializeAttribute(null, 1000)).toBeNull()
    })
})

describe('getProjectName', () => {
    it('returns config project name when provided', () => {
        expect(getProjectName('my-proj', '/some/path')).toBe('my-proj')
    })

    it('returns cwd basename when no config', () => {
        expect(getProjectName(undefined, '/Users/dev/my-app')).toBe('my-app')
    })

    it('returns fallback for empty cwd', () => {
        expect(getProjectName(undefined, '')).toBe('pi-project')
    })

    it('ignores empty config value', () => {
        expect(getProjectName('', '/Users/dev/my-app')).toBe('my-app')
    })
})

describe('getAgentName', () => {
    it('returns config agent name when provided', () => {
        expect(getAgentName('custom-agent', 'my-proj')).toBe('custom-agent')
    })

    it('returns project name as fallback', () => {
        expect(getAgentName(undefined, 'my-proj')).toBe('my-proj')
    })

    it('ignores empty config value', () => {
        expect(getAgentName('', 'my-proj')).toBe('my-proj')
    })
})

describe('getPostHogAuthHeader', () => {
    it('prefers POSTHOG_AUTH_HEADER', () => {
        expect(getPostHogAuthHeader({ POSTHOG_AUTH_HEADER: 'Bearer abc', POSTHOG_PERSONAL_API_KEY: 'phx_123' })).toBe(
            'Bearer abc'
        )
    })

    it('builds bearer header from personal API key', () => {
        expect(getPostHogAuthHeader({ POSTHOG_PERSONAL_API_KEY: 'phx_123' })).toBe('Bearer phx_123')
    })

    it('returns null when auth is missing', () => {
        expect(getPostHogAuthHeader({})).toBeNull()
    })
})

describe('buildPostHogMcpUrl', () => {
    it('adds features and tools filters', () => {
        expect(
            buildPostHogMcpUrl({
                enabled: true,
                url: 'https://mcp.posthog.com/mcp',
                version: 2,
                features: ['sql', 'flags'],
                tools: ['dashboard-get'],
                maxInlineChars: 12000,
                spillToFile: true,
                tempDir: '/tmp/posthog-mcp-test',
            })
        ).toBe('https://mcp.posthog.com/mcp?features=sql%2Cflags&tools=dashboard-get')
    })
})

describe('stringifyMcpContent', () => {
    it('joins text content into one text block', () => {
        expect(
            stringifyMcpContent([
                { type: 'text', text: 'hello' },
                { type: 'text', text: 'world' },
            ])
        ).toEqual([{ type: 'text', text: 'hello\n\nworld' }])
    })
})

describe('jsonSchemaToTypeBox', () => {
    it('converts object schemas and preserves required fields', () => {
        const result = jsonSchemaToTypeBox({
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Query text' },
                limit: { type: 'integer' },
            },
            required: ['query'],
        })

        expect(result.type).toBe('object')
        expect(result.required).toContain('query')
        expect(result.required).not.toContain('limit')
        expect(result.properties?.query).toMatchObject({ type: 'string', description: 'Query text' })
    })
})

describe('formatMcpToolResult', () => {
    it('keeps small results inline', async () => {
        const result = await formatMcpToolResult({
            toolName: 'feature-flag-get-all',
            result: { content: [{ type: 'text', text: 'small result' }], isError: false },
            config: { spillToFile: true, maxInlineChars: 1000, tempDir: '/tmp/posthog-mcp-test' },
        })

        expect(result.details.spilledToFile).toBe(false)
        expect(result.content[0].text).toContain('small result')
    })

    it('spills large results to a temp file', async () => {
        const result = await formatMcpToolResult({
            toolName: 'execute-sql',
            result: { content: [{ type: 'text', text: 'x'.repeat(2000) }], isError: false },
            config: { spillToFile: true, maxInlineChars: 200, tempDir: '/tmp/posthog-mcp-test' },
        })

        expect(result.details.spilledToFile).toBe(true)
        expect(result.details.filePath).toContain('/tmp/posthog-mcp-test/')
        expect(result.content[0].text).toContain('saved to:')
        expect(result.content[0].text).toContain('Use the read tool')
    })
})
