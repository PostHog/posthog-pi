import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@mariozechner/pi-coding-agent'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import { VERSION } from './version.js'
import type { PostHogMcpConfig } from './types.js'
import {
    buildPostHogMcpUrl,
    formatMcpToolResult,
    getPostHogAuthHeader,
    jsonSchemaToTypeBox,
    readConfigFile,
} from './utils.js'

const STATUS_KEY = 'posthog-mcp'
const MCP_TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/

export function registerPostHogMcpExtension(pi: ExtensionAPI) {
    const config = readMcpConfig()
    if (!config.enabled) return

    let client: Client | null = null
    let registered = false
    let connecting: Promise<void> | null = null
    let lastError: string | null = null
    const registeredToolNames = new Set<string>()

    function setStatus(text: string | undefined, ctx?: ExtensionContext | ExtensionCommandContext) {
        ctx?.ui?.setStatus(STATUS_KEY, text)
    }

    async function closeClient() {
        if (!client) return
        const current = client
        client = null
        try {
            await current.close()
        } catch {
            // Ignore shutdown errors.
        }
    }

    async function ensureConnected(ctx?: ExtensionContext | ExtensionCommandContext) {
        if (registered) return
        if (connecting) return connecting

        connecting = (async () => {
            const authHeader = getPostHogAuthHeader(process.env)
            if (!authHeader) {
                lastError = 'Missing POSTHOG_AUTH_HEADER or POSTHOG_PERSONAL_API_KEY'
                setStatus('PostHog MCP: auth missing', ctx)
                return
            }

            setStatus('PostHog MCP: connecting…', ctx)
            await closeClient()

            const url = buildPostHogMcpUrl(config)
            const transport = new StreamableHTTPClientTransport(new URL(url), {
                requestInit: {
                    headers: {
                        Authorization: authHeader,
                        Accept: 'application/json, text/event-stream',
                        'x-posthog-mcp-version': String(config.version),
                        'x-posthog-mcp-user-agent': `@posthog/pi ${VERSION}`,
                    },
                },
            })

            const nextClient = new Client({ name: '@posthog/pi', version: VERSION })
            try {
                await nextClient.connect(transport)
                client = nextClient
                const response = await client.listTools()
                registerTools(response.tools, ctx)
                registered = true
                lastError = null
                setStatus(`PostHog MCP: ${registeredToolNames.size} tools`, ctx)
                ctx?.ui?.notify(`PostHog MCP connected (${registeredToolNames.size} tools)`, 'info')
            } catch (error) {
                await nextClient.close().catch(() => undefined)
                lastError = error instanceof Error ? error.message : String(error)
                setStatus('PostHog MCP: connection failed', ctx)
                ctx?.ui?.notify(`PostHog MCP connection failed: ${lastError}`, 'error')
            }
        })().finally(() => {
            connecting = null
        })

        return connecting
    }

    function registerTools(tools: McpTool[], ctx?: ExtensionContext | ExtensionCommandContext) {
        const toolAllowlist = config.tools.length > 0 ? new Set(config.tools) : null

        for (const tool of tools) {
            if (!MCP_TOOL_NAME_RE.test(tool.name)) {
                continue
            }
            if (toolAllowlist && !toolAllowlist.has(tool.name)) {
                continue
            }
            if (registeredToolNames.has(tool.name)) {
                continue
            }
            if (pi.getAllTools().some((existing) => existing.name === tool.name)) {
                ctx?.ui?.notify(`Skipped PostHog MCP tool due to name collision: ${tool.name}`, 'warning')
                continue
            }

            registeredToolNames.add(tool.name)
            pi.registerTool({
                name: tool.name,
                label: tool.title ?? tool.name,
                description: tool.description ?? `PostHog MCP tool: ${tool.name}`,
                promptSnippet: tool.description ?? `Call PostHog MCP tool ${tool.name}`,
                parameters: jsonSchemaToTypeBox(tool.inputSchema),
                async execute(_toolCallId, params) {
                    if (!client) {
                        throw new Error('PostHog MCP is not connected')
                    }
                    const result = await client.callTool({
                        name: tool.name,
                        arguments: params as Record<string, unknown>,
                    })

                    const formatted = await formatMcpToolResult({
                        toolName: tool.name,
                        result: {
                            content: result.content as unknown[] | undefined,
                            structuredContent: result.structuredContent ?? null,
                            isError: Boolean(result.isError),
                        },
                        config,
                    })

                    if (result.isError) {
                        const errorText = formatted.content.map((c) => c.text).join('\n')
                        throw new Error(`PostHog MCP tool ${tool.name} failed: ${errorText}`)
                    }

                    return formatted
                },
            })
        }
    }

    pi.on('session_start', async (_event, ctx) => {
        const authHeader = getPostHogAuthHeader(process.env)
        if (!authHeader) {
            setStatus('PostHog MCP: set POSTHOG_PERSONAL_API_KEY', ctx)
            return
        }
        await ensureConnected(ctx)
    })

    pi.registerCommand('posthog-mcp-status', {
        description: 'Show PostHog MCP connection status',
        handler: async (_args, ctx) => {
            const authHeader = getPostHogAuthHeader(process.env)
            const status = [
                `enabled: ${String(config.enabled)}`,
                `connected: ${String(registered && client !== null)}`,
                `version: ${config.version}`,
                `url: ${buildPostHogMcpUrl(config)}`,
                `auth: ${authHeader ? 'configured' : 'missing'}`,
                `tools: ${registeredToolNames.size}`,
                `last_error: ${lastError ?? 'none'}`,
            ].join('\n')
            ctx.ui.notify(status, lastError ? 'warning' : 'info')
        },
    })

    pi.registerCommand('posthog-mcp-reload', {
        description: 'Reconnect to PostHog MCP and refresh tool registration',
        handler: async (_args, ctx) => {
            registered = false
            lastError = null
            await closeClient()
            await ensureConnected(ctx)
        },
    })

    pi.on('session_shutdown', async (_event, ctx) => {
        setStatus(undefined, ctx)
        await closeClient()
        registered = false
    })
}

function readMcpConfig(): PostHogMcpConfig {
    const file = readConfigFile()
    const mcp = file.mcp ?? {}

    const enabled = process.env.POSTHOG_MCP_ENABLED !== 'false' && mcp.enabled !== false
    const url = process.env.POSTHOG_MCP_URL ?? mcp.url ?? 'https://mcp.posthog.com/mcp'
    const version = parseInt(process.env.POSTHOG_MCP_VERSION ?? '', 10) || (mcp.version ?? 2)
    const features = process.env.POSTHOG_MCP_FEATURES
        ? splitCsv(process.env.POSTHOG_MCP_FEATURES)
        : (mcp.features ?? [])
    const tools = process.env.POSTHOG_MCP_TOOLS ? splitCsv(process.env.POSTHOG_MCP_TOOLS) : (mcp.tools ?? [])
    const maxInlineChars = parseInt(process.env.POSTHOG_MCP_MAX_INLINE_CHARS ?? '', 10) || (mcp.maxInlineChars ?? 12000)
    const spillToFile = process.env.POSTHOG_MCP_SPILL_TO_FILE !== 'false' && mcp.spillToFile !== false
    const tempDir = process.env.POSTHOG_MCP_TEMP_DIR ?? mcp.tempDir ?? '/tmp/posthog-mcp'

    return {
        enabled,
        url,
        version,
        features,
        tools,
        maxInlineChars,
        spillToFile,
        tempDir,
    }
}

function splitCsv(value: string | undefined): string[] {
    if (!value) return []
    return value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
}
