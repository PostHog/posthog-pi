import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import { buildAiGeneration, buildAiSpan, buildAiTrace } from './events.js'
import type { LastAssistantInfo, PostHogPiConfig, TurnState } from './types.js'
import { getAgentName, getProjectName, safeStringify } from './utils.js'

const DEFAULT_HOST = 'https://us.i.posthog.com'

export default function (pi: ExtensionAPI) {
    // Read config from environment variables
    const apiKey = process.env.POSTHOG_API_KEY ?? ''
    const host = process.env.POSTHOG_HOST ?? DEFAULT_HOST
    const privacyMode = process.env.POSTHOG_PRIVACY_MODE === 'true'
    const enabled = process.env.POSTHOG_ENABLED !== 'false'
    const traceGrouping = (process.env.POSTHOG_TRACE_GROUPING as 'message' | 'session') ?? 'message'
    const sessionWindowMinutes = parseInt(process.env.POSTHOG_SESSION_WINDOW_MINUTES ?? '60', 10) || 60
    const maxAttributeLength = parseInt(process.env.POSTHOG_MAX_ATTRIBUTE_LENGTH ?? '12000', 10) || 12000

    // Parse custom tags from POSTHOG_TAGS env (format: "key1:val1,key2:val2")
    const tags: Record<string, string> = {}
    const tagsEnv = process.env.POSTHOG_TAGS
    if (tagsEnv) {
        for (const pair of tagsEnv.split(',')) {
            const colonIdx = pair.indexOf(':')
            if (colonIdx > 0) {
                const key = pair.slice(0, colonIdx).trim()
                const val = pair.slice(colonIdx + 1).trim()
                if (key.length > 0 && val.length > 0) {
                    tags[key] = val
                }
            }
        }
    }

    const config: PostHogPiConfig = {
        apiKey,
        host,
        privacyMode,
        enabled,
        traceGrouping,
        sessionWindowMinutes,
        projectName: process.env.POSTHOG_PROJECT_NAME,
        agentName: process.env.POSTHOG_AGENT_NAME,
        tags,
        maxAttributeLength,
    }

    if (!config.enabled) return

    if (!config.apiKey) {
        console.warn('posthog-pi: missing POSTHOG_API_KEY, extension will not capture events')
        return
    }

    // Derive project and agent names
    const cwd = process.cwd()
    const projectName = getProjectName(config.projectName, cwd)
    const agentName = getAgentName(config.agentName, projectName)

    // State
    let client: import('posthog-node').PostHog | null = null

    /** Current turn state (one LLM call) */
    const turns = new Map<number, TurnState>()
    /** Active trace IDs keyed by agentRunId */
    const traces = new Map<string, string>()
    /** Most recent generation spanId, used as parent for tool spans */
    let currentGenerationSpanId: string | undefined
    /** Current trace ID */
    let currentTraceId: string | undefined
    /** Current model/provider (updated via model_select) */
    let currentModelId = 'unknown'
    let currentProviderId = 'unknown'
    /** Accumulated token totals per traceId */
    const traceTokens = new Map<string, { input: number; output: number }>()
    /** Session window tracking */
    let sessionWindow: { sessionId: string; lastOutputAt: number } | undefined
    /** Agent start time for trace latency */
    let agentStartTime: number | undefined
    /** Last agent run counter for trace grouping */
    let agentRunCounter = 0
    /** Tool execution start times and args keyed by toolCallId */
    const toolStartTimes = new Map<string, { startTime: number; args: unknown }>()
    /** Message start times keyed by timestamp for LLM latency tracking */
    const messageStartTimes = new Map<number, number>()
    /** Last user prompt text (captured via input event) */
    let lastUserPrompt: string | undefined

    function getOrCreateSessionId(): string {
        const timeoutMs = config.sessionWindowMinutes * 60_000
        if (sessionWindow && Date.now() - sessionWindow.lastOutputAt < timeoutMs) {
            return sessionWindow.sessionId
        }
        const windowId = randomUUID().slice(0, 8)
        const sessionId = `pi:${windowId}`
        sessionWindow = { sessionId, lastOutputAt: Date.now() }
        return sessionId
    }

    function getOrCreateTraceId(): string {
        const runKey = String(agentRunCounter)

        if (config.traceGrouping === 'session') {
            const timeoutMs = config.sessionWindowMinutes * 60_000
            if (currentTraceId && sessionWindow && Date.now() - sessionWindow.lastOutputAt < timeoutMs) {
                return currentTraceId
            }
            // Clean up old trace tokens
            if (currentTraceId) {
                traceTokens.delete(currentTraceId)
            }
            currentTraceId = randomUUID()
            return currentTraceId
        }

        // "message" mode — new trace per agent run
        const existing = traces.get(runKey)
        if (existing) return existing

        const traceId = randomUUID()
        traces.set(runKey, traceId)
        currentTraceId = traceId
        return traceId
    }

    async function ensureClient(): Promise<import('posthog-node').PostHog | null> {
        if (client) return client
        try {
            const { PostHog: PostHogClient } = await import('posthog-node')
            client = new PostHogClient(config.apiKey, {
                host: config.host,
                flushAt: 20,
                flushInterval: 10_000,
            })
            return client
        } catch (e) {
            console.error('posthog-pi: failed to initialize PostHog client:', e)
            return null
        }
    }

    // Initialize client on session start
    pi.on('session_start', async () => {
        await ensureClient()
    })

    // Track model changes
    pi.on('model_select', async (event) => {
        currentModelId = event.model.id
        currentProviderId = event.model.provider
    })

    // Capture raw user prompt
    pi.on('input', async (event) => {
        if (typeof event.text === 'string') {
            lastUserPrompt = event.text
        }
    })

    // Track agent runs for trace grouping
    pi.on('agent_start', async () => {
        agentRunCounter++
        agentStartTime = Date.now()
    })

    // Track turn start
    pi.on('turn_start', async (event) => {
        const traceId = getOrCreateTraceId()
        const spanId = randomUUID()
        const sessionId = getOrCreateSessionId()

        const turnState: TurnState = {
            traceId,
            spanId,
            startTime: event.timestamp,
            model: currentModelId,
            provider: currentProviderId,
            input: null,
            sessionId,
        }

        // Attach user prompt and consume it so subsequent turns don't inherit it
        if (lastUserPrompt) {
            turnState.userPrompt = lastUserPrompt
            lastUserPrompt = undefined
        }

        turns.set(event.turnIndex, turnState)
    })

    // Capture context messages for input tracking
    pi.on('context', async (event) => {
        // Find the most recent turn and attach context messages as input
        const turnKeys = Array.from(turns.keys())
        if (turnKeys.length === 0) return

        const latestTurnIndex = Math.max(...turnKeys)
        const turnState = turns.get(latestTurnIndex)
        if (!turnState) return

        if (!config.privacyMode) {
            // Convert messages to a simplified format for PostHog
            turnState.input = event.messages.map((msg) => {
                if ('role' in msg) {
                    const role = msg.role
                    if (role === 'user') {
                        return {
                            role: 'user',
                            content: typeof msg.content === 'string' ? msg.content : safeStringify(msg.content),
                        }
                    }
                    if (role === 'assistant') {
                        const assistantMsg = msg as { role: 'assistant'; content: unknown[] }
                        const textParts = assistantMsg.content
                            .filter(
                                (c: unknown) =>
                                    typeof c === 'object' && c !== null && (c as { type: string }).type === 'text'
                            )
                            .map((c: unknown) => (c as { text: string }).text)
                        return {
                            role: 'assistant',
                            content: textParts.join(''),
                        }
                    }
                    if (role === 'toolResult') {
                        const toolMsg = msg as { role: 'toolResult'; toolName: string; content: unknown[] }
                        return {
                            role: 'tool',
                            content: toolMsg.content
                                .filter(
                                    (c: unknown) =>
                                        typeof c === 'object' && c !== null && (c as { type: string }).type === 'text'
                                )
                                .map((c: unknown) => (c as { text: string }).text)
                                .join(''),
                        }
                    }
                }
                return { role: 'unknown', content: safeStringify(msg) }
            })
        }
    })

    // Track message start for LLM latency
    pi.on('message_start', async (event) => {
        const msg = event.message as unknown as Record<string, unknown>
        if (msg.role === 'assistant' && typeof msg.timestamp === 'number') {
            messageStartTimes.set(msg.timestamp, Date.now())
        }
    })

    // Capture turn end with assistant message details
    pi.on('turn_end', async (event) => {
        const phClient = await ensureClient()
        if (!phClient) return

        const turnState = turns.get(event.turnIndex)
        if (!turnState) return
        turns.delete(event.turnIndex)

        // Extract assistant info from the message
        const msg = event.message
        const assistantInfo: LastAssistantInfo = {}

        if ('role' in msg && msg.role === 'assistant') {
            const assistantMsg = msg as {
                role: 'assistant'
                model: string
                provider: string
                usage: {
                    input: number
                    output: number
                    cacheRead: number
                    cacheWrite: number
                    totalTokens: number
                    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
                }
                stopReason: string
                errorMessage?: string
                content: unknown[]
                timestamp: number
            }

            assistantInfo.model = assistantMsg.model
            assistantInfo.provider = assistantMsg.provider
            assistantInfo.stopReason = assistantMsg.stopReason
            assistantInfo.errorMessage = assistantMsg.errorMessage
            assistantInfo.usage = {
                input: assistantMsg.usage.input,
                output: assistantMsg.usage.output,
                cacheRead: assistantMsg.usage.cacheRead,
                cacheWrite: assistantMsg.usage.cacheWrite,
                totalTokens: assistantMsg.usage.totalTokens,
            }
            assistantInfo.cost = assistantMsg.usage.cost

            // Update current model/provider from actual response
            currentModelId = assistantMsg.model
            currentProviderId = assistantMsg.provider
            turnState.model = assistantMsg.model
            turnState.provider = assistantMsg.provider

            // Extract text content for output
            const textParts = assistantMsg.content
                .filter((c: unknown) => typeof c === 'object' && c !== null && (c as { type: string }).type === 'text')
                .map((c: unknown) => (c as { text: string }).text)

            if (textParts.length > 0) {
                assistantInfo.outputText = textParts.join('\n')
            }

            // Calculate actual LLM latency from message_start/message_end
            const msgStartTime = messageStartTimes.get(assistantMsg.timestamp)
            if (msgStartTime) {
                assistantInfo.llmLatencyMs = Date.now() - msgStartTime
                messageStartTimes.delete(assistantMsg.timestamp)
            }

            // Update generation span for tool parenting
            currentGenerationSpanId = turnState.spanId

            // Accumulate token totals for the trace
            const inputTokens = assistantMsg.usage.input ?? 0
            const outputTokens = assistantMsg.usage.output ?? 0
            if (inputTokens > 0 || outputTokens > 0) {
                const existing = traceTokens.get(turnState.traceId)
                if (existing) {
                    existing.input += inputTokens
                    existing.output += outputTokens
                } else {
                    traceTokens.set(turnState.traceId, { input: inputTokens, output: outputTokens })
                }
            }

            // Update session window timestamp
            if (sessionWindow) {
                sessionWindow.lastOutputAt = Date.now()
            }

            // Build and send generation event
            const generation = buildAiGeneration(turnState, assistantInfo, config, projectName, agentName)

            phClient.capture({
                distinctId: generation.distinctId,
                event: generation.event,
                properties: generation.properties,
            })
        }
    })

    // Track tool execution timing
    pi.on('tool_execution_start', async (event) => {
        toolStartTimes.set(event.toolCallId, { startTime: Date.now(), args: event.args })
    })

    // Capture tool spans
    pi.on('tool_execution_end', async (event) => {
        const phClient = await ensureClient()
        if (!phClient) return

        if (!currentTraceId) return

        const toolInfo = toolStartTimes.get(event.toolCallId)
        toolStartTimes.delete(event.toolCallId)
        const durationMs = toolInfo ? Date.now() - toolInfo.startTime : null

        const sessionId = sessionWindow?.sessionId

        const span = buildAiSpan(
            currentTraceId,
            currentGenerationSpanId,
            event.toolName,
            toolInfo?.args,
            event.result,
            durationMs,
            event.isError,
            event.isError ? (safeStringify(event.result) ?? null) : null,
            config,
            projectName,
            agentName,
            sessionId
        )

        phClient.capture({
            distinctId: span.distinctId,
            event: span.event,
            properties: span.properties,
        })
    })

    // Capture trace on agent end
    pi.on('agent_end', async (event) => {
        const phClient = await ensureClient()
        if (!phClient) return

        if (!currentTraceId) return

        const latencyMs = agentStartTime ? Date.now() - agentStartTime : null
        const tokenTotals = traceTokens.get(currentTraceId)

        // Determine if the agent run ended in error
        const lastMessage = event.messages[event.messages.length - 1]
        let isError = false
        let errorMessage: string | null = null
        if (lastMessage && 'role' in lastMessage && lastMessage.role === 'assistant') {
            const assistantMsg = lastMessage as { stopReason?: string; errorMessage?: string }
            isError = assistantMsg.stopReason === 'error'
            errorMessage = assistantMsg.errorMessage ?? null
        }

        const sessionId = sessionWindow?.sessionId

        const trace = buildAiTrace(
            currentTraceId,
            latencyMs,
            tokenTotals,
            isError,
            errorMessage,
            config,
            projectName,
            agentName,
            sessionId
        )

        phClient.capture({
            distinctId: trace.distinctId,
            event: trace.event,
            properties: trace.properties,
        })

        // Clean up in message mode
        if (config.traceGrouping !== 'session') {
            const runKey = String(agentRunCounter)
            traces.delete(runKey)
            if (currentTraceId) {
                traceTokens.delete(currentTraceId)
            }
            currentGenerationSpanId = undefined
        }

        agentStartTime = undefined
    })

    // Shutdown PostHog client on session end
    pi.on('session_shutdown', async () => {
        if (client) {
            await client.shutdown()
            client = null
        }
        turns.clear()
        traces.clear()
        traceTokens.clear()
        toolStartTimes.clear()
        messageStartTimes.clear()
        currentGenerationSpanId = undefined
        currentTraceId = undefined
        currentModelId = 'unknown'
        currentProviderId = 'unknown'
        sessionWindow = undefined
        agentStartTime = undefined
        agentRunCounter = 0
        lastUserPrompt = undefined
    })
}
