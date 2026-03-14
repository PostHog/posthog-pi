import { basename, dirname } from 'node:path'

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
