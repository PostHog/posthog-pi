import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import { buildAiGeneration, buildAiSpan, buildAiTrace } from './events.js'
import { extractAssistantText, extractToolCalls, formatContextMessages, formatToolError } from './messages.js'
import type { LastAssistantInfo, PostHogPiConfig, TurnState } from './types.js'
import { getAgentName, getProjectName, readConfigFile } from './utils.js'

const DEFAULT_HOST = 'https://us.i.posthog.com'

interface DiscoveredIdentity {
    distinctId: string
    properties: Record<string, unknown>
}

function toPostHogAppHost(ingestOrAppHost: string): string {
    try {
        const url = new URL(ingestOrAppHost)
        if (url.hostname === 'us.i.posthog.com') return 'https://us.posthog.com'
        if (url.hostname === 'eu.i.posthog.com') return 'https://eu.posthog.com'
        if (url.hostname.startsWith('i.')) {
            url.hostname = url.hostname.slice(2)
        }
        return `${url.protocol}//${url.host}`
    } catch {
        return 'https://us.posthog.com'
    }
}

function asNonEmptyString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return undefined
}

function extractIdentityFromUserResponse(payload: unknown): DiscoveredIdentity | null {
    if (!payload || typeof payload !== 'object') return null

    const candidates = [
        payload,
        (payload as { user?: unknown }).user,
        (payload as { results?: unknown[] }).results?.[0],
    ].filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')

    for (const candidate of candidates) {
        const distinctId =
            asNonEmptyString(candidate.distinct_id) ??
            asNonEmptyString(candidate.distinctId) ??
            asNonEmptyString(candidate.uuid) ??
            asNonEmptyString(candidate.id) ??
            asNonEmptyString(candidate.email)

        if (!distinctId) continue

        const properties: Record<string, unknown> = {}
        const email = asNonEmptyString(candidate.email)
        if (email) properties.email = email

        const firstName = asNonEmptyString(candidate.first_name)
        const lastName = asNonEmptyString(candidate.last_name)
        const fullName = [firstName, lastName].filter(Boolean).join(' ').trim()
        const name = fullName || asNonEmptyString(candidate.name)
        if (name) properties.name = name

        return { distinctId, properties }
    }

    return null
}

async function discoverIdentityFromPersonalApiKey(
    personalApiKey: string,
    ingestOrAppHost: string
): Promise<DiscoveredIdentity | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1500)

    try {
        const response = await fetch(`${toPostHogAppHost(ingestOrAppHost)}/api/users/@me/`, {
            method: 'GET',
            headers: {
                Authorization: personalApiKey.startsWith('Bearer ') ? personalApiKey : `Bearer ${personalApiKey}`,
                Accept: 'application/json',
            },
            signal: controller.signal,
        })

        if (!response.ok) return null
        const payload = (await response.json()) as unknown
        return extractIdentityFromUserResponse(payload)
    } catch {
        return null
    } finally {
        clearTimeout(timeout)
    }
}

export function getIdentifyProperties(distinctId: string): Record<string, unknown> {
    const properties: Record<string, unknown> = {}
    if (distinctId.includes('@') && !distinctId.includes(' ')) {
        properties.email = distinctId
    }
    return properties
}

function getConfiguredGroups(fileGroups: unknown): Record<string, string | number> | undefined {
    try {
        const value: unknown =
            process.env.POSTHOG_GROUPS !== undefined ? JSON.parse(process.env.POSTHOG_GROUPS) : fileGroups
        if (value === undefined) return undefined
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()

        const entries = Object.entries(value)
        for (const [groupType, groupKey] of entries) {
            if (
                groupType.trim().length === 0 ||
                !(
                    (typeof groupKey === 'string' && groupKey.trim().length > 0) ||
                    (typeof groupKey === 'number' && Number.isFinite(groupKey))
                )
            ) {
                throw new Error()
            }
        }
        return Object.fromEntries(entries)
    } catch {
        console.warn(
            '@posthog/pi: invalid groups configuration; expected an object mapping non-empty group types to non-empty strings or finite numbers'
        )
        return undefined
    }
}

export function registerAnalyticsExtension(pi: ExtensionAPI) {
    // Read config file (env vars always take precedence)
    const file = readConfigFile()

    const apiKey = process.env.POSTHOG_API_KEY ?? file.apiKey ?? ''
    const host = process.env.POSTHOG_HOST ?? file.host ?? DEFAULT_HOST
    const privacyMode =
        process.env.POSTHOG_PRIVACY_MODE === 'true' ||
        (file.privacyMode === true && process.env.POSTHOG_PRIVACY_MODE === undefined)
    const enabled =
        process.env.POSTHOG_ENABLED !== undefined ? process.env.POSTHOG_ENABLED !== 'false' : file.enabled !== false
    const traceGrouping =
        (process.env.POSTHOG_TRACE_GROUPING as 'message' | 'session') ?? file.traceGrouping ?? 'message'
    const sessionWindowMinutes =
        parseInt(process.env.POSTHOG_SESSION_WINDOW_MINUTES ?? '', 10) || (file.sessionWindowMinutes ?? 60)
    const maxAttributeLength =
        parseInt(process.env.POSTHOG_MAX_ATTRIBUTE_LENGTH ?? '', 10) || (file.maxAttributeLength ?? 12000)
    const configuredDistinctId = process.env.POSTHOG_DISTINCT_ID ?? file.distinctId
    const personalApiKey = (process.env.POSTHOG_PERSONAL_API_KEY ?? file.personalApiKey)?.trim() || null

    // Parse custom tags from POSTHOG_TAGS env (format: "key1:val1,key2:val2"), merge with file tags
    const tags: Record<string, string> = { ...file.tags }
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
        projectName: process.env.POSTHOG_PROJECT_NAME ?? file.projectName,
        agentName: process.env.POSTHOG_AGENT_NAME ?? file.agentName,
        tags,
        groups: getConfiguredGroups(file.groups),
        maxAttributeLength,
        distinctId: configuredDistinctId,
    }

    if (!config.enabled) return

    if (!config.apiKey) {
        console.warn('@posthog/pi: missing POSTHOG_API_KEY, extension will not capture events')
        return
    }

    // Derive project and agent names
    const cwd = process.cwd()
    const projectName = getProjectName(config.projectName, cwd)
    const agentName = getAgentName(config.agentName, projectName)

    // State
    let client: import('posthog-node').PostHog | null = null
    let resolvedDistinctId = configuredDistinctId
    let resolvedIdentifyProperties = resolvedDistinctId ? getIdentifyProperties(resolvedDistinctId) : {}
    let identityDiscoveryPromise: Promise<void> | null = null

    /** Current turn state (one LLM call) */
    const turns = new Map<number, TurnState>()
    /** Active trace IDs keyed by agentRunId */
    const traces = new Map<string, string>()
    /** Most recent generation spanId, the fallback parent for tool spans */
    let currentGenerationSpanId: string | undefined
    /** spanId of the generation that made each tool call, keyed by toolCallId */
    const toolCallGenerations = new Map<string, string>()
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
    /** Tool execution start times, args and span ids keyed by toolCallId */
    const toolStartTimes = new Map<string, { startTime: number; args: unknown; spanId: string }>()
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

    /** The state of the turn in progress: the one that started last. */
    function getLatestTurn(): TurnState | undefined {
        if (turns.size === 0) return undefined
        return turns.get(Math.max(...turns.keys()))
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
            console.error('@posthog/pi: failed to initialize PostHog client:', e)
            return null
        }
    }

    async function ensureResolvedIdentity(): Promise<void> {
        if (resolvedDistinctId || !personalApiKey) return
        if (identityDiscoveryPromise) {
            await identityDiscoveryPromise
            return
        }

        identityDiscoveryPromise = (async () => {
            const discovered = await discoverIdentityFromPersonalApiKey(personalApiKey, host)
            if (!discovered) return
            resolvedDistinctId = discovered.distinctId
            resolvedIdentifyProperties = {
                ...getIdentifyProperties(discovered.distinctId),
                ...discovered.properties,
            }
        })().finally(() => {
            identityDiscoveryPromise = null
        })

        await identityDiscoveryPromise
    }

    // Initialize client on session start
    pi.on('session_start', async () => {
        const phClient = await ensureClient()
        if (!phClient) return

        // If explicit distinct_id is not configured, try to auto-discover identity
        // from the PostHog personal API key.
        await ensureResolvedIdentity()

        if (resolvedDistinctId) {
            phClient.identify({
                distinctId: resolvedDistinctId,
                properties: resolvedIdentifyProperties,
            })
        }
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
    pi.on('context', async (event, ctx) => {
        // Find the most recent turn and attach context messages as input
        const turnState = getLatestTurn()
        if (!turnState) return

        // Pi sends the model request right after `context`
        turnState.requestStartTime = Date.now()

        if (!config.privacyMode) {
            // Pi's `context` messages leave out the system prompt, so it is read separately.
            let systemPrompt: string | undefined
            try {
                systemPrompt = ctx?.getSystemPrompt?.()
            } catch {
                systemPrompt = undefined
            }
            turnState.input = formatContextMessages(event.messages, systemPrompt)
        }
    })

    /**
     * Send one `$ai_generation` for an assistant message.
     *
     * This runs on `message_end`, which Pi emits as soon as the model's response is complete
     * and before any of its tool calls run. Sending it there gives the event the time the
     * response ended, and lets the tool spans that follow find the generation that made them.
     */
    async function captureGeneration(turnState: TurnState, message: unknown): Promise<void> {
        const assistantMsg = message as {
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
            durationMs?: number
        }

        turnState.generationCaptured = true

        const phClient = await ensureClient()
        if (!phClient) return

        const assistantInfo: LastAssistantInfo = {}
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

        // Extract text content and tool calls for output
        const outputText = extractAssistantText(assistantMsg.content, '\n')
        if (outputText.length > 0) {
            assistantInfo.outputText = outputText
        }
        const toolCalls = extractToolCalls(assistantMsg.content)
        if (toolCalls.length > 0) {
            assistantInfo.toolCalls = toolCalls
        }

        // LLM latency: Pi measures the response from the request start in `durationMs`.
        // When it does not, measure from the `context` event up to now, the response's end.
        if (typeof assistantMsg.durationMs === 'number') {
            assistantInfo.llmLatencyMs = assistantMsg.durationMs
        } else if (turnState.requestStartTime !== undefined) {
            assistantInfo.llmLatencyMs = Math.max(0, Date.now() - turnState.requestStartTime)
        }

        // Tool spans are children of the generation that made the call
        currentGenerationSpanId = turnState.spanId
        for (const toolCall of toolCalls) {
            if (toolCall.id) toolCallGenerations.set(toolCall.id, turnState.spanId)
        }

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
        const generation = buildAiGeneration(
            turnState,
            assistantInfo,
            config,
            projectName,
            agentName,
            resolvedDistinctId
        )

        phClient.capture({
            distinctId: generation.distinctId,
            event: generation.event,
            properties: generation.properties,
            groups: config.groups,
        })

        // A further model call in the same turn is its own generation
        turnState.spanId = randomUUID()
        turnState.userPrompt = undefined
        turnState.requestStartTime = undefined
    }

    // Capture each model response as soon as it is complete
    pi.on('message_end', async (event) => {
        const msg = event.message as unknown as Record<string, unknown>
        if (msg.role !== 'assistant') return

        const turnState = getLatestTurn()
        if (!turnState) return
        await captureGeneration(turnState, msg)
    })

    // End the turn. Its generation was sent on `message_end`; send it here if that did not happen.
    pi.on('turn_end', async (event) => {
        const turnState = turns.get(event.turnIndex)
        if (!turnState) return
        turns.delete(event.turnIndex)

        const msg = event.message
        if (!turnState.generationCaptured && 'role' in msg && msg.role === 'assistant') {
            await captureGeneration(turnState, msg)
        }
    })

    // Track tool execution timing
    pi.on('tool_execution_start', async (event) => {
        toolStartTimes.set(event.toolCallId, { startTime: Date.now(), args: event.args, spanId: randomUUID() })
    })

    // Capture tool spans
    pi.on('tool_execution_end', async (event) => {
        const phClient = await ensureClient()
        if (!phClient) return

        if (!currentTraceId) return

        const toolInfo = toolStartTimes.get(event.toolCallId)
        toolStartTimes.delete(event.toolCallId)
        const durationMs =
            typeof event.durationMs === 'number' ? event.durationMs : toolInfo ? Date.now() - toolInfo.startTime : null

        // A call another tool made (a codemode script, say) is a child of that tool's span;
        // otherwise the parent is the generation that made the call.
        const parentToolCallId = (event as { parentToolCallId?: string }).parentToolCallId
        const parentSpanId =
            (parentToolCallId ? toolStartTimes.get(parentToolCallId)?.spanId : undefined) ??
            toolCallGenerations.get(event.toolCallId) ??
            currentGenerationSpanId
        toolCallGenerations.delete(event.toolCallId)

        const sessionId = sessionWindow?.sessionId

        const span = buildAiSpan(
            currentTraceId,
            parentSpanId,
            event.toolName,
            toolInfo?.args,
            event.result,
            durationMs,
            event.isError,
            event.isError ? formatToolError(event.result) : null,
            config,
            projectName,
            agentName,
            sessionId,
            resolvedDistinctId,
            toolInfo?.spanId
        )

        phClient.capture({
            distinctId: span.distinctId,
            event: span.event,
            properties: span.properties,
            groups: config.groups,
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
            sessionId,
            resolvedDistinctId
        )

        phClient.capture({
            distinctId: trace.distinctId,
            event: trace.event,
            properties: trace.properties,
            groups: config.groups,
        })

        // Clean up in message mode
        if (config.traceGrouping !== 'session') {
            const runKey = String(agentRunCounter)
            traces.delete(runKey)
            if (currentTraceId) {
                traceTokens.delete(currentTraceId)
            }
            currentGenerationSpanId = undefined
            toolCallGenerations.clear()
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
        toolCallGenerations.clear()
        currentGenerationSpanId = undefined
        currentTraceId = undefined
        currentModelId = 'unknown'
        currentProviderId = 'unknown'
        sessionWindow = undefined
        agentStartTime = undefined
        agentRunCounter = 0
        lastUserPrompt = undefined
        resolvedDistinctId = configuredDistinctId
        resolvedIdentifyProperties = resolvedDistinctId ? getIdentifyProperties(resolvedDistinctId) : {}
        identityDiscoveryPromise = null
    })
}
