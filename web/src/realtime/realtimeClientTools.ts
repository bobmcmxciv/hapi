import { getCurrentRealtimeSessionId } from './RealtimeSession'
import { VOICE_CONFIG } from './voiceConfig'
import type { ApiClient } from '@/api/client'
import { readVoiceToolMode } from '@/fork-features/voice-assistant/toolMode'
import {
    getVoiceInstructionDraft,
    sendVoiceInstructionDraft,
    setVoiceInstructionDraft,
    type VoiceInstructionDraft
} from '@/fork-features/voice-assistant/instructionDraft'
import { classifyConfirmation } from '@/fork-features/voice-assistant/confirmIntent'
import type { VoiceDelivery, VoiceTurn } from '@/fork-features/voice-assistant/types'

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
    lastSettled = null
    lastUserTranscript = ''
    previousUserTranscript = ''
    transcriptSeq = 0
    draftedFromSeq = 0
    toolCalledSinceTranscript = false
}

function rememberTurn(q: string, a: string) {
    voiceHistory = [...voiceHistory, { q, a }].slice(-MAX_VOICE_HISTORY)
}

const READ_ONLY_REFUSAL = 'error (read-only mode: voice cannot send anything to the agent or answer permission requests. Tell the user they can switch voice to assistant mode in Settings, Voice.)'

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function deliveryNote(delivery: VoiceDelivery, targetBusy: boolean): string {
    if (!targetBusy) return ''
    return delivery === 'steer' ? '（会插进它正在做的这一轮）' : '（等它这一轮做完再处理）'
}

function sentReply(sent: VoiceInstructionDraft): string {
    const how = sent.targetBusy ? (sent.delivery === 'steer' ? ', interrupting its current turn' : ', queued until its current turn finishes') : ''
    return `sent to "${sent.target.title}"${how} [say only that it was sent]`
}

/** What happened to the last draft, so a second yes (spoken + tool call) answers "already done". */
let lastSettled: { reply: string; at: number } | null = null
const SETTLED_ECHO_MS = 30_000
const CANCELLED_REPLY = 'cancelled: the user declined the drafted instruction [say briefly that nothing was sent]'

/** The one place a draft is sent or dropped, whichever path (spoken words, tool call, card) gets there first. */
async function settleDraft(decision: 'send' | 'cancel', delivery?: VoiceDelivery): Promise<string> {
    if (decision === 'cancel') {
        setVoiceInstructionDraft(null)
        lastSettled = { reply: CANCELLED_REPLY, at: Date.now() }
        return CANCELLED_REPLY
    }
    if (!assistantApi) return 'error (sending not available)'
    const pending = getVoiceInstructionDraft()
    if (pending) {
        // Recorded before the network wait so a near-simultaneous second yes is answered, not resent.
        lastSettled = { reply: sentReply({ ...pending, delivery: delivery ?? pending.delivery }), at: Date.now() }
    }
    try {
        const sent = await sendVoiceInstructionDraft(assistantApi, delivery)
        const reply = sentReply(sent)
        lastSettled = { reply, at: Date.now() }
        return reply
    } catch (error) {
        lastSettled = null
        return `error (sending failed: ${errorText(error)}). Tell the user it was not sent.`
    }
}

function recentlySettledReply(): string | null {
    return lastSettled && Date.now() - lastSettled.at < SETTLED_ECHO_MS
        ? lastSettled.reply.replace(/^sent to/, 'already sent to').replace(/^cancelled/, 'already cancelled')
        : null
}

/**
 * The read-back is waiting for a yes/no, but the realtime model sometimes hands that short answer to
 * askSessionStatus or prepareInstruction instead of calling confirmInstruction. When the words are
 * only a yes or a no, act on the pending draft here so one spoken confirmation is always enough.
 */
async function settlePendingDraft(text: string): Promise<string | null> {
    if (readVoiceToolMode() !== 'assistant' || !assistantApi) return null
    const intent = classifyConfirmation(text)
    if (!intent) return null
    if (!getVoiceInstructionDraft()) return recentlySettledReply()
    return await settleDraft(intent.decision, intent.delivery)
}

// fork(voice-assistant): what the user actually said, from the realtime model's input transcription.
let lastUserTranscript = ''
let previousUserTranscript = ''
let transcriptSeq = 0
let draftedFromSeq = 0
let toolCalledSinceTranscript = false
/** "让它…/叫它…/告诉它…/跟某个会话说…" — the user is instructing an agent, not the voice assistant. */
const INSTRUCTION_PATTERN = /^(请|麻烦|帮我|你)?(让|叫|告诉|通知|吩咐|请)(它|他|她|那个|这个|.{0,12}会话)|^(请|麻烦|帮我|你)?(跟|和|给).{0,16}(说|讲|发)/

/** The realtime model called a tool for the current utterance. */
export function noteVoiceToolCall(): void {
    toolCalledSinceTranscript = true
}

/**
 * A finished transcript of the user's speech. With a draft waiting, a plain yes/no settles it right
 * here — the spoken answer takes effect even if the model never calls confirmInstruction.
 */
export async function onVoiceUserTranscript(transcript: string): Promise<void> {
    if (!transcript.trim()) return
    previousUserTranscript = lastUserTranscript
    lastUserTranscript = transcript.trim()
    transcriptSeq += 1
    toolCalledSinceTranscript = false
    if (readVoiceToolMode() !== 'assistant' || !getVoiceInstructionDraft()) return
    const intent = classifyConfirmation(lastUserTranscript)
    if (intent) await settleDraft(intent.decision, intent.delivery)
}

/**
 * The model answered the last utterance without any tool. If that utterance was an instruction for
 * an agent, draft it here and return a note for the model to read the draft back.
 */
export async function onVoiceResponseWithoutTool(): Promise<string | null> {
    if (toolCalledSinceTranscript || readVoiceToolMode() !== 'assistant' || !assistantApi) return null
    // Each utterance is drafted at most once, and only the newest one.
    if (transcriptSeq === draftedFromSeq) return null
    const utterance = lastUserTranscript
    if (!utterance || !INSTRUCTION_PATTERN.test(utterance) || getVoiceInstructionDraft()) return null
    toolCalledSinceTranscript = true
    draftedFromSeq = transcriptSeq
    const result = await realtimeClientTools.prepareInstruction({ instruction: utterance })
    return `(System note, not from the user) The user's last sentence was an instruction for an agent and has now been drafted; do not carry it out yourself. ${result}`
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
        const settled = await settlePendingDraft(question)
        if (settled) return settled
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
        const settled = await settlePendingDraft(params.instruction)
        if (settled) return settled
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
                    const delivery: VoiceDelivery = result.delivery === 'steer' ? 'steer' : 'queue'
                    const targetBusy = result.targetBusy === true
                    setVoiceInstructionDraft({
                        target: result.target,
                        instruction: result.instruction,
                        original: result.original,
                        readback: result.readback,
                        createdAt: Date.now(),
                        delivery,
                        targetBusy
                    })
                    const readback = `发给《${result.target.title}》：${result.readback}${deliveryNote(delivery, targetBusy)}。确认发送吗？`
                    rememberTurn(utterance, readback)
                    return `Draft ready, NOT sent yet. Read this back to the user exactly: "${readback}" Then stop and wait. The moment the user agrees (确认 / 好 / 对 / 发吧), call confirmInstruction with decision "send" before saying anything; if they decline, decision "cancel".`
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
        if (params?.decision !== 'send' && params?.decision !== 'cancel') return "error (decision must be 'send' or 'cancel')"
        if (!getVoiceInstructionDraft()) {
            // The spoken yes/no may already have settled it a moment ago.
            return recentlySettledReply()
                ?? (previousUserTranscript
                    ? `error (nothing is drafted yet). If the user's earlier request "${previousUserTranscript}" was an instruction, call prepareInstruction with it now.`
                    : 'error (no drafted instruction; call prepareInstruction first)')
        }
        // The draft already says whether to interrupt; an explicit delivery is the user overriding it.
        const override = params.delivery === 'steer' || params.delivery === 'queue' ? params.delivery : undefined
        return await settleDraft(params.decision, override)
    }
}

export type RealtimeClientToolName = keyof typeof realtimeClientTools

export function getRealtimeClientTool(name: string): ((parameters: unknown) => Promise<string>) | null {
    return Object.prototype.hasOwnProperty.call(realtimeClientTools, name)
        ? realtimeClientTools[name as RealtimeClientToolName]
        : null
}
