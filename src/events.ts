import type { LastAssistantInfo, PostHogPiConfig, TurnState } from './types.js'
import { randomUUID } from 'node:crypto'
import { redactForPrivacy, serializeAttribute, truncate } from './utils.js'
import { VERSION } from './version.js'

export type AiGenerationEvent = {
    event: '$ai_generation'
    distinctId: string
    properties: Record<string, unknown>
}

export type AiSpanEvent = {
    event: '$ai_span'
    distinctId: string
    properties: Record<string, unknown>
}

export type AiTraceEvent = {
    event: '$ai_trace'
    distinctId: string
    properties: Record<string, unknown>
}

const STOP_REASON_MAP: Record<string, string> = {
    stop: 'stop',
    length: 'length',
    toolUse: 'tool_calls',
    error: 'error',
    aborted: 'stop',
}

export function mapStopReason(stopReason: string | undefined): string | null {
    if (!stopReason) return null
    return STOP_REASON_MAP[stopReason] ?? stopReason
}

/**
 * PostHog rejects AI events above this size with HTTP 413, and the failure
 * drops the whole flush batch. Conversation content is unbounded, so generation
 * properties are fitted to a byte budget before capture.
 */
const POSTHOG_AI_EVENT_LIMIT_BYTES = 983_040
const DEFAULT_MAX_EVENT_BYTES = 900_000

/** Generation properties whose size follows conversation content, not config. */
const SIZE_BOUNDED_PROPERTIES = ['$ai_input', '$ai_output_choices', '$ai_user_prompt'] as const

type StringStats = { count: number; chars: number; longest: number }

function measureStrings(value: unknown, stats: StringStats): void {
    if (typeof value === 'string') {
        stats.count++
        stats.chars += value.length
        if (value.length > stats.longest) stats.longest = value.length
        return
    }
    if (Array.isArray(value)) {
        for (const item of value) measureStrings(item, stats)
        return
    }
    if (value !== null && typeof value === 'object') {
        for (const nested of Object.values(value)) measureStrings(nested, stats)
    }
}

function capStrings(value: unknown, maxChars: number): unknown {
    if (typeof value === 'string') return truncate(value, maxChars)
    if (Array.isArray(value)) return value.map((item) => capStrings(item, maxChars))
    if (value !== null && typeof value === 'object') {
        const capped: Record<string, unknown> = {}
        for (const [key, nested] of Object.entries(value)) {
            capped[key] = capStrings(nested, maxChars)
        }
        return capped
    }
    return value
}

/**
 * Smallest per-string cap worth applying. Each capped string also carries a
 * `...[truncated N chars]` marker, so clipping below this loses content without
 * meaningfully shrinking the event.
 */
const MIN_STRING_CAP = 16

/**
 * Clip conversation content until the serialized event fits the budget. Message
 * structure survives, so PostHog still sees roles, order, and truncation
 * markers for the clipped content.
 *
 * The cap is found by binary search over the real serialized size rather than
 * computed in closed form. Every capped string adds a fixed-length marker, so a
 * computed cap can oscillate instead of converging when the event holds many
 * strings; searching for the largest cap that fits both converges and keeps as
 * much content as the budget allows.
 */
function fitGenerationProperties(properties: Record<string, unknown>, maxEventBytes: number): Record<string, unknown> {
    const budget = Math.min(maxEventBytes || DEFAULT_MAX_EVENT_BYTES, POSTHOG_AI_EVENT_LIMIT_BYTES)
    const byteLength = () => Buffer.byteLength(JSON.stringify(properties) ?? '', 'utf8')
    if (byteLength() <= budget) return properties

    const originals = SIZE_BOUNDED_PROPERTIES.map((key) => properties[key])
    const applyCap = (cap: number) => {
        SIZE_BOUNDED_PROPERTIES.forEach((key, index) => {
            properties[key] = capStrings(originals[index], cap)
        })
        return byteLength() <= budget
    }

    const initial: StringStats = { count: 0, chars: 0, longest: 0 }
    for (const key of SIZE_BOUNDED_PROPERTIES) measureStrings(properties[key], initial)
    if (initial.count === 0) return properties

    // Capping at the longest string changes nothing, so the event is still over
    // budget there: a safe exclusive upper bound.
    let lo = MIN_STRING_CAP
    let hi = initial.longest
    if (!applyCap(lo)) {
        // Even minimal content saturates the budget, which happens when the
        // event holds enormous numbers of strings. Keep the event valid and
        // inside the limit rather than lose the whole flush batch.
        properties.$ai_input = [
            { role: 'system', content: '[omitted: input exceeded the PostHog AI event size limit]' },
        ]
        properties.$ai_output_choices = null
        delete properties.$ai_user_prompt
        return properties
    }
    while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2)
        if (applyCap(mid)) lo = mid
        else hi = mid
    }
    applyCap(lo)
    return properties
}

export function buildAiGeneration(
    turnState: TurnState,
    assistantInfo: LastAssistantInfo,
    config: PostHogPiConfig,
    projectName: string,
    agentName: string,
    configuredDistinctId?: string
): AiGenerationEvent {
    // Use actual LLM latency if available, otherwise fall back to turn latency
    const latency =
        assistantInfo.llmLatencyMs !== undefined
            ? assistantInfo.llmLatencyMs / 1000
            : (Date.now() - turnState.startTime) / 1000
    const distinctId = configuredDistinctId ?? turnState.sessionId ?? 'pi-agent'

    // Format input messages for PostHog
    const inputMessages = redactForPrivacy(turnState.input, config.privacyMode)

    // Format output choices from assistant text content
    let outputChoices: unknown = null
    if (!config.privacyMode) {
        if (assistantInfo.outputText) {
            outputChoices = [{ role: 'assistant', content: assistantInfo.outputText }]
        } else if (assistantInfo.stopReason === 'error') {
            outputChoices = [{ role: 'assistant', content: assistantInfo.errorMessage ?? 'Error' }]
        }
    }

    return {
        event: '$ai_generation',
        distinctId,
        properties: fitGenerationProperties(
            {
                $ai_trace_id: turnState.traceId,
                $ai_session_id: turnState.sessionId ?? null,
                $ai_span_id: turnState.spanId,
                $ai_model: assistantInfo.model ?? turnState.model,
                $ai_provider: assistantInfo.provider ?? turnState.provider,
                $ai_input: inputMessages,
                $ai_output_choices: outputChoices,
                $ai_input_tokens: assistantInfo.usage?.input ?? null,
                $ai_output_tokens: assistantInfo.usage?.output ?? null,
                $ai_total_tokens: assistantInfo.usage?.totalTokens ?? null,
                $ai_latency: latency,
                $ai_total_cost_usd: assistantInfo.cost?.total ?? null,
                $ai_input_cost_usd: assistantInfo.cost?.input ?? null,
                $ai_output_cost_usd: assistantInfo.cost?.output ?? null,
                $ai_stop_reason: mapStopReason(assistantInfo.stopReason),
                $ai_is_error: assistantInfo.stopReason === 'error',
                $ai_error: assistantInfo.errorMessage ?? null,
                $ai_lib: '@posthog/pi',
                $ai_lib_version: VERSION,
                $ai_framework: 'pi',
                $ai_project_name: projectName,
                $ai_agent_name: agentName,
                cache_read_input_tokens: assistantInfo.usage?.cacheRead ?? null,
                cache_creation_input_tokens: assistantInfo.usage?.cacheWrite ?? null,
                ...(turnState.userPrompt && !config.privacyMode ? { $ai_user_prompt: turnState.userPrompt } : {}),
                ...config.tags,
            },
            config.maxEventBytes
        ),
    }
}

export function buildAiSpan(
    traceId: string,
    parentSpanId: string | undefined,
    toolName: string,
    toolInput: unknown,
    toolOutput: unknown,
    durationMs: number | null,
    isError: boolean,
    errorMessage: string | null,
    config: PostHogPiConfig,
    projectName: string,
    agentName: string,
    sessionId?: string,
    configuredDistinctId?: string
): AiSpanEvent {
    const distinctId = configuredDistinctId ?? sessionId ?? 'pi-agent'
    const spanId = randomUUID()
    const latency = durationMs !== null ? durationMs / 1000 : null

    return {
        event: '$ai_span',
        distinctId,
        properties: {
            $ai_trace_id: traceId,
            $ai_session_id: sessionId ?? null,
            $ai_span_id: spanId,
            $ai_parent_id: parentSpanId ?? null,
            $ai_span_name: toolName,
            $ai_input_state: config.privacyMode ? null : serializeAttribute(toolInput, config.maxAttributeLength),
            $ai_output_state: config.privacyMode ? null : serializeAttribute(toolOutput, config.maxAttributeLength),
            $ai_latency: latency,
            $ai_is_error: isError,
            $ai_error: errorMessage,
            $ai_lib: '@posthog/pi',
            $ai_lib_version: VERSION,
            $ai_framework: 'pi',
            $ai_project_name: projectName,
            $ai_agent_name: agentName,
            ...config.tags,
        },
    }
}

export function buildAiTrace(
    traceId: string,
    latencyMs: number | null,
    tokenTotals: { input: number; output: number } | undefined,
    isError: boolean,
    errorMessage: string | null,
    config: PostHogPiConfig,
    projectName: string,
    agentName: string,
    sessionId?: string,
    configuredDistinctId?: string
): AiTraceEvent {
    const distinctId = configuredDistinctId ?? sessionId ?? 'pi-agent'
    const latency = latencyMs !== null ? latencyMs / 1000 : null

    return {
        event: '$ai_trace',
        distinctId,
        properties: {
            $ai_trace_id: traceId,
            $ai_session_id: sessionId ?? null,
            $ai_latency: latency,
            $ai_total_input_tokens: tokenTotals?.input ?? null,
            $ai_total_output_tokens: tokenTotals?.output ?? null,
            $ai_is_error: isError,
            $ai_error: errorMessage,
            $ai_lib: '@posthog/pi',
            $ai_lib_version: VERSION,
            $ai_framework: 'pi',
            $ai_project_name: projectName,
            $ai_agent_name: agentName,
            ...config.tags,
        },
    }
}
