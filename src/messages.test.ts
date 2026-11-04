import { describe, expect, it } from 'vitest'
import { extractAssistantText, extractToolCalls, formatContextMessages } from './messages.js'

const assistantWithToolCall = {
    role: 'assistant',
    content: [
        { type: 'thinking', thinking: 'I should list the files' },
        { type: 'text', text: 'Let me look.' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
    ],
    timestamp: 1,
}

const toolResult = {
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'a.txt\n' }],
    isError: false,
    timestamp: 2,
}

describe('extractToolCalls', () => {
    it('converts toolCall blocks to OpenAI tool calls', () => {
        expect(extractToolCalls(assistantWithToolCall.content)).toEqual([
            { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
        ])
    })

    it('returns no tool calls for text-only or non-array content', () => {
        expect(extractToolCalls([{ type: 'text', text: 'hi' }])).toEqual([])
        expect(extractToolCalls('hi')).toEqual([])
        expect(extractToolCalls(undefined)).toEqual([])
    })
})

describe('extractAssistantText', () => {
    it('keeps text and leaves out thinking and tool calls', () => {
        expect(extractAssistantText(assistantWithToolCall.content)).toBe('Let me look.')
    })
})

describe('formatContextMessages', () => {
    it('keeps assistant tool calls and links tool results to them', () => {
        const formatted = formatContextMessages([
            { role: 'user', content: 'List the files', timestamp: 0 },
            assistantWithToolCall,
            toolResult,
        ])

        expect(formatted).toEqual([
            { role: 'user', content: 'List the files' },
            {
                role: 'assistant',
                content: 'Let me look.',
                tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'call_1', name: 'bash', content: 'a.txt\n' },
        ])
    })

    it('adds the system prompt as the first message', () => {
        const formatted = formatContextMessages([{ role: 'user', content: 'Hi', timestamp: 0 }], 'You are a CAD agent.')

        expect(formatted[0]).toEqual({ role: 'system', content: 'You are a CAD agent.' })
        expect(formatted[1]).toEqual({ role: 'user', content: 'Hi' })
    })

    it('leaves out an empty system prompt', () => {
        expect(formatContextMessages([], '  ')).toEqual([])
        expect(formatContextMessages([])).toEqual([])
    })

    it('omits tool_calls on assistant messages without tool calls', () => {
        const [message] = formatContextMessages([
            { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], timestamp: 1 },
        ])
        expect(message).toEqual({ role: 'assistant', content: 'Done.' })
    })

    it('keeps unknown message roles as serialized content', () => {
        const [message] = formatContextMessages([{ role: 'bashExecution', command: 'ls' }])
        expect(message).toEqual({ role: 'unknown', content: '{"role":"bashExecution","command":"ls"}' })
    })
})
