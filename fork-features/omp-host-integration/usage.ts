import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { RpcHandlerManager } from '../../cli/src/api/rpc/RpcHandlerManager'
import { buildOmpEnv, resolveOmpLaunchCommand } from '../../cli/src/omp/utils/config'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { ensureCx2ccUsageExtension } from './cx2ccUsageExtension'
import {
    OMP_USAGE_CACHE_MS,
    OMP_USAGE_NATIVE_TIMEOUT_MS,
    OMP_USAGE_MAX_OUTPUT_BYTES,
    OmpUsageLimitSchema,
    OmpUsageResponseSchema,
    type OmpUsageErrorCode,
    type OmpUsageLimit,
    type OmpUsageReport,
    type OmpUsageResponse
} from '@hapi/protocol/ompUsage'

const identityKeys = ['accountId', 'email', 'projectId', 'orgId'] as const
const rawScopeSchema = z.object({
    accountId: z.string().optional(), projectId: z.string().optional(), orgId: z.string().optional(),
    modelId: z.string().optional(), tier: z.string().optional(), shared: z.boolean().optional(), sharedGroup: z.string().optional()
})
const rawLimitSchema = z.object({
    id: z.string(), label: z.string(), scope: rawScopeSchema,
    window: OmpUsageLimitSchema.shape.window,
    amount: OmpUsageLimitSchema.shape.amount,
    status: OmpUsageLimitSchema.shape.status.optional()
})
const rawReportSchema = z.object({
    provider: z.string().min(1).max(256), fetchedAt: z.number().finite().nonnegative(),
    limits: z.array(rawLimitSchema).max(2048),
    metadata: z.record(z.string(), z.unknown()).optional()
})
const rawUsageSchema = z.object({
    generatedAt: z.number().finite().nonnegative(),
    reports: z.array(rawReportSchema).max(1024),
    accountsWithoutUsage: z.array(z.object({
        provider: z.string().min(1).max(256), accountId: z.string().optional(), email: z.string().optional(),
        projectId: z.string().optional(), orgId: z.string().optional()
    })).max(4096),
    disabledCredentials: z.array(z.unknown()).max(4096)
})

// Process-local secret: opaque identifiers cannot be reversed by hashing public emails.
const identitySecret = randomBytes(32)
function opaque(value: string): string {
    return createHmac('sha256', identitySecret).update(value).digest('hex').slice(0, 24)
}
function failure(errorCode: OmpUsageErrorCode): OmpUsageResponse {
    const messages: Record<OmpUsageErrorCode, string> = {
        unsupported: 'This OMP or Runner version does not support native usage.',
        unavailable: 'OMP native usage is unavailable on this machine.',
        timeout: 'OMP native usage exceeded its time budget.',
        output_limit: 'OMP native usage exceeded its output budget.',
        invalid_output: 'OMP native usage returned an invalid report.',
        command_failed: 'OMP native usage command failed.'
    }
    return { success: false, source: 'omp-native', errorCode, error: messages[errorCode] }
}

/** Select fields at the host boundary; raw, metadata, notes and identity never cross RPC. */
export function normalizeOmpUsage(raw: unknown): OmpUsageResponse {
    const parsed = rawUsageSchema.safeParse(raw)
    if (!parsed.success) return failure('invalid_output')
    const input = parsed.data
    const privateStrings = new Set<string>()
    for (const report of input.reports) {
        for (const key of identityKeys) {
            const value = report.metadata?.[key]
            if (typeof value === 'string' && value) privateStrings.add(value)
        }
        for (const limit of report.limits) {
            for (const key of ['accountId', 'projectId', 'orgId'] as const) {
                const value = limit.scope[key]
                if (value) privateStrings.add(value)
            }
        }
    }
    for (const account of input.accountsWithoutUsage) {
        for (const key of identityKeys) if (account[key]) privateStrings.add(account[key]!)
    }
    const identities = [...privateStrings].sort((a, b) => b.length - a.length)
    const safeText = (value: string): string => {
        let text = value.replace(/[\u0000-\u001f\u007f]/g, '')
        for (const identity of identities) text = text.split(identity).join('[account]')
        return text.replace(/[^\s@]+@[^\s@]+/g, '[account]').slice(0, 256)
    }
    const reports: OmpUsageReport[] = []
    const reportByAccount = new Map<string, OmpUsageReport>()
    // Store the snapshot alongside each pool: duplicates must not let old values
    // replace a newer upstream snapshot (or add the same pool's remaining twice).
    const shared = new Map<string, { limit: OmpUsageLimit; fetchedAt: number }>()
    const superseded = new Set<OmpUsageLimit>()
    for (const [reportIndex, report] of input.reports.entries()) {
        const identity = identityKeys.map(key => {
            const meta = report.metadata?.[key]
            const scoped = key === 'email' ? undefined : report.limits.find(limit => limit.scope[key])?.scope[key]
            return typeof meta === 'string' && meta ? meta : scoped ?? ''
        })
        const accountId = opaque(JSON.stringify([report.provider, identity.some(Boolean) ? identity : ['report', reportIndex]]))
        // Preserve report fetchedAt independently; never promote old limits to the
        // newest report/envelope timestamp when routing copies disagree.
        const reportKey = JSON.stringify([report.provider, accountId, report.fetchedAt])
        let output = reportByAccount.get(reportKey)
        if (!output) {
            output = { provider: safeText(report.provider), accountId, fetchedAt: report.fetchedAt, limits: [] }
            reportByAccount.set(reportKey, output)
            reports.push(output)
        }
        for (const [limitIndex, limit] of report.limits.entries()) {
            const group = limit.scope.sharedGroup
            const windowKey = limit.window?.id ?? ''
            const poolKey = group ? JSON.stringify([report.provider, accountId, windowKey, group]) : undefined
            const previous = poolKey ? shared.get(poolKey) : undefined
            if (previous && previous.fetchedAt >= report.fetchedAt) continue
            const normalized: OmpUsageLimit = {
                id: `limit-${reportIndex + 1}-${limitIndex + 1}`,
                label: safeText(limit.label),
                scope: {
                    ...(limit.scope.modelId ? { modelId: safeText(limit.scope.modelId) } : {}),
                    ...(limit.scope.tier ? { tier: safeText(limit.scope.tier) } : {}),
                    ...(limit.scope.shared !== undefined ? { shared: limit.scope.shared } : {}),
                    ...(group ? { sharedGroup: opaque(poolKey!) } : {})
                },
                ...(limit.window ? { window: { ...limit.window, id: safeText(limit.window.id), label: safeText(limit.window.label) } } : {}),
                amount: { ...limit.amount },
                status: limit.status ?? 'unknown'
            }
            if (previous) superseded.add(previous.limit)
            output.limits.push(normalized)
            if (poolKey) shared.set(poolKey, { limit: normalized, fetchedAt: report.fetchedAt })
        }
    }
    for (const report of reports) report.limits = report.limits.filter(limit => !superseded.has(limit))
    const response = {
        success: true as const,
        source: 'omp-native' as const,
        generatedAt: input.generatedAt,
        reports,
        accountsWithoutUsage: input.accountsWithoutUsage.map((account, index) => ({
            provider: safeText(account.provider),
            accountId: opaque(JSON.stringify([account.provider, identityKeys.map(key => account[key] ?? ''), index]))
        })),
        disabledCredentialCount: input.disabledCredentials.length
    }
    const result = OmpUsageResponseSchema.safeParse(response)
    return result.success ? result.data : failure('invalid_output')
}

export type OmpUsageCommand = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }

/** Only the child created here is killed; no process-name or machine-wide cleanup. */
export function readOmpUsageCommand(
    command: OmpUsageCommand,
    budgets: { timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<OmpUsageResponse> {
    const timeoutMs = Math.min(budgets.timeoutMs ?? OMP_USAGE_NATIVE_TIMEOUT_MS, OMP_USAGE_NATIVE_TIMEOUT_MS)
    const maxOutputBytes = Math.min(budgets.maxOutputBytes ?? OMP_USAGE_MAX_OUTPUT_BYTES, OMP_USAGE_MAX_OUTPUT_BYTES)
    const { promise, resolve } = Promise.withResolvers<OmpUsageResponse>()
    let done = false
    let bytes = 0
    const stdout: Buffer[] = []
    // Neither stderr nor exceptions are propagated: both can contain secrets.
    let diagnostics = ''
    let child: ChildProcess
    let timer: NodeJS.Timeout | undefined
    const finish = (result: OmpUsageResponse, kill = false) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (kill) { try { child.kill('SIGKILL') } catch { /* Already exited. */ } }
        resolve(result)
    }
    try {
        child = spawn(command.command, [...command.args, 'usage', '--json'], {
            cwd: command.cwd, env: command.env, shell: false, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        })
    } catch {
        finish(failure('unavailable'))
        return promise
    }
    const consume = (chunk: Buffer, isStdout: boolean) => {
        if (done) return
        bytes += chunk.length
        if (bytes > maxOutputBytes) { finish(failure('output_limit'), true); return }
        if (isStdout) stdout.push(chunk)
        else if (diagnostics.length < 8192) diagnostics += chunk.toString('utf8').slice(0, 8192 - diagnostics.length)
    }
    child.stdout?.on('data', (chunk: Buffer) => consume(chunk, true))
    child.stderr?.on('data', (chunk: Buffer) => consume(chunk, false))
    child.once('error', () => finish(failure('unavailable'), true))
    child.once('close', code => {
        if (done) return
        if (code !== 0) {
            const unsupported = /unknown (?:command|argument|option)|unrecognized (?:command|option)|usage.*not supported/i.test(diagnostics)
            finish(failure(unsupported ? 'unsupported' : 'command_failed'))
            return
        }
        try { finish(normalizeOmpUsage(JSON.parse(Buffer.concat(stdout).toString('utf8')))) }
        catch { finish(failure('invalid_output')) }
    })
    timer = setTimeout(() => finish(failure('timeout'), true), timeoutMs)
    timer.unref?.()
    return promise
}

export class OmpUsageReader {
    #inFlight: Promise<OmpUsageResponse> | undefined
    #cached: { at: number; response: OmpUsageResponse } | undefined

    constructor(
        private readonly fetchUsage: () => Promise<OmpUsageResponse>,
        private readonly now: () => number = Date.now
    ) { }

    read(): Promise<OmpUsageResponse> {
        if (this.#inFlight) return this.#inFlight
        if (this.#cached && this.now() - this.#cached.at < OMP_USAGE_CACHE_MS) return Promise.resolve(this.#cached.response)
        this.#inFlight = this.fetchUsage().catch(() => failure('unavailable')).then(response => {
            if (response.success) this.#cached = { at: this.now(), response }
            else this.#cached = undefined
            return response
        }).finally(() => { this.#inFlight = undefined })
        return this.#inFlight
    }
}

export function registerOmpUsageHandler(manager: RpcHandlerManager, options: { cwd: string }): void {
    const reader = new OmpUsageReader(async () => {
        try {
            const env = buildOmpEnv()
            try {
                await ensureCx2ccUsageExtension({ env })
            } catch {
                // Keep native usage operational for other providers if the extension directory is read-only or colliding.
            }
            const launch = resolveOmpLaunchCommand()
            return await readOmpUsageCommand({ ...launch, cwd: options.cwd, env })
        } catch {
            return failure('unavailable')
        }
    })
    manager.registerHandler<Record<string, never>, OmpUsageResponse>(RPC_METHODS.GetOmpUsage, () => reader.read())
}
