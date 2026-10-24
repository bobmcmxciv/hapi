import { describe, expect, test } from 'bun:test'
import {
    buildGeminiLiveSetupMessage,
    buildQwenSessionUpdateMessage,
    parseVoiceListenMode,
    parseVoiceToolMode,
    voiceToolDefinitionsFor
} from './voice'
import { buildVoiceToolModeBlock, getVoicePlatformFixturesPreview } from './voicePersonality'

const names = (mode: Parameters<typeof voiceToolDefinitionsFor>[0]) => voiceToolDefinitionsFor(mode).map((tool) => tool.name)

describe('voice tool modes', () => {
    test('read-only sessions can look things up and switch mode by voice', () => {
        expect(names('readonly')).toEqual(['askSessionStatus', 'setVoiceToolMode'])
    })

    test('assistant sessions draft and confirm instructions instead of sending directly', () => {
        expect(names('assistant')).toEqual(['processPermissionRequest', 'askSessionStatus', 'prepareInstruction', 'confirmInstruction', 'setVoiceToolMode'])
        expect(names('assistant')).not.toContain('messageCodingAgent')
    })

    test('clients that send no mode keep the tools they already handle', () => {
        expect(parseVoiceToolMode(null)).toBe('legacy')
        expect(parseVoiceToolMode('bogus')).toBe('legacy')
        expect(names('legacy')).toEqual(['messageCodingAgent', 'processPermissionRequest'])
    })

    test('the hub-owned Qwen session.update carries only the mode tools', () => {
        const msg = buildQwenSessionUpdateMessage(undefined, undefined, undefined, 'readonly')
        const tools = (msg.session as { tools: Array<{ name: string }> }).tools
        expect(tools.map((tool) => tool.name)).toEqual(['askSessionStatus', 'setVoiceToolMode'])
    })

    test('the Gemini setup carries only the mode tools', () => {
        const msg = buildGeminiLiveSetupMessage(undefined, undefined, undefined, { toolMode: 'readonly' })
        const declarations = (msg.setup.tools as Array<{ functionDeclarations: Array<{ name: string }> }>)[0]!.functionDeclarations
        expect(declarations.map((tool) => tool.name)).toEqual(['askSessionStatus', 'setVoiceToolMode'])
    })
})

describe('voice prompt routing', () => {
    test('questions go to askSessionStatus and the old pass-it-through rule is gone', () => {
        const fixtures = getVoicePlatformFixturesPreview()
        expect(fixtures).toContain('call askSessionStatus with the user')
        expect(fixtures).toContain('questions about OTHER sessions or projects')
        expect(fixtures).toContain('You never do the work yourself')
        expect(fixtures).toContain('call confirmInstruction with decision "send" before saying anything')
        expect(fixtures).not.toContain('If in doubt, pass it through')
        expect(fixtures).not.toContain('You MUST call the messageCodingAgent tool for ANY request')
    })

    test('the mode block tells the model what is turned off and how to switch mode by voice', () => {
        expect(buildVoiceToolModeBlock('readonly')).toContain('read-only')
        expect(buildVoiceToolModeBlock('readonly')).toContain('setVoiceToolMode')
        expect(buildVoiceToolModeBlock('assistant')).toContain('confirmInstruction')
        expect(buildVoiceToolModeBlock('assistant')).toContain('setVoiceToolMode')
    })
})

describe('Qwen output mode', () => {
    test('text output drops the audio modality so the browser can speak the reply itself', () => {
        const msg = buildQwenSessionUpdateMessage('zh', undefined, undefined, 'readonly', 'text')
        expect((msg.session as { modalities: string[] }).modalities).toEqual(['text'])
    })

    test('audio output stays the default', () => {
        const msg = buildQwenSessionUpdateMessage('zh', undefined, undefined, 'readonly')
        expect((msg.session as { modalities: string[] }).modalities).toEqual(['text', 'audio'])
    })
})

describe('Qwen voice catalog (fork: verified on qwen3.5-omni-flash-realtime)', () => {
    test('a stored voice the model rejects falls back to the default instead of failing the session', async () => {
        const { resolveQwenRealtimeVoice } = await import('./voicePickerCatalog')
        expect(resolveQwenRealtimeVoice('Cherry')).toBe('Tina')
        expect(resolveQwenRealtimeVoice('Chelsie')).toBe('Tina')
        expect(resolveQwenRealtimeVoice('Mia')).toBe('Mia')
        const msg = buildQwenSessionUpdateMessage('zh', 'Cherry', undefined, 'readonly', 'text')
        expect((msg.session as { voice: string }).voice).toBe('Tina')
    })
})

describe('voice listen modes', () => {
    const turnDetection = (listen: Parameters<typeof buildQwenSessionUpdateMessage>[5]) =>
        (buildQwenSessionUpdateMessage('zh', undefined, undefined, 'readonly', 'text', listen) as { session: { turn_detection: unknown } }).session.turn_detection

    test('unknown or missing values keep the old server VAD', () => {
        expect(parseVoiceListenMode(null)).toBe('legacy')
        expect(parseVoiceListenMode('nonsense')).toBe('legacy')
        expect(turnDetection(undefined)).toMatchObject({ type: 'server_vad' })
    })

    test('hands-free uses semantic turn detection and answers by itself', () => {
        expect(parseVoiceListenMode('auto')).toBe('auto')
        expect(turnDetection('auto')).toEqual({ type: 'semantic_vad', threshold: 0.5, silence_duration_ms: 800, prefix_padding_ms: 300 })
    })

    test('my-voice-only leaves answering and interrupting to the hub gate', () => {
        expect(parseVoiceListenMode('verified')).toBe('verified')
        expect(turnDetection('verified')).toMatchObject({ type: 'semantic_vad', create_response: false, interrupt_response: false })
    })

    test('push-to-talk turns server turn detection off', () => {
        expect(parseVoiceListenMode('manual')).toBe('manual')
        expect(turnDetection('manual')).toBeNull()
    })
})
