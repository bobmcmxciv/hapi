import { z } from 'zod'

// One request always outlives its owned native child, never an unbounded runner job.
export const OMP_USAGE_NATIVE_TIMEOUT_MS = 20_000
export const OMP_USAGE_RPC_TIMEOUT_MS = 25_000
export const OMP_USAGE_CACHE_MS = 30_000
export const OMP_USAGE_MAX_AGE_MS = 15 * 60_000
export const OMP_USAGE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

const text = z.string().max(256)
const timestamp = z.number().finite().nonnegative()
const amount = z.number().finite().nonnegative()
export const OmpUsageLimitSchema = z.object({
    id: text,
    label: text,
    scope: z.object({
        modelId: text.optional(),
        tier: text.optional(),
        shared: z.boolean().optional(),
        sharedGroup: text.optional()
    }),
    window: z.object({
        id: text,
        label: text,
        durationMs: amount.optional(),
        resetsAt: timestamp.optional()
    }).optional(),
    amount: z.object({
        unit: z.enum(['percent', 'tokens', 'requests', 'credits', 'usd', 'minutes', 'bytes', 'unknown']),
        used: amount.optional(),
        limit: amount.optional(),
        remaining: amount.optional(),
        usedFraction: amount.optional(),
        remainingFraction: amount.optional()
    }),
    status: z.enum(['ok', 'warning', 'exhausted', 'unknown'])
})
export const OmpUsageReportSchema = z.object({
    provider: text,
    accountId: text,
    fetchedAt: timestamp,
    limits: z.array(OmpUsageLimitSchema).max(2048)
})
export const OmpUsageResponseSchema = z.discriminatedUnion('success', [
    z.object({
        success: z.literal(true),
        source: z.literal('omp-native'),
        generatedAt: timestamp,
        reports: z.array(OmpUsageReportSchema).max(1024),
        accountsWithoutUsage: z.array(z.object({ provider: text, accountId: text })).max(4096),
        disabledCredentialCount: z.number().int().nonnegative()
    }),
    z.object({
        success: z.literal(false),
        source: z.literal('omp-native'),
        errorCode: z.enum(['unsupported', 'unavailable', 'timeout', 'output_limit', 'invalid_output', 'command_failed']),
        error: z.string().max(256)
    })
])

export type OmpUsageLimit = z.infer<typeof OmpUsageLimitSchema>
export type OmpUsageReport = z.infer<typeof OmpUsageReportSchema>
export type OmpUsageResponse = z.infer<typeof OmpUsageResponseSchema>
export type OmpUsageErrorCode = Extract<OmpUsageResponse, { success: false }>['errorCode']

/** A new envelope is not proof that a provider fetched a new quota snapshot. */
export function getFreshOmpUsageReports(response: OmpUsageResponse, now = Date.now()): OmpUsageReport[] {
    if (!response.success) return []
    return response.reports.filter(report =>
        report.fetchedAt > 0 && report.fetchedAt <= now + 60_000 && now - report.fetchedAt < OMP_USAGE_MAX_AGE_MS
    ).map(report => ({
        ...report,
        limits: report.limits.filter(limit => limit.window?.resetsAt === undefined || limit.window.resetsAt > now)
    }))
}
