export interface PostHogPiConfig {
    apiKey: string
    host: string
    privacyMode: boolean
    enabled: boolean
    traceGrouping: 'message' | 'session'
    sessionWindowMinutes: number
    /** Project name override (defaults to cwd basename) */
    projectName?: string
    /** Agent name override (defaults to projectName, with subagent detection) */
    agentName?: string
    /** Custom tags/properties added to all events */
    tags: Record<string, string>
    /** Max length for serialized tool input/output attributes */
    maxAttributeLength: number
}

export interface LastAssistantInfo {
    stopReason?: string
    errorMessage?: string
    model?: string
    provider?: string
    /** Text content from the assistant response */
    outputText?: string
    cost?: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        total: number
    }
    usage?: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        totalTokens: number
    }
    /** Actual LLM response latency in ms (message_start to message_end) */
    llmLatencyMs?: number
}

export interface TurnState {
    traceId: string
    spanId: string
    startTime: number
    model: string
    provider: string
    input: unknown[] | null
    sessionId?: string
    /** Raw user prompt that triggered this turn */
    userPrompt?: string
}
