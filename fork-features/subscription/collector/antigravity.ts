import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import type { SubscriptionSnapshot, SubscriptionWindow } from '../domain'

const execFileAsync = promisify(execFile)

type QuotaBucket = {
    id?: unknown
    name?: unknown
    remaining_fraction?: unknown
    reset_time?: unknown
}

type QuotaGroup = {
    name?: unknown
    buckets?: unknown
}

type UsageResult = {
    status?: unknown
    command?: { name?: unknown; data?: { groups?: unknown } }
}

/** Find the installed CLI without invoking a shell or reading its credentials. */
export function findAntigravityBinary(home = homedir(), env: NodeJS.ProcessEnv = process.env): string | null {
    const name = process.platform === 'win32' ? 'agy.exe' : 'agy'
    const candidates = [
        ...(process.platform === 'win32' ? [join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agy', 'bin', name)] : []),
        ...(env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir.replace(/^"|"$/g, ''), name))
    ]
    return candidates.find(candidate => existsSync(candidate)) ?? null
}

/** `/usage` is an official CLI command; print-mode JSON contains its unrounded quota buckets. */
export async function runAntigravityUsage(binary: string): Promise<string> {
    const { stdout } = await execFileAsync(binary, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8'
    })
    return stdout
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

export function convertAntigravityUsage(
    output: string,
    ctx: { machine: string; accountKey: string; reportedAt: number }
): SubscriptionSnapshot {
    const parsed = JSON.parse(output) as unknown
    const result = asRecord(parsed) as UsageResult | null
    const command = asRecord(result?.command)
    const data = asRecord(command?.data)
    if (result?.status !== 'SUCCESS' || command?.name !== 'usage' || !Array.isArray(data?.groups)) {
        throw new Error('agy /usage 响应格式无效')
    }

    const windows: SubscriptionWindow[] = []
    for (const rawGroup of data.groups) {
        const group = asRecord(rawGroup) as QuotaGroup | null
        if (!group || typeof group.name !== 'string' || !Array.isArray(group.buckets)) continue
        for (const rawBucket of group.buckets) {
            const bucket = asRecord(rawBucket) as QuotaBucket | null
            if (!bucket || typeof bucket.id !== 'string' || typeof bucket.name !== 'string'
                || typeof bucket.remaining_fraction !== 'number' || !Number.isFinite(bucket.remaining_fraction)) continue
            const remaining = Math.min(1, Math.max(0, bucket.remaining_fraction))
            const usedPercent = Math.round((1 - remaining) * 1000) / 10
            const resetAt = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN
            windows.push({
                key: `agy:${bucket.id}`,
                // Older web bundles show `used_percent` directly. The fallback label must
                // say "used" rather than blindly copying Google's "Remaining" bucket name.
                label: `${group.name} · ${bucket.name.replace(/\s+Remaining$/i, '')} · 已用`,
                used_percent: usedPercent,
                reset_at: Number.isFinite(resetAt) ? resetAt : null,
                severity: usedPercent >= 95 ? 'critical' : usedPercent >= 70 ? 'warning' : 'normal',
                is_active: false
            })
        }
    }
    if (windows.length === 0) throw new Error('agy /usage 未返回额度窗口')

    return {
        machine: ctx.machine,
        provider: 'antigravity',
        account_key: ctx.accountKey,
        plan_name: null,
        windows,
        balance: null,
        error: null,
        reported_at: ctx.reportedAt
    }
}

export async function collectAntigravity(
    ctx: { machine: string; now: () => number },
    binary: string,
    accountKey = 'default',
    runUsage: (binary: string) => Promise<string> = runAntigravityUsage
): Promise<SubscriptionSnapshot> {
    try {
        return convertAntigravityUsage(await runUsage(binary), {
            machine: ctx.machine, accountKey, reportedAt: ctx.now()
        })
    } catch (error) {
        // CLI stderr may contain private paths or account details. Never forward it to hub.
        const code = asRecord(error)?.code
        const message = code === 'ETIMEDOUT' ? 'agy /usage 超时'
            : error instanceof SyntaxError ? 'agy /usage 响应格式无效'
            : error instanceof Error && (
                error.message === 'agy /usage 响应格式无效' || error.message === 'agy /usage 未返回额度窗口'
            ) ? error.message
            : 'agy /usage 执行失败'
        return {
            machine: ctx.machine, provider: 'antigravity', account_key: accountKey,
            plan_name: null, windows: [], balance: null, error: message, reported_at: ctx.now()
        }
    }
}
