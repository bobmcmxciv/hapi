import { getCurrentRealtimeSessionId } from './RealtimeSession'
import { VOICE_CONFIG } from './voiceConfig'
import type { ApiClient } from '@/api/client'
import { readVoiceToolMode } from '@/fork-features/voice-assistant/toolMode'
import {
    getVoiceInstructionDraft,
    sendVoiceInstructionDraft,
    setVoiceInstructionDraft
} from '@/fork-features/voice-assistant/instructionDraft'
import type { VoiceTurn } from '@/fork-features/voice-assistant/types'

// Store for session state and API client
let sessionStore: {
    getSession: (sessionId: string) => { agentState?: { requests?: Record<string, unknown> } } | null
    sendMessage: (sessionId: string, message: string) => void
    approvePermission: (sessionId: string, requestId: string) => Promise<void>
    denyPermission: (sessionId: string, requestId: string) => Promise<void>
} | null = null

// fork(voice-assistant): hub lookups and instruction drafts go through the authenticated API client.
let assistantApi: ApiClient | null = null
// Recent spoken Q&A in this voice conversation, so follow-ups ("and the second one?") resolve.
let voiceHistory: VoiceTurn[] = []
const MAX_VOICE_HISTORY = 4

/**
 * Register the session store for client tools to access
 */
export function registerSessionStore(store: typeof sessionStore) {
    sessionStore = store
}

export function registerVoiceAssistantApi(api: ApiClient | null) {
    assistantApi = api
}

/** Forget the spoken Q&A and any unsent draft (voice session ended). */
export function resetVoiceAssistantState() {
    voiceHistory = []
    setVoiceInstructionDraft(null)
}

function rememberTurn(q: string, a: string) {
    voiceHistory = [...voiceHistory, { q, a }].slice(-MAX_VOICE_HISTORY)
}

const READ_ONLY_REFUSAL = 'error (read-only mode: voice cannot send anything to the agent or answer permission requests. Tell the user they can switch voice to assistant mode in Settings, Voice.)'

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * Static client tools for the realtime voice interface.
 * These tools allow the voice assistant to interact with Claude Code.
 */
export const realtimeClientTools = {
    /**
     * Send a message to the active coding agent
     */
    messageCodingAgent: async (parameters: unknown) => {
        if (readVoiceToolMode() === 'readonly') return READ_ONLY_REFUSAL
        const params = parameters as { message?: string }

        if (!params.message || typeof params.message !== 'string' || params.message.trim() === '') {
            console.error('[Voice] Invalid message parameter:', parameters)
            return 'error (invalid message parameter)'
        }

        const message = params.message.trim()
        const sessionId = getCurrentRealtimeSessionId()

        if (!sessionId) {
            console.error('[Voice] No active session')
            return 'error (no active session)'
        }

        if (!sessionStore) {
            console.error('[Voice] Session store not registered')
            return 'error (session store not available)'
        }

        if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
            console.log('[Voice] messageCodingAgent called with:', message)
            console.log('[Voice] Sending message to session:', sessionId)
        }

        sessionStore.sendMessage(sessionId, message)
        return "sent [DO NOT say anything else, simply say 'sent']"
    },

    /**
     * Process a permission request from Claude Code
     */
    processPermissionRequest: async (parameters: unknown) => {
        if (readVoiceToolMode() === 'readonly') return READ_ONLY_REFUSAL
        const params = parameters as { decision?: string }

        if (!params.decision || (params.decision !== 'allow' && params.decision !== 'deny')) {
            console.error('[Voice] Invalid decision parameter:', parameters)
            return "error (invalid decision parameter, expected 'allow' or 'deny')"
        }

        const decision = params.decision
        const sessionId = getCurrentRealtimeSessionId()

        if (!sessionId) {
            console.error('[Voice] No active session')
            return 'error (no active session)'
        }

        if (!sessionStore) {
            console.error('[Voice] Session store not registered')
            return 'error (session store not available)'
        }

        if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
            console.log('[Voice] processPermissionRequest called with:', decision)
        }

        // Get the current session to check for permission requests
        const session = sessionStore.getSession(sessionId)
        const requests = session?.agentState?.requests

        if (!requests || Object.keys(requests).length === 0) {
            console.error('[Voice] No active permission request')
            return 'error (no active permission request)'
        }

        const requestId = Object.keys(requests)[0]

        try {
            if (decision === 'allow') {
                await sessionStore.approvePermission(sessionId, requestId)
            } else {
                await sessionStore.denyPermission(sessionId, requestId)
            }
            return "done [DO NOT say anything else, simply say 'done']"
        } catch (error) {
            console.error('[Voice] Failed to process permission:', error)
            return `error (failed to ${decision} permission)`
        }
    },

    /**
     * fork(voice-assistant): answer a question about the session from the hub's digest + recent
     * messages. Read-only in every mode — nothing reaches the agent.
     */
    askSessionStatus: async (parameters: unknown) => {
        const question = (parameters as { question?: unknown })?.question
        if (typeof question !== 'string' || !question.trim()) return 'error (missing question)'
        const sessionId = getCurrentRealtimeSessionId()
        if (!sessionId) return 'error (no active session)'
        if (!assistantApi) return 'error (lookup not available)'
        try {
            const result = await assistantApi.askVoiceSessionStatus({
                sessionId,
                question: question.trim(),
                history: voiceHistory
            })
            rememberTurn(question.trim(), result.answer)
            return `Answer to speak to the user naturally, adding nothing: ${result.answer}`
        } catch (error) {
            console.error('[Voice] askSessionStatus failed:', error)
            return `error (lookup failed: ${errorText(error)}). Tell the user you could not look it up right now.`
        }
    },

    /**
     * fork(voice-assistant): turn the user's words into a clean instruction for a session. Sends
     * nothing; the draft waits for confirmInstruction (or the on-screen card).
     */
    prepareInstruction: async (parameters: unknown) => {
        if (readVoiceToolMode() === 'readonly') return READ_ONLY_REFUSAL
        const params = parameters as { instruction?: unknown; target?: unknown }
        if (typeof params?.instruction !== 'string' || !params.instruction.trim()) return 'error (missing instruction)'
        const sessionId = getCurrentRealtimeSessionId()
        if (!sessionId) return 'error (no active session)'
        if (!assistantApi) return 'error (instructions not available)'
        const utterance = params.instruction.trim()
        const targetHint = typeof params.target === 'string' && params.target.trim() ? params.target.trim() : undefined
        try {
            const result = await assistantApi.prepareVoiceInstruction({
                currentSessionId: sessionId,
                utterance,
                targetHint,
                history: voiceHistory
            })
            switch (result.status) {
                case 'ready': {
                    setVoiceInstructionDraft({
                        target: result.target,
                        instruction: result.instruction,
                        original: result.original,
                        readback: result.readback,
                        createdAt: Date.now()
                    })
                    const readback = `发给《${result.target.title}》：${result.readback}。确认发送吗？`
                    rememberTurn(utterance, readback)
                    return `Draft ready, NOT sent yet. Read this back to the user exactly: "${readback}" Then wait for their answer: yes -> confirmInstruction with decision "send"; no -> decision "cancel".`
                }
                case 'need_info':
                    rememberTurn(utterance, result.ask)
                    return `Nothing drafted yet. Ask the user: "${result.ask}" Then call prepareInstruction again with their complete request.`
                case 'ambiguous':
                    rememberTurn(utterance, result.ask)
                    return `Nothing drafted yet. Ask the user: "${result.ask}" Then call prepareInstruction again with target set to the session they pick.`
                case 'no_target':
                    return `Nothing drafted yet. Ask the user: "${result.ask}"`
                case 'target_inactive':
                    return `The session "${result.target.title}" is stopped, so nothing can be sent to it. Tell the user.`
            }
        } catch (error) {
            console.error('[Voice] prepareInstruction failed:', error)
            return `error (drafting failed: ${errorText(error)}). Tell the user it could not be drafted right now.`
        }
    },

    /** fork(voice-assistant): send or drop the drafted instruction after the spoken read-back. */
    confirmInstruction: async (parameters: unknown) => {
        if (readVoiceToolMode() === 'readonly') return READ_ONLY_REFUSAL
        const params = parameters as { decision?: unknown; delivery?: unknown }
        const current = getVoiceInstructionDraft()
        if (!current) return 'error (no drafted instruction; call prepareInstruction first)'
        if (params?.decision === 'cancel') {
            setVoiceInstructionDraft(null)
            return 'cancelled [say briefly that nothing was sent]'
        }
        if (params?.decision !== 'send') return "error (decision must be 'send' or 'cancel')"
        if (!assistantApi) return 'error (sending not available)'
        try {
            const target = await sendVoiceInstructionDraft(assistantApi, params.delivery === 'steer' ? 'steer' : 'queue')
            return `sent to "${target.title}" [say only that it was sent]`
        } catch (error) {
            console.error('[Voice] confirmInstruction failed:', error)
            return `error (sending failed: ${errorText(error)}). Tell the user it was not sent.`
        }
    }
}

export type RealtimeClientToolName = keyof typeof realtimeClientTools

export function getRealtimeClientTool(name: string): ((parameters: unknown) => Promise<string>) | null {
    return Object.prototype.hasOwnProperty.call(realtimeClientTools, name)
        ? realtimeClientTools[name as RealtimeClientToolName]
        : null
}
