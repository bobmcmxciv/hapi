import { describe, expect, it, vi } from 'vitest'
import { extractAgyGenerationsFromRows, resolveAgyTurnModels, resolveAgyTurnModelsFromRows, resolveAgyTurnMetadataFromRows } from './agyConversationModel'

function varint(value: number): Buffer {
    const bytes: number[] = []
    do {
        let byte = value & 0x7f
        value >>>= 7
        if (value) byte |= 0x80
        bytes.push(byte)
    } while (value)
    return Buffer.from(bytes)
}

function field(number: number, value: Uint8Array | string): Buffer {
    const data = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
    return Buffer.concat([varint((number << 3) | 2), varint(data.length), data])
}

function countField(number: number, value: number): Buffer {
    return Buffer.concat([varint(number << 3), varint(value)])
}

function step(idx: number, invocation: string, metadata = field(12, invocation)) {
    return { kind: 'step' as const, idx, data: metadata }
}

function generation(idx: number, invocation: string, model: string, data = Buffer.concat([
    field(1, field(21, model)),
    field(4, invocation),
])) {
    return { kind: 'generation' as const, idx, data }
}

describe('resolveAgyTurnModelsFromRows', () => {
    it('prefers the stable response model id over its optional display label', () => {
        const data = Buffer.concat([
            field(1, Buffer.concat([field(19, 'gemini-4-argon'), field(21, 'Gemini 4 Argon')])),
            field(4, 'inv'),
        ])
        expect(resolveAgyTurnModelsFromRows([1], [step(1, 'inv'), generation(1, 'inv', 'unused', data)]).get(1))
            .toBe('gemini-4-argon')
    })

    it('extracts per-generation tokens with the matching model; output already includes thinking', () => {
        const usage = Buffer.concat([
            countField(2, 2830), countField(3, 585), countField(5, 222865),
            countField(9, 151), countField(10, 434),
        ])
        const rows = [
            step(7, 'inv-a'),
            generation(30, 'inv-a', 'unused', Buffer.concat([
                field(1, Buffer.concat([field(19, 'gemini-4-argon'), field(4, usage)])),
                field(4, 'inv-a'),
            ])),
        ]
        expect(resolveAgyTurnMetadataFromRows([7], rows).get(7)).toEqual({
            model: 'gemini-4-argon',
            usageId: 'generation:30',
            usage: { input_tokens: 2830, output_tokens: 585, cache_creation_input_tokens: 0, cache_read_input_tokens: 222865 },
        })
    })

    it('keeps cache writes separate and matches multiple requests by ordinal', () => {
        const makeGen = (idx: number, model: string, input: number) => generation(idx, 'inv', model, Buffer.concat([
            field(1, Buffer.concat([
                field(19, model),
                field(4, Buffer.concat([countField(2, input), countField(3, 40), countField(4, 20), countField(5, 500)])),
            ])),
            field(4, 'inv'),
        ]))
        const turns = resolveAgyTurnMetadataFromRows([4, 8], [
            step(8, 'inv'), makeGen(20, 'model-b', 200),
            step(4, 'inv'), makeGen(10, 'model-a', 100),
        ])
        expect(turns.get(4)).toEqual({
            model: 'model-a',
            usageId: 'generation:10',
            usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 20, cache_read_input_tokens: 500 },
        })
        expect(turns.get(8)?.usage?.input_tokens).toBe(200)
        expect(turns.get(8)?.model).toBe('model-b')
    })

    it('uses explicit generation step links while the next response has no generation yet', () => {
        const data = Buffer.concat([
            field(1, Buffer.concat([field(19, 'gemini-4-argon'), field(4, countField(2, 100))])),
            field(2, Buffer.concat([varint(668), varint(669)])),
            field(4, 'inv'),
        ])
        const turns = resolveAgyTurnMetadataFromRows([668, 669, 670], [
            step(668, 'inv'), step(669, 'inv'), step(670, 'inv'),
            generation(246, 'inv', 'unused', data),
        ])
        expect(turns.get(668)?.usage?.input_tokens).toBe(100)
        expect(turns.get(668)?.usageId).toBe('generation:246')
        expect(turns.get(669)?.usageId).toBe('generation:246')
        expect(turns.get(670)).toBeNull()
    })

    it('does not use ordinal guesses for malformed or conflicting explicit step links', () => {
        const data = (indexes: Buffer) => Buffer.concat([
            field(1, field(19, 'model')), field(2, indexes), field(4, 'inv'),
        ])
        const rows = [step(1, 'inv'), generation(1, 'inv', 'unused', data(Buffer.from([0x80])))]
        expect(resolveAgyTurnMetadataFromRows([1], rows).get(1)).toBeNull()
        rows[1] = generation(1, 'inv', 'unused', data(varint(1)))
        rows.push(generation(2, 'inv', 'unused', data(varint(1))))
        expect(resolveAgyTurnMetadataFromRows([1], rows).get(1)).toBeNull()
    })

    it('does not invent usage for absent, empty, malformed or unsafe counters', () => {
        const invalid = [
            Buffer.alloc(0),
            Buffer.from([16, 0x80]),
            Buffer.concat([countField(2, 1), countField(2, 2), countField(3, 10)]),
            Buffer.concat([field(2, 'not a count'), countField(3, 10)]),
            Buffer.from([16, ...Array(9).fill(0xff), 1]),
        ]
        for (const usage of invalid) {
            const rows = [step(1, 'inv'), generation(1, 'inv', 'unused', Buffer.concat([
                field(1, Buffer.concat([field(19, 'model'), field(4, usage)])), field(4, 'inv'),
            ]))]
            expect(resolveAgyTurnMetadataFromRows([1], rows).get(1)?.usage).toBeNull()
        }
        expect(resolveAgyTurnMetadataFromRows([1], [step(1, 'inv'), generation(1, 'inv', 'model')]).get(1)?.usage).toBeNull()
    })

    it('reads the verified metadata.field12 and data.field4/data.field1.field21 wire paths', () => {
        const rows = [
            step(7, 'inv-a'),
            generation(30, 'inv-a', 'Gemini 3.5 Flash (Medium)'),
        ]

        expect(resolveAgyTurnModelsFromRows([7], rows)).toEqual(new Map([
            [7, 'Gemini 3.5 Flash (Medium)'],
        ]))
    })

    it('reads agy 1.4.x generation field 19 without losing old field 21 conversations', () => {
        const rows = [
            step(1, 'new-inv'),
            generation(0, 'new-inv', 'unused', Buffer.concat([
                field(1, field(19, 'claude-opus-5-5-medium')),
                field(4, 'new-inv'),
            ])),
            step(3, 'old-inv'),
            generation(1, 'old-inv', 'gemini-3.5-flash-medium'),
        ]
        expect(resolveAgyTurnModelsFromRows([1, 3], rows)).toEqual(new Map([
            [1, 'claude-opus-5-5-medium'],
            [3, 'gemini-3.5-flash-medium'],
        ]))
    })

    it('maps model switches across invocations instead of applying the latest generation to both', () => {
        const rows = [
            step(10, 'inv-old'),
            step(20, 'inv-new'),
            generation(100, 'inv-old', 'Claude Sonnet 4.6 (Thinking)'),
            generation(200, 'inv-new', 'Gemini 3.5 Pro (High)'),
        ]

        expect(resolveAgyTurnModelsFromRows([10, 20], rows)).toEqual(new Map([
            [10, 'Claude Sonnet 4.6 (Thinking)'],
            [20, 'Gemini 3.5 Pro (High)'],
        ]))
    })

    it('matches multiple generations in one invocation by ascending idx ordinal', () => {
        const rows = [
            step(40, 'inv-a'),
            step(20, 'inv-a'),
            generation(9, 'inv-a', 'second'),
            generation(3, 'inv-a', 'first'),
        ]

        expect(resolveAgyTurnModelsFromRows([40, 20], rows)).toEqual(new Map([
            [40, 'second'],
            [20, 'first'],
        ]))
    })

    it('does not guess when metadata is missing or invocation cardinality differs', () => {
        const rows = [
            { kind: 'step' as const, idx: 5, data: Buffer.alloc(0) },
            step(10, 'mismatch'),
            step(11, 'mismatch'),
            generation(30, 'mismatch', 'latest'),
        ]

        expect(resolveAgyTurnModelsFromRows([5, 10, 11], rows)).toEqual(new Map([
            [5, null],
            [10, null],
            [11, null],
        ]))
    })

    it('treats malformed and truncated protobuf as unknown without throwing', () => {
        const truncatedLength = Buffer.from([(12 << 3) | 2, 10, 0x61])
        const overflowingVarint = Buffer.from(Array(11).fill(0x80))
        const rows = [
            step(1, 'unused', truncatedLength),
            step(2, 'unused', overflowingVarint),
        ]

        expect(resolveAgyTurnModelsFromRows([1, 2], rows)).toEqual(new Map([
            [1, null],
            [2, null],
        ]))
    })
})

describe('resolveAgyTurnModels', () => {
    it('reads all rows through one batch query', async () => {
        const queryRows = vi.fn(async () => [
            step(1, 'inv-a'),
            generation(1, 'inv-a', 'model-a'),
        ])

        await expect(resolveAgyTurnModels('00000000-0000-4000-8000-000000000001', [1], queryRows)).resolves.toEqual(new Map([[1, 'model-a']]))
        expect(queryRows).toHaveBeenCalledTimes(1)
        expect(queryRows).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001')
    })

    it('returns unknown models when the database read fails', async () => {
        const queryRows = vi.fn(async () => { throw new Error('database is locked') })

        await expect(resolveAgyTurnModels('00000000-0000-4000-8000-000000000001', [1, 2], queryRows)).resolves.toEqual(new Map([
            [1, null],
            [2, null],
        ]))
    })

    it('rejects path traversal before invoking the database reader', async () => {
        const queryRows = vi.fn(async () => [])

        await expect(resolveAgyTurnModels('../../conversations/other', [1], queryRows)).resolves.toEqual(new Map([[1, null]]))
        expect(queryRows).not.toHaveBeenCalled()
    })
})

describe('ChatModelMetadata field 3 enum fallback', () => {
    it('falls back to the ChatModelMetadata enum when fields 19 and 21 are absent', () => {
        const usage = Buffer.concat([countField(2, 500), countField(3, 120)])
        const rows = [
            step(1, 'inv-enum'),
            generation(1, 'inv-enum', 'unused', Buffer.concat([
                field(1, Buffer.concat([countField(3, 1318), field(4, usage)])),
                field(4, 'inv-enum'),
            ])),
        ]
        expect(resolveAgyTurnMetadataFromRows([1], rows).get(1)).toEqual({
            model: 'gemini-3.8-flash',
            usageId: 'generation:1',
            usage: { input_tokens: 500, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        })
    })

    it('extractAgyGenerationsFromRows returns all non-zero generations sorted by idx with linked stepIndex', () => {
        const usage1 = Buffer.concat([countField(2, 500), countField(3, 120)])
        const usage2 = Buffer.concat([countField(2, 800), countField(3, 90), countField(5, 4000)])
        const rows = [
            step(3, 'inv-1'),
            generation(2, 'inv-2', 'unused', Buffer.concat([
                field(1, Buffer.concat([field(19, 'gemini-4-argon'), field(4, usage2)])),
                field(2, Buffer.concat([varint(7), varint(8)])),
                field(4, 'inv-2'),
            ])),
            generation(1, 'inv-1', 'unused', Buffer.concat([
                field(1, Buffer.concat([countField(3, 1318), field(4, usage1)])),
                field(4, 'inv-1'),
            ])),
        ]
        expect(extractAgyGenerationsFromRows(rows)).toEqual([
            {
                idx: 1,
                invocation: 'inv-1',
                model: 'gemini-3.8-flash',
                usage: { input_tokens: 500, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                usageId: 'generation:1',
                stepIndexes: null,
                stepIndex: 3,
            },
            {
                idx: 2,
                invocation: 'inv-2',
                model: 'gemini-4-argon',
                usage: { input_tokens: 800, output_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 },
                usageId: 'generation:2',
                stepIndexes: [7, 8],
                stepIndex: 7,
            },
        ])
    })
})
