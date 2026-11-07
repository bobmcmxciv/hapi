import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { SubscriptionSnapshot, SubscriptionWindow } from '../domain'
import { apiKeySuffix, type CollectContext } from './adapters'

const DEVIN_GET_USER_STATUS_URL =
    'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus'
const DEFAULT_TIMEOUT_MS = 15_000

const WIRE_VARINT = 0
const WIRE_64BIT = 1
const WIRE_LENGTH_DELIMITED = 2
const WIRE_32BIT = 5

export type DevinPlanInfo = {
    teamsTier?: number
    planName?: string
    monthlyPromptCredits?: number
    monthlyFlowCredits?: number
    monthlyFlexCreditPurchaseAmount?: number
    billingStrategy?: number
    hideDailyQuota?: boolean
    hideWeeklyQuota?: boolean
}

export type DevinPlanStatus = {
    planInfo?: DevinPlanInfo
    planStartSeconds?: number
    planEndSeconds?: number
    availableFlexCredits?: number
    availablePromptCredits?: number
    availableFlowCredits?: number
    usedFlowCredits?: number
    usedPromptCredits?: number
    usedFlexCredits?: number
    dailyQuotaRemainingPercent?: number
    weeklyQuotaRemainingPercent?: number
    overageBalanceMicros?: number
    dailyQuotaResetAtUnix?: number
    weeklyQuotaResetAtUnix?: number
}

export type DevinUserStatus = {
    name?: string
    email?: string
    teamsTier?: number
    planStatus?: DevinPlanStatus
    userId?: string
}

export type DevinGetUserStatusResponse = {
    userStatus?: DevinUserStatus
    planInfo?: DevinPlanInfo
}

function encodeVarint(value: number | bigint): number[] {
    let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value))
    if (v < 0n) {
        v = BigInt.asUintN(64, v)
    }
    const out: number[] = []
    while (v > 0x7fn) {
        out.push(Number(v & 0x7fn) | 0x80)
        v >>= 7n
    }
    out.push(Number(v))
    return out
}

function encodeStringField(fieldNumber: number, value: string): Uint8Array {
    if (!value) return new Uint8Array(0)
    const strBytes = new TextEncoder().encode(value)
    const tag = encodeVarint((fieldNumber << 3) | WIRE_LENGTH_DELIMITED)
    const len = encodeVarint(strBytes.length)
    const out = new Uint8Array(tag.length + len.length + strBytes.length)
    out.set(tag, 0)
    out.set(len, tag.length)
    out.set(strBytes, tag.length + len.length)
    return out
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, c) => sum + c.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
        out.set(c, offset)
        offset += c.length
    }
    return out
}

/** Encode GetUserStatusRequest protobuf (field 1 = Metadata). */
export function encodeDevinGetUserStatusRequest(apiKey: string): Uint8Array {
    const metadataBytes = concatBytes([
        encodeStringField(1, 'devin-cli'),
        encodeStringField(2, '3000.11.3'),
        encodeStringField(3, apiKey),
        encodeStringField(4, 'en'),
        encodeStringField(5, process.platform === 'win32' ? 'windows' : process.platform),
        encodeStringField(7, '3000.11.3'),
        encodeStringField(12, 'chisel'),
        encodeStringField(28, 'chisel')
    ])
    const tag = encodeVarint((1 << 3) | WIRE_LENGTH_DELIMITED)
    const len = encodeVarint(metadataBytes.length)
    const out = new Uint8Array(tag.length + len.length + metadataBytes.length)
    out.set(tag, 0)
    out.set(len, tag.length)
    out.set(metadataBytes, tag.length + len.length)
    return out
}

type ProtoField = {
    fieldNumber: number
    wireType: number
    varint?: bigint
    bytes?: Uint8Array
}

function readVarint(buf: Uint8Array, offset: number): { value: bigint; nextOffset: number } {
    let result = 0n
    let shift = 0n
    let pos = offset
    while (pos < buf.length) {
        const byte = buf[pos]!
        pos += 1
        result |= BigInt(byte & 0x7f) << shift
        if ((byte & 0x80) === 0) {
            return { value: result, nextOffset: pos }
        }
        shift += 7n
        if (shift >= 64n) {
            throw new Error('Malformed protobuf varint')
        }
    }
    throw new Error('Unexpected EOF reading protobuf varint')
}

function parseProtoFields(buf: Uint8Array): ProtoField[] {
    const fields: ProtoField[] = []
    let offset = 0
    while (offset < buf.length) {
        const tag = readVarint(buf, offset)
        offset = tag.nextOffset
        const fieldNumber = Number(tag.value >> 3n)
        const wireType = Number(tag.value & 0x07n)
        if (fieldNumber <= 0) throw new Error('Invalid protobuf field number')
        if (wireType === WIRE_VARINT) {
            const v = readVarint(buf, offset)
            offset = v.nextOffset
            fields.push({ fieldNumber, wireType, varint: v.value })
        } else if (wireType === WIRE_64BIT) {
            if (offset + 8 > buf.length) throw new Error('Unexpected EOF reading 64-bit field')
            offset += 8
        } else if (wireType === WIRE_LENGTH_DELIMITED) {
            const len = readVarint(buf, offset)
            offset = len.nextOffset
            const byteLen = Number(len.value)
            if (byteLen < 0 || offset + byteLen > buf.length) {
                throw new Error('Unexpected EOF reading length-delimited field')
            }
            fields.push({ fieldNumber, wireType, bytes: buf.subarray(offset, offset + byteLen) })
            offset += byteLen
        } else if (wireType === WIRE_32BIT) {
            if (offset + 4 > buf.length) throw new Error('Unexpected EOF reading 32-bit field')
            offset += 4
        } else {
            throw new Error(`Unsupported protobuf wire type: ${wireType}`)
        }
    }
    return fields
}

function decodeUtf8(bytes: Uint8Array | undefined): string {
    return bytes ? new TextDecoder().decode(bytes) : ''
}

function toSignedInt(value: bigint | undefined): number {
    if (value === undefined) return 0
    return Number(BigInt.asIntN(64, value))
}

function decodeTimestampSeconds(bytes: Uint8Array | undefined): number | undefined {
    if (!bytes) return undefined
    for (const f of parseProtoFields(bytes)) {
        if (f.fieldNumber === 1 && f.wireType === WIRE_VARINT) {
            return toSignedInt(f.varint)
        }
    }
    return undefined
}

function decodePlanInfo(bytes: Uint8Array): DevinPlanInfo {
    const info: DevinPlanInfo = {}
    for (const f of parseProtoFields(bytes)) {
        if (f.fieldNumber === 1 && f.wireType === WIRE_VARINT) info.teamsTier = toSignedInt(f.varint)
        else if (f.fieldNumber === 2 && f.wireType === WIRE_LENGTH_DELIMITED) info.planName = decodeUtf8(f.bytes)
        else if (f.fieldNumber === 12 && f.wireType === WIRE_VARINT) info.monthlyPromptCredits = toSignedInt(f.varint)
        else if (f.fieldNumber === 13 && f.wireType === WIRE_VARINT) info.monthlyFlowCredits = toSignedInt(f.varint)
        else if (f.fieldNumber === 14 && f.wireType === WIRE_VARINT) info.monthlyFlexCreditPurchaseAmount = toSignedInt(f.varint)
        else if (f.fieldNumber === 35 && f.wireType === WIRE_VARINT) info.billingStrategy = toSignedInt(f.varint)
        else if (f.fieldNumber === 36 && f.wireType === WIRE_VARINT) info.hideDailyQuota = (f.varint ?? 0n) !== 0n
        else if (f.fieldNumber === 37 && f.wireType === WIRE_VARINT) info.hideWeeklyQuota = (f.varint ?? 0n) !== 0n
    }
    return info
}

function decodePlanStatus(bytes: Uint8Array): DevinPlanStatus {
    const status: DevinPlanStatus = {}
    for (const f of parseProtoFields(bytes)) {
        if (f.fieldNumber === 1 && f.wireType === WIRE_LENGTH_DELIMITED && f.bytes) status.planInfo = decodePlanInfo(f.bytes)
        else if (f.fieldNumber === 2 && f.wireType === WIRE_LENGTH_DELIMITED) status.planStartSeconds = decodeTimestampSeconds(f.bytes)
        else if (f.fieldNumber === 3 && f.wireType === WIRE_LENGTH_DELIMITED) status.planEndSeconds = decodeTimestampSeconds(f.bytes)
        else if (f.fieldNumber === 4 && f.wireType === WIRE_VARINT) status.availableFlexCredits = toSignedInt(f.varint)
        else if (f.fieldNumber === 5 && f.wireType === WIRE_VARINT) status.usedFlowCredits = toSignedInt(f.varint)
        else if (f.fieldNumber === 6 && f.wireType === WIRE_VARINT) status.usedPromptCredits = toSignedInt(f.varint)
        else if (f.fieldNumber === 7 && f.wireType === WIRE_VARINT) status.usedFlexCredits = toSignedInt(f.varint)
        else if (f.fieldNumber === 8 && f.wireType === WIRE_VARINT) status.availablePromptCredits = toSignedInt(f.varint)
        else if (f.fieldNumber === 9 && f.wireType === WIRE_VARINT) status.availableFlowCredits = toSignedInt(f.varint)
        else if (f.fieldNumber === 14 && f.wireType === WIRE_VARINT) status.dailyQuotaRemainingPercent = toSignedInt(f.varint)
        else if (f.fieldNumber === 15 && f.wireType === WIRE_VARINT) status.weeklyQuotaRemainingPercent = toSignedInt(f.varint)
        else if (f.fieldNumber === 16 && f.wireType === WIRE_VARINT) status.overageBalanceMicros = toSignedInt(f.varint)
        else if (f.fieldNumber === 17 && f.wireType === WIRE_VARINT) status.dailyQuotaResetAtUnix = toSignedInt(f.varint)
        else if (f.fieldNumber === 18 && f.wireType === WIRE_VARINT) status.weeklyQuotaResetAtUnix = toSignedInt(f.varint)
    }
    return status
}

function decodeUserStatus(bytes: Uint8Array): DevinUserStatus {
    const user: DevinUserStatus = {}
    for (const f of parseProtoFields(bytes)) {
        if (f.fieldNumber === 3 && f.wireType === WIRE_LENGTH_DELIMITED) user.name = decodeUtf8(f.bytes)
        else if (f.fieldNumber === 7 && f.wireType === WIRE_LENGTH_DELIMITED) user.email = decodeUtf8(f.bytes)
        else if (f.fieldNumber === 10 && f.wireType === WIRE_VARINT) user.teamsTier = toSignedInt(f.varint)
        else if (f.fieldNumber === 13 && f.wireType === WIRE_LENGTH_DELIMITED && f.bytes) user.planStatus = decodePlanStatus(f.bytes)
        else if (f.fieldNumber === 36 && f.wireType === WIRE_LENGTH_DELIMITED) user.userId = decodeUtf8(f.bytes)
    }
    return user
}

export function decodeDevinGetUserStatusResponse(bytes: Uint8Array): DevinGetUserStatusResponse {
    const res: DevinGetUserStatusResponse = {}
    for (const f of parseProtoFields(bytes)) {
        if (f.fieldNumber === 1 && f.wireType === WIRE_LENGTH_DELIMITED && f.bytes) {
            res.userStatus = decodeUserStatus(f.bytes)
        } else if (f.fieldNumber === 2 && f.wireType === WIRE_LENGTH_DELIMITED && f.bytes) {
            res.planInfo = decodePlanInfo(f.bytes)
        }
    }
    return res
}

function severityFor(percent: number): 'normal' | 'warning' | 'critical' {
    return percent >= 95 ? 'critical' : percent >= 70 ? 'warning' : 'normal'
}

/**
 * Auto-discover Devin session token from:
 * 1) Devin CLI credentials.toml (`%APPDATA%/devin/credentials.toml` or `~/.config/devin/credentials.toml`)
 * 2) OMP agent.db (`~/.omp/agent/agent.db` table `auth_credentials` where `provider = 'devin'`)
 */
export function readDevinToken(home = homedir(), env: NodeJS.ProcessEnv = process.env): string | null {
    const defaultHome = homedir()
    const appDataDir = home === defaultHome && env.APPDATA
        ? env.APPDATA
        : join(home, 'AppData', 'Roaming')
    const tomlCandidates = [
        join(appDataDir, 'devin', 'credentials.toml'),
        join(home, '.config', 'devin', 'credentials.toml')
    ]
    for (const candidate of tomlCandidates) {
        try {
            if (!existsSync(candidate)) continue
            const raw = readFileSync(candidate, 'utf8')
            const match = raw.match(/^\s*windsurf_api_key\s*=\s*(?:"([^"]+)"|'([^']+)')/m)
            const token = (match?.[1] ?? match?.[2])?.trim()
            if (token) return token
        } catch {
            // Try next candidate
        }
    }

    const ompDbPath = join(home, '.omp', 'agent', 'agent.db')
    if (existsSync(ompDbPath)) {
        let db: Database | null = null
        try {
            db = new Database(ompDbPath, { readonly: true })
            const row = db
                .query("SELECT json_extract(data, '$.access') AS access FROM auth_credentials WHERE provider = 'devin' AND disabled = 0 ORDER BY id DESC LIMIT 1")
                .get() as { access?: string | null } | null
            const token = row?.access?.trim()
            if (token) return token
        } catch {
            // Ignore sqlite errors
        } finally {
            try { db?.close() } catch { /* ignore */ }
        }
    }

    return null
}

export function convertDevinUserStatus(
    response: DevinGetUserStatusResponse,
    ctx: { machine: string; reportedAt: number; accountKey: string }
): SubscriptionSnapshot {
    const userStatus = response.userStatus
    const planStatus = userStatus?.planStatus
    const planInfo = planStatus?.planInfo ?? response.planInfo

    if (!userStatus && !planInfo) {
        return {
            machine: ctx.machine,
            provider: 'devin',
            account_key: ctx.accountKey,
            plan_name: null,
            windows: [],
            balance: null,
            error: 'Devin GetUserStatus 响应为空',
            reported_at: ctx.reportedAt
        }
    }

    const windows: SubscriptionWindow[] = []
    const billingStrategy = planInfo?.billingStrategy ?? 0
    const isQuotaPlan = billingStrategy === 2
        || planStatus?.dailyQuotaRemainingPercent !== undefined
        || planStatus?.weeklyQuotaRemainingPercent !== undefined
        || (planStatus?.dailyQuotaResetAtUnix ?? 0) > 0
        || (planStatus?.weeklyQuotaResetAtUnix ?? 0) > 0

    if (isQuotaPlan) {
        if (!planInfo?.hideDailyQuota && (planStatus?.dailyQuotaRemainingPercent !== undefined || (planStatus?.dailyQuotaResetAtUnix ?? 0) > 0)) {
            const remaining = Math.min(100, Math.max(0, planStatus?.dailyQuotaRemainingPercent ?? 100))
            const usedPercent = Math.round((100 - remaining) * 10) / 10
            const resetUnix = planStatus?.dailyQuotaResetAtUnix ?? 0
            windows.push({
                key: 'duration_1440',
                label: '24 小时窗口',
                used_percent: usedPercent,
                reset_at: resetUnix > 0 ? resetUnix * 1000 : null,
                severity: severityFor(usedPercent),
                is_active: true
            })
        }
        if (!planInfo?.hideWeeklyQuota && (planStatus?.weeklyQuotaRemainingPercent !== undefined || (planStatus?.weeklyQuotaResetAtUnix ?? 0) > 0)) {
            const remaining = Math.min(100, Math.max(0, planStatus?.weeklyQuotaRemainingPercent ?? 100))
            const usedPercent = Math.round((100 - remaining) * 10) / 10
            const resetUnix = planStatus?.weeklyQuotaResetAtUnix ?? 0
            windows.push({
                key: 'weekly',
                label: '周窗口',
                used_percent: usedPercent,
                reset_at: resetUnix > 0 ? resetUnix * 1000 : null,
                severity: severityFor(usedPercent),
                is_active: windows.length === 0
            })
        }
    }

    const resetAtCredits = (planStatus?.planEndSeconds ?? 0) > 0 ? (planStatus!.planEndSeconds! * 1000) : null
    const creditBuckets: Array<{ key: string; label: string; total?: number; available?: number; used?: number }> = [
        {
            key: 'prompt_credits',
            label: 'Prompt 额度',
            total: planInfo?.monthlyPromptCredits,
            available: planStatus?.availablePromptCredits,
            used: planStatus?.usedPromptCredits
        },
        {
            key: 'flow_credits',
            label: 'Flow 额度',
            total: planInfo?.monthlyFlowCredits,
            available: planStatus?.availableFlowCredits,
            used: planStatus?.usedFlowCredits
        }
    ]
    for (const bucket of creditBuckets) {
        const total = bucket.total ?? 0
        if (total <= 0) continue
        const used = bucket.used ?? (bucket.available !== undefined ? Math.max(0, total - bucket.available) : 0)
        const usedPercent = Math.min(100, Math.max(0, Math.round((used / total) * 1000) / 10))
        windows.push({
            key: bucket.key,
            label: bucket.label,
            used_percent: usedPercent,
            reset_at: resetAtCredits,
            severity: severityFor(usedPercent),
            is_active: windows.length === 0
        })
    }

    const rawPlanName = planInfo?.planName?.trim() || null
    const planName = rawPlanName
        ? (rawPlanName.toLowerCase().startsWith('devin') ? rawPlanName : `Devin ${rawPlanName}`)
        : 'Devin'
    const accountKey = userStatus?.email?.trim() || userStatus?.userId?.trim() || ctx.accountKey

    return {
        machine: ctx.machine,
        provider: 'devin',
        account_key: accountKey,
        plan_name: planName,
        windows,
        balance: null,
        error: null,
        reported_at: ctx.reportedAt
    }
}

export async function collectDevin(ctx: CollectContext, apiKey: string): Promise<SubscriptionSnapshot> {
    const accountKey = apiKeySuffix(apiKey)
    const controller = new AbortController()
    const cancel = setTimeout(() => controller.abort(), ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
        const body = encodeDevinGetUserStatusRequest(apiKey)
        const res = await ctx.fetchImpl(DEVIN_GET_USER_STATUS_URL, {
            method: 'POST',
            headers: {
                'content-type': 'application/proto',
                'connect-protocol-version': '1',
                accept: 'application/proto'
            },
            body,
            signal: controller.signal
        })
        if (!res.ok) {
            const hint = res.status === 401 || res.status === 403 ? '(凭据无效或过期)' : ''
            return {
                machine: ctx.machine,
                provider: 'devin',
                account_key: accountKey,
                plan_name: null,
                windows: [],
                balance: null,
                error: `HTTP ${res.status}${hint}`,
                reported_at: ctx.now()
            }
        }
        const bytes = new Uint8Array(await res.arrayBuffer())
        const decoded = decodeDevinGetUserStatusResponse(bytes)
        return convertDevinUserStatus(decoded, {
            machine: ctx.machine,
            reportedAt: ctx.now(),
            accountKey
        })
    } catch (err) {
        return {
            machine: ctx.machine,
            provider: 'devin',
            account_key: accountKey,
            plan_name: null,
            windows: [],
            balance: null,
            error: err instanceof Error ? err.message : String(err),
            reported_at: ctx.now()
        }
    } finally {
        clearTimeout(cancel)
    }
}
