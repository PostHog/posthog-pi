import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerAnalyticsExtension } from './analytics-extension.js'
import { registerPostHogMcpExtension } from './mcp-extension.js'

export default function posthogPiExtension(pi: ExtensionAPI) {
    registerAnalyticsExtension(pi)
    registerPostHogMcpExtension(pi)
}
