import { safeStringify } from './utils.js'

/**
 * Pi messages converted to the OpenAI chat format that PostHog AI observability renders:
 *
 * - assistant: `{ role: 'assistant', content, tool_calls: [{ id, type: 'function', function: { name, arguments } }] }`
 * - tool result: `{ role: 'tool', tool_call_id, name, content }`
 * - system prompt: `{ role: 'system', content }`
 */
export interface PostHogToolCall {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
}

export interface PostHogMessage {
    role: string
    content: unknown
    tool_calls?: PostHogToolCall[]
    tool_call_id?: string
    name?: string
}

type ContentBlock = { type?: unknown; [key: string]: unknown }

function contentBlocks(content: unknown): ContentBlock[] {
    if (!Array.isArray(content)) return []
    return content.filter((block): block is ContentBlock => typeof block === 'object' && block !== null)
}

function joinText(content: unknown, separator: string): string {
    if (typeof content === 'string') return content
    return contentBlocks(content)
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join(separator)
}

/** The `toolCall` blocks of a Pi assistant message, as OpenAI-style tool calls. */
export function extractToolCalls(content: unknown): PostHogToolCall[] {
    return contentBlocks(content)
        .filter((block) => block.type === 'toolCall')
        .map((block) => ({
            id: typeof block.id === 'string' ? block.id : '',
            type: 'function' as const,
            function: {
                name: typeof block.name === 'string' ? block.name : 'unknown',
                arguments: safeStringify(block.arguments) ?? '{}',
            },
        }))
}

/** The text of a Pi assistant message. Thinking blocks are left out. */
export function extractAssistantText(content: unknown, separator = ''): string {
    return joinText(content, separator)
}

/**
 * A failed tool's result as `$ai_error`: the text the model sees, not the result's JSON.
 * PostHog groups errors by the start of this message, so a JSON wrapper would group them badly.
 */
export function formatToolError(result: unknown): string | null {
    if (typeof result === 'string') return result
    const content =
        typeof result === 'object' && result !== null ? (result as { content?: unknown }).content : undefined
    const text = joinText(content, '')
    if (text.length > 0) return text
    return safeStringify(result) ?? null
}

function formatMessage(msg: unknown): PostHogMessage {
    if (typeof msg !== 'object' || msg === null || !('role' in msg)) {
        return { role: 'unknown', content: safeStringify(msg) }
    }
    const message = msg as { role: unknown; content?: unknown; [key: string]: unknown }

    switch (message.role) {
        case 'user':
            return {
                role: 'user',
                content:
                    typeof message.content === 'string' || Array.isArray(message.content)
                        ? message.content
                        : safeStringify(message.content),
            }
        case 'assistant': {
            const toolCalls = extractToolCalls(message.content)
            return {
                role: 'assistant',
                content: extractAssistantText(message.content),
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            }
        }
        case 'toolResult':
            return {
                role: 'tool',
                ...(typeof message.toolCallId === 'string' ? { tool_call_id: message.toolCallId } : {}),
                ...(typeof message.toolName === 'string' ? { name: message.toolName } : {}),
                content: joinText(message.content, ''),
            }
        case 'system':
            return { role: 'system', content: joinText(message.content, '\n') }
        default:
            return { role: 'unknown', content: safeStringify(msg) }
    }
}

/**
 * The messages of a Pi `context` event, as sent to PostHog as `$ai_input`.
 *
 * Pi's `context` event leaves out the system prompt, so it is passed separately and
 * becomes the first message.
 */
export function formatContextMessages(messages: readonly unknown[], systemPrompt?: string): PostHogMessage[] {
    const formatted = messages.map(formatMessage)
    if (systemPrompt && systemPrompt.trim().length > 0) {
        formatted.unshift({ role: 'system', content: systemPrompt })
    }
    return formatted
}
