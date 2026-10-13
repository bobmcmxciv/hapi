import { describe, expect, test } from 'bun:test'
import {
    buildGeminiLiveSetupMessage,
    buildQwenSessionUpdateMessage,
    parseVoiceToolMode,
    voiceToolDefinitionsFor
} from './voice'
import { buildVoiceToolModeBlock, getVoicePlatformFixturesPreview } from './voicePersonality'

const names = (mode: Parameters<typeof voiceToolDefinitionsFor>[0]) => voiceToolDefinitionsFor(mode).map((tool) => tool.name)

describe('voice tool modes', () => {
    test('read-only sessions can only look things up', () => {
        expect(names('readonly')).toEqual(['askSessionStatus'])
    })

    test('assistant sessions draft and confirm instructions instead of sending directly', () => {
        expect(names('assistant')).toEqual(['processPermissionRequest', 'askSessionStatus', 'prepareInstruction', 'confirmInstruction'])
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
        expect(tools.map((tool) => tool.name)).toEqual(['askSessionStatus'])
    })

    test('the Gemini setup carries only the mode tools', () => {
        const msg = buildGeminiLiveSetupMessage(undefined, undefined, undefined, { toolMode: 'readonly' })
        const declarations = (msg.setup.tools as Array<{ functionDeclarations: Array<{ name: string }> }>)[0]!.functionDeclarations
        expect(declarations.map((tool) => tool.name)).toEqual(['askSessionStatus'])
    })
})

describe('voice prompt routing', () => {
    test('questions go to askSessionStatus and the old pass-it-through rule is gone', () => {
        const fixtures = getVoicePlatformFixturesPreview()
        expect(fixtures).toContain('MUST be answered by calling askSessionStatus')
        expect(fixtures).toContain('Never forward a question to the agent')
        expect(fixtures).not.toContain('If in doubt, pass it through')
        expect(fixtures).not.toContain('You MUST call the messageCodingAgent tool for ANY request')
    })

    test('the mode block tells the model what is turned off', () => {
        expect(buildVoiceToolModeBlock('readonly')).toContain('read-only')
        expect(buildVoiceToolModeBlock('assistant')).toContain('confirmInstruction')
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
