import type { LastAssistantInfo, PostHogPiConfig, TurnState } from './types.js'
import { randomUUID } from 'node:crypto'
import { redactForPrivacy, serializeAttribute } from './utils.js'
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

export function buildAiGeneration(
    turnState: TurnState,
    assistantInfo: LastAssistantInfo,
    config: PostHogPiConfig,
    projectName: string,
    agentName: string
): AiGenerationEvent {
    // Use actual LLM latency if available, otherwise fall back to turn latency
    const latency =
        assistantInfo.llmLatencyMs !== undefined
            ? assistantInfo.llmLatencyMs / 1000
            : (Date.now() - turnState.startTime) / 1000
    const distinctId = turnState.sessionId ?? 'pi-agent'

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
        properties: {
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
    sessionId?: string
): AiSpanEvent {
    const distinctId = sessionId ?? 'pi-agent'
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
    sessionId?: string
): AiTraceEvent {
    const distinctId = sessionId ?? 'pi-agent'
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
