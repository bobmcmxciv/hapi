/** Hub contract for fork-features/voice-assistant (hub: fork-features/voice-assistant/routes.ts). */

export type VoiceTurn = { q: string; a: string }

export type VoiceSessionQaResponse = { answer: string; model: string; ms: number; sessions?: string[] }

/** While the target is working: `steer` interrupts the current turn, `queue` waits for it to finish. */
export type VoiceDelivery = 'queue' | 'steer'

export type VoiceTarget = { id: string; title: string }

export type VoiceTtsStatus = { available: boolean; voice: string | null; sampleRate: number | null; reason?: string }

export type VoiceInstructionPrepareResponse =
    | {
        status: 'ready'
        target: VoiceTarget
        instruction: string
        readback: string
        original: string
        model: string
        delivery?: VoiceDelivery
        deliveryReason?: string
        targetBusy?: boolean
    }
    | { status: 'need_info'; target: VoiceTarget; ask: string }
    | { status: 'ambiguous'; candidates: VoiceTarget[]; ask: string }
    | { status: 'no_target'; ask: string }
    | { status: 'target_inactive'; target: VoiceTarget }
