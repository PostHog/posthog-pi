import { Type, type TSchema } from '@sinclair/typebox'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { PostHogMcpConfig } from './types.js'

/**
 * Config file support: reads `~/.pi/agent/posthog.json` once and caches it.
 * All keys are optional. Env vars always take precedence over file values.
 *
 * Example ~/.pi/agent/posthog.json:
 * {
 *   "apiKey": "phc_...",
 *   "personalApiKey": "phx_...",
 *   "host": "https://us.i.posthog.com"
 * }
 */
export interface PostHogConfigFile {
    apiKey?: string
    personalApiKey?: string
    host?: string
    privacyMode?: boolean
    enabled?: boolean
    traceGrouping?: 'message' | 'session'
    sessionWindowMinutes?: number
    projectName?: string
    agentName?: string
    tags?: Record<string, string>
    maxAttributeLength?: number
    mcp?: {
        enabled?: boolean
        url?: string
        version?: number
        features?: string[]
        tools?: string[]
        maxInlineChars?: number
        spillToFile?: boolean
        tempDir?: string
    }
}

let _configFileCache: PostHogConfigFile | null | undefined

export function readConfigFile(): PostHogConfigFile {
    if (_configFileCache !== undefined) return _configFileCache ?? {}
    const configPath = join(homedir(), '.pi', 'agent', 'posthog.json')
    try {
        const content = readFileSync(configPath, 'utf-8')
        _configFileCache = JSON.parse(content) as PostHogConfigFile
        return _configFileCache ?? {}
    } catch {
        _configFileCache = null
        return {}
    }
}

/** Reset the cached config file (for testing). */
export function resetConfigFileCache(): void {
    _configFileCache = undefined
}

export function redactForPrivacy<T>(value: T, privacyMode: boolean): T | null {
    return privacyMode ? null : value
}

export function safeStringify(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined
    }
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

// --- Sensitive key redaction ---

const SENSITIVE_KEY_PATTERN =
    /(api[-_]?key|token|secret|password|authorization|cookie|session|bearer|x-api-key|credential)/i

function redactSensitive(value: unknown, seen: WeakSet<object>, depth: number): unknown {
    if (depth > 8) return '[DepthLimit]'
    if (value === null || value === undefined) return value
    if (typeof value !== 'object') return value
    if (seen.has(value)) return '[Circular]'

    seen.add(value)

    if (Array.isArray(value)) {
        return value.map((item) => redactSensitive(item, seen, depth + 1))
    }

    const output: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
            output[key] = '[REDACTED]'
        } else {
            output[key] = redactSensitive(nested, seen, depth + 1)
        }
    }
    return output
}

function truncate(value: string, maxLength: number): string {
    if (maxLength <= 0) return ''
    if (value.length <= maxLength) return value
    const omitted = value.length - maxLength
    return `${value.slice(0, maxLength)}...[truncated ${omitted} chars]`
}

/**
 * Serialize a value for use as an event property, redacting sensitive keys
 * and truncating to maxLength.
 */
export function serializeAttribute(value: unknown, maxLength: number): string | null {
    if (value === undefined || value === null) {
        return null
    }

    const redacted = redactSensitive(value, new WeakSet<object>(), 0)

    if (typeof redacted === 'string') {
        return truncate(redacted, maxLength)
    }

    try {
        const json = JSON.stringify(redacted)
        if (json === undefined) return null
        return truncate(json, maxLength)
    } catch {
        return '[Unserializable]'
    }
}

// --- Subagent detection ---

/**
 * Detects the subagent name from CLI args when spawned by pi-subagents.
 *
 * pi-subagents writes each agent's system prompt to a temp file named
 * `{agent}.md` inside a `pi-subagent-XXXX/` directory, then passes it
 * as `--append-system-prompt /tmp/pi-subagent-XXXX/worker.md`.
 */
export function detectSubagentName(): string | undefined {
    const args = process.argv
    for (let i = 0; i < args.length - 1; i++) {
        if (args[i] !== '--append-system-prompt') continue
        const promptPath = args[i + 1]
        if (!promptPath) continue

        const dirName = basename(dirname(promptPath))
        if (!dirName.startsWith('pi-subagent-')) continue

        const fileName = basename(promptPath)
        const agentName = fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName

        if (/^[\w.-]+$/.test(agentName) && agentName.length > 0) {
            return agentName
        }
    }
    return undefined
}

/**
 * Derive the project name from config or cwd.
 */
export function getProjectName(configProjectName: string | undefined, cwd: string): string {
    if (configProjectName && configProjectName.length > 0) return configProjectName
    const guessed = basename(cwd)
    return guessed.length > 0 ? guessed : 'pi-project'
}

/**
 * Derive the agent name from config, subagent detection, or project name.
 */
export function getAgentName(configAgentName: string | undefined, projectName: string): string {
    if (configAgentName && configAgentName.length > 0) return configAgentName
    const subagentName = detectSubagentName()
    if (subagentName) return `${projectName}/${subagentName}`
    return projectName
}

export function getPostHogAuthHeader(env: NodeJS.ProcessEnv): string | null {
    const authHeader = env.POSTHOG_AUTH_HEADER?.trim()
    if (authHeader) return authHeader

    const apiKey = env.POSTHOG_PERSONAL_API_KEY?.trim() || readConfigFile().personalApiKey?.trim()
    if (!apiKey) return null
    return apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`
}

export function buildPostHogMcpUrl(config: PostHogMcpConfig): string {
    const url = new URL(config.url)
    if (config.features.length > 0) {
        url.searchParams.set('features', config.features.join(','))
    }
    if (config.tools.length > 0) {
        url.searchParams.set('tools', config.tools.join(','))
    }
    return url.toString()
}

export function stringifyMcpContent(content: unknown[] | undefined): Array<{ type: 'text'; text: string }> {
    if (!content || content.length === 0) {
        return [{ type: 'text', text: 'PostHog MCP tool returned no content.' }]
    }

    const parts = content.map((item) => {
        if (!item || typeof item !== 'object') return safeStringify(item) ?? ''
        const typedItem = item as { type?: string; text?: string; data?: string; mimeType?: string }
        if (typedItem.type === 'text' && typeof typedItem.text === 'string') {
            return typedItem.text
        }
        if (typedItem.type === 'image' && typeof typedItem.mimeType === 'string') {
            return `[image content: ${typedItem.mimeType}]`
        }
        return safeStringify(item) ?? ''
    })

    return [{ type: 'text', text: parts.filter(Boolean).join('\n\n') }]
}

export interface FormattedMcpToolResult {
    content: Array<{ type: 'text'; text: string }>
    details: {
        isError: boolean
        structuredContent: unknown
        content: unknown
        spilledToFile: boolean
        filePath: string | null
        preview: string | null
        serializedLength: number
    }
}

export async function formatMcpToolResult(options: {
    toolName: string
    result: { content?: unknown[]; structuredContent?: unknown; isError?: boolean }
    config: Pick<PostHogMcpConfig, 'spillToFile' | 'maxInlineChars' | 'tempDir'>
}): Promise<FormattedMcpToolResult> {
    const inlineContent = stringifyMcpContent(options.result.content)
    const inlineText = inlineContent.map((part) => part.text).join('\n\n')
    const serializedPayload = JSON.stringify(
        {
            tool: options.toolName,
            timestamp: new Date().toISOString(),
            isError: options.result.isError ?? false,
            content: options.result.content ?? [],
            structuredContent: options.result.structuredContent ?? null,
        },
        null,
        2
    )
    const serializedLength = serializedPayload.length

    if (!options.config.spillToFile || serializedLength <= options.config.maxInlineChars) {
        return {
            content: inlineContent,
            details: {
                isError: options.result.isError ?? false,
                structuredContent: options.result.structuredContent ?? null,
                content: options.result.content ?? null,
                spilledToFile: false,
                filePath: null,
                preview: inlineText || null,
                serializedLength,
            },
        }
    }

    const filePath = await spillMcpResultToFile(options.config.tempDir, options.toolName, serializedPayload)
    const preview = truncate(
        inlineText || '[No inline text preview available]',
        Math.min(options.config.maxInlineChars, 4000)
    )

    return {
        content: [
            {
                type: 'text',
                text: [
                    `PostHog MCP tool \`${options.toolName}\` returned a large result, so it was saved to:`,
                    filePath,
                    '',
                    `Preview (${serializedLength} chars total):`,
                    preview,
                    '',
                    'Use the read tool to inspect the saved file if you need the full result.',
                ].join('\n'),
            },
        ],
        details: {
            isError: options.result.isError ?? false,
            structuredContent: options.result.structuredContent ?? null,
            content: options.result.content ?? null,
            spilledToFile: true,
            filePath,
            preview,
            serializedLength,
        },
    }
}

async function spillMcpResultToFile(baseDir: string, toolName: string, serializedPayload: string): Promise<string> {
    const dir = baseDir || join(tmpdir(), 'posthog-mcp')
    await mkdir(dir, { recursive: true })

    const safeToolName = toolName.replace(/[^a-zA-Z0-9_-]/g, '_')
    const filePath = join(dir, `${safeToolName}-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
    await writeFile(filePath, serializedPayload, 'utf8')
    return filePath
}

export function jsonSchemaToTypeBox(schema: unknown): TSchema {
    if (!schema || typeof schema !== 'object') {
        return Type.Object({}, { additionalProperties: true })
    }

    const typedSchema = schema as {
        type?: string | string[]
        description?: string
        properties?: Record<string, unknown>
        required?: string[]
        items?: unknown
        enum?: unknown[]
        anyOf?: unknown[]
        oneOf?: unknown[]
    }

    if (Array.isArray(typedSchema.anyOf) && typedSchema.anyOf.length > 0) {
        return Type.Union(typedSchema.anyOf.map((entry) => jsonSchemaToTypeBox(entry)))
    }

    if (Array.isArray(typedSchema.oneOf) && typedSchema.oneOf.length > 0) {
        return Type.Union(typedSchema.oneOf.map((entry) => jsonSchemaToTypeBox(entry)))
    }

    const schemaType = Array.isArray(typedSchema.type) ? typedSchema.type[0] : typedSchema.type

    if (Array.isArray(typedSchema.enum) && typedSchema.enum.every((value) => typeof value === 'string')) {
        return Type.Union(
            typedSchema.enum.map((value) => Type.Literal(value)),
            {
                description: typedSchema.description,
            }
        )
    }

    switch (schemaType) {
        case 'string':
            return Type.String({ description: typedSchema.description })
        case 'number':
            return Type.Number({ description: typedSchema.description })
        case 'integer':
            return Type.Integer({ description: typedSchema.description })
        case 'boolean':
            return Type.Boolean({ description: typedSchema.description })
        case 'array':
            return Type.Array(jsonSchemaToTypeBox(typedSchema.items), { description: typedSchema.description })
        case 'object': {
            const required = new Set(typedSchema.required ?? [])
            const properties = Object.fromEntries(
                Object.entries(typedSchema.properties ?? {}).map(([key, value]) => {
                    const converted = jsonSchemaToTypeBox(value)
                    return [key, required.has(key) ? converted : Type.Optional(converted)]
                })
            )
            return Type.Object(properties, {
                description: typedSchema.description,
                additionalProperties: true,
            })
        }
        default:
            return Type.Object({}, { description: typedSchema.description, additionalProperties: true })
    }
}
