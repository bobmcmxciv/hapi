import { useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { VoiceTarget } from './types'

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
}

let draft: VoiceInstructionDraft | null = null
const listeners = new Set<() => void>()

function emit() {
    for (const listener of listeners) listener()
}

export function getVoiceInstructionDraft(): VoiceInstructionDraft | null {
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
    return useSyncExternalStore(subscribe, getVoiceInstructionDraft, () => null)
}

/** The text the agent receives: the normalized instruction plus the spoken original for cross-checking. */
export function composeVoiceInstructionText(current: VoiceInstructionDraft): string {
    const original = current.original.trim()
    return original && original !== current.instruction.trim()
        ? `${current.instruction.trim()}\n\n（语音原话：${original}）`
        : current.instruction.trim()
}

/**
 * Send the current draft to its target session and clear it. `steer` interrupts the running turn;
 * otherwise the message queues behind it like a normal send.
 */
export async function sendVoiceInstructionDraft(api: ApiClient, delivery?: 'queue' | 'steer'): Promise<VoiceTarget> {
    const current = draft
    if (!current) throw new Error('no drafted instruction')
    await api.sendMessage(
        current.target.id,
        composeVoiceInstructionText(current),
        null,
        undefined,
        undefined,
        undefined,
        delivery === 'steer' ? 'steer' : undefined
    )
    if (draft === current) setVoiceInstructionDraft(null)
    return current.target
}
