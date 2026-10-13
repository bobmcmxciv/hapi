import { useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { VoiceDelivery, VoiceTarget } from './types'

/**
 * The instruction the voice assistant drafted and read back, waiting for the user's yes/no.
 * One at a time; a new draft replaces the old one. Lives only in this tab.
 */
export type VoiceInstructionDraft = {
    target: VoiceTarget
    instruction: string
    original: string
    readback: string
    createdAt: number
    /** Decided when drafting; only matters while the target is busy. */
    delivery: VoiceDelivery
    targetBusy: boolean
}

/** A yes/no that arrives later than this no longer refers to the draft. */
export const VOICE_DRAFT_TTL_MS = 3 * 60_000

let draft: VoiceInstructionDraft | null = null
const listeners = new Set<() => void>()

function emit() {
    for (const listener of listeners) listener()
}

export function getVoiceInstructionDraft(now: number = Date.now()): VoiceInstructionDraft | null {
    if (draft && now - draft.createdAt > VOICE_DRAFT_TTL_MS) {
        draft = null
        emit()
    }
    return draft
}

function snapshot(): VoiceInstructionDraft | null {
    return draft
}

export function setVoiceInstructionDraft(next: VoiceInstructionDraft | null): void {
    draft = next
    emit()
}

export function updateVoiceInstructionText(instruction: string): void {
    if (!draft) return
    draft = { ...draft, instruction }
    emit()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

export function useVoiceInstructionDraft(): VoiceInstructionDraft | null {
    return useSyncExternalStore(subscribe, snapshot, () => null)
}

/** The text the agent receives: the normalized instruction plus the spoken original for cross-checking. */
export function composeVoiceInstructionText(current: Pick<VoiceInstructionDraft, 'instruction' | 'original'>): string {
    const original = current.original.trim()
    return original && original !== current.instruction.trim()
        ? `${current.instruction.trim()}\n\n（语音原话：${original}）`
        : current.instruction.trim()
}

/**
 * Send the current draft to its target session and clear it. Without an explicit delivery the
 * draft's own decision applies: `steer` interrupts the running turn, `queue` waits behind it.
 */
export async function sendVoiceInstructionDraft(api: ApiClient, delivery?: VoiceDelivery): Promise<VoiceInstructionDraft> {
    const current = draft
    if (!current) throw new Error('no drafted instruction')
    const mode = delivery ?? current.delivery
    await api.sendMessage(
        current.target.id,
        composeVoiceInstructionText(current),
        null,
        undefined,
        undefined,
        undefined,
        mode === 'steer' ? 'steer' : undefined
    )
    if (draft === current) setVoiceInstructionDraft(null)
    return { ...current, delivery: mode }
}
