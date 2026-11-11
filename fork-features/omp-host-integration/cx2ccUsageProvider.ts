// Kept as static TypeScript so installed extensions are independent of bundle symbol names.
export const CX2CC_USAGE_TIMEOUT_MS = 10_000;

export type Cx2ccConfiguredProviderCandidate = {
    providerId: string;
    baseUrl?: string;
    apiKey?: string;
};

export type Cx2ccUsageUnit = 'percent' | 'tokens' | 'requests' | 'credits' | 'usd' | 'minutes' | 'bytes' | 'unknown';
export type Cx2ccUsageStatus = 'ok' | 'warning' | 'exhausted' | 'unknown';

export type Cx2ccUsageWindow = {
    id: string;
    label: string;
    durationMs?: number;
    resetsAt?: number;
    resetLabel?: string;
};

export type Cx2ccUsageAmount = {
    unit: Cx2ccUsageUnit;
    used?: number;
    limit?: number;
    remaining?: number;
    usedFraction?: number;
    remainingFraction?: number;
};

export type Cx2ccUsageScope = {
    provider: string;
    accountId?: string;
    projectId?: string;
    orgId?: string;
    modelId?: string;
    tier?: string;
    windowId?: string;
    shared?: boolean;
    sharedGroup?: string;
};

export type Cx2ccUsageLimit = {
    id: string;
    label: string;
    scope: Cx2ccUsageScope;
    window?: Cx2ccUsageWindow;
    amount: Cx2ccUsageAmount;
    status?: Cx2ccUsageStatus;
    notes?: string[];
};

export type Cx2ccUsageResetCredits = {
    availableCount: number;
};

export type Cx2ccUsageReport = {
    provider: string;
    fetchedAt: number;
    limits: Cx2ccUsageLimit[];
    resetCredits?: Cx2ccUsageResetCredits;
    metadata?: Record<string, unknown>;
    raw?: unknown;
};

export type Cx2ccUsageCredential = {
    type: 'api_key' | 'oauth';
    apiKey?: string;
    accessToken?: string;
    accountId?: string;
    email?: string;
};

export type Cx2ccUsageFetchParams = {
    provider: string;
    credential: Cx2ccUsageCredential;
    accountKey?: string;
    baseUrl?: string;
    signal?: AbortSignal;
};

export type Cx2ccUsageFetchContext = {
    fetch: (input: string, init?: RequestInit) => Promise<Response>;
};

export type Cx2ccUsageProvider = {
    id: string;
    retainLastGoodOnFailure?: boolean;
    supports?: (params: Cx2ccUsageFetchParams) => boolean;
    fetchUsage: (params: Cx2ccUsageFetchParams, ctx: Cx2ccUsageFetchContext) => Promise<Cx2ccUsageReport | null>;
};

type ParsedWindow = {
    usedPercent?: number;
    limitWindowSeconds?: number;
    resetAfterSeconds?: number;
    resetAt?: number;
};

type ParsedCredits = {
    hasCredits?: boolean;
    unlimited?: boolean;
    overageLimitReached?: boolean;
    balance?: number;
};

function toFiniteNumber(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

export function isCx2ccProviderCandidate(providerId: string, baseUrl?: string): boolean {
    const normalizedId = providerId.trim().toLowerCase();
    if (!normalizedId) return false;
    if (normalizedId === 'cx2cc' || normalizedId.startsWith('cx2cc-') || normalizedId.startsWith('cx2cc_')) {
        return true;
    }
    const rawUrl = baseUrl?.trim();
    if (!rawUrl) return false;
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
        const host = parsed.hostname.toLowerCase();
        const pathLower = parsed.pathname.toLowerCase();
        return host === 'cx2cc'
            || host.startsWith('cx2cc.')
            || host.includes('.cx2cc.')
            || pathLower.includes('/cx2cc');
    } catch {
        return false;
    }
}

export function selectCx2ccProviderCandidates(providers: unknown): Cx2ccConfiguredProviderCandidate[] {
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];
    const matched: Cx2ccConfiguredProviderCandidate[] = [];
    for (const [providerId, config] of Object.entries(providers)) {
        let baseUrl: string | undefined;
        let apiKey: string | undefined;
        if (config && typeof config === 'object' && !Array.isArray(config)) {
            if ('baseUrl' in config && typeof config.baseUrl === 'string' && config.baseUrl.trim()) {
                baseUrl = config.baseUrl;
            }
            if ('apiKey' in config && typeof config.apiKey === 'string' && config.apiKey.trim()) {
                apiKey = config.apiKey;
            }
        }
        if (isCx2ccProviderCandidate(providerId, baseUrl)) {
            matched.push({
                providerId,
                ...(baseUrl !== undefined ? { baseUrl } : {}),
                ...(apiKey !== undefined ? { apiKey } : {})
            });
        }
    }
    return matched;
}

export function selectCx2ccProviderIds(providers: unknown): string[] {
    return selectCx2ccProviderCandidates(providers).map(candidate => candidate.providerId);
}

export function resolveCx2ccUsageEndpoint(baseUrl?: string): { url: string; origin: string } | null {
    const trimmed = baseUrl?.trim();
    if (!trimmed) return null;
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
        if (parsed.username || parsed.password) return null;
        const cleanPath = parsed.pathname.replace(/\/+$/, '');
        let usagePath: string;
        if (/\/usage$/i.test(cleanPath)) {
            usagePath = cleanPath;
        } else if (/\/api\/v1$/i.test(cleanPath)) {
            usagePath = `${cleanPath.slice(0, -'/v1'.length)}/usage`;
        } else if (/\/v1$/i.test(cleanPath)) {
            const prefix = cleanPath.slice(0, -'/v1'.length);
            usagePath = `${prefix || '/api'}/usage`;
        } else if (/\/api$/i.test(cleanPath)) {
            usagePath = `${cleanPath}/usage`;
        } else if (!cleanPath) {
            usagePath = '/api/usage';
        } else {
            usagePath = `${cleanPath}/usage`;
        }
        const target = new URL(parsed.origin);
        target.pathname = usagePath.startsWith('/') ? usagePath : `/${usagePath}`;
        return { url: target.toString(), origin: parsed.origin };
    } catch {
        return null;
    }
}

function parseWindow(raw: unknown): ParsedWindow | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    const rawUsedPercent = toFiniteNumber(record.used_percent);
    const usedPercent = rawUsedPercent !== undefined && rawUsedPercent >= 0 ? rawUsedPercent : undefined;
    const rawWindowSeconds = toFiniteNumber(record.limit_window_seconds);
    const limitWindowSeconds = rawWindowSeconds !== undefined && rawWindowSeconds > 0 ? rawWindowSeconds : undefined;
    const rawResetAfter = toFiniteNumber(record.reset_after_seconds);
    const resetAfterSeconds = rawResetAfter !== undefined && rawResetAfter >= 0 ? rawResetAfter : undefined;
    const rawResetAt = toFiniteNumber(record.reset_at);
    const resetAt = rawResetAt !== undefined && rawResetAt > 0 ? rawResetAt : undefined;
    if (
        usedPercent === undefined
        && limitWindowSeconds === undefined
        && resetAfterSeconds === undefined
        && resetAt === undefined
    ) {
        return undefined;
    }
    return { usedPercent, limitWindowSeconds, resetAfterSeconds, resetAt };
}

function parseCredits(raw: unknown): ParsedCredits | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    const hasCredits = typeof record.has_credits === 'boolean' ? record.has_credits : undefined;
    const unlimited = typeof record.unlimited === 'boolean' ? record.unlimited : undefined;
    const overageLimitReached = typeof record.overage_limit_reached === 'boolean' ? record.overage_limit_reached : undefined;
    const rawBalance = toFiniteNumber(record.balance);
    const balance = rawBalance !== undefined && rawBalance >= 0 ? rawBalance : undefined;
    if (
        hasCredits === undefined
        && unlimited === undefined
        && overageLimitReached === undefined
        && balance === undefined
    ) {
        return undefined;
    }
    return { hasCredits, unlimited, overageLimitReached, balance };
}

function hasPlanCreditOverage(credits: ParsedCredits | undefined, planLimitReached: boolean | undefined): boolean {
    if (planLimitReached !== true || !credits) return false;
    if (credits.overageLimitReached === true) return false;
    if (credits.unlimited === true) return true;
    if (credits.hasCredits !== true) return false;
    return credits.balance === undefined || credits.balance > 0;
}

function formatWindowDuration(seconds: number): { id: string; label: string; durationMs: number } {
    const durationMs = Math.round(seconds * 1000);
    const daySeconds = 86_400;
    if (seconds >= daySeconds) {
        const days = Math.max(1, Math.round(seconds / daySeconds));
        return { id: `${days}d`, label: `${days} ${days === 1 ? 'day' : 'days'}`, durationMs };
    }
    const hours = Math.max(1, Math.round(seconds / 3600));
    return { id: `${hours}h`, label: `${hours} ${hours === 1 ? 'hour' : 'hours'}`, durationMs };
}

function resolveResetTimeMs(window: ParsedWindow, nowMs: number): number | undefined {
    if (window.resetAt !== undefined) {
        const resetAtMs = window.resetAt > 1_000_000_000_000 ? window.resetAt : window.resetAt * 1000;
        if (Number.isFinite(resetAtMs) && resetAtMs > 0) return Math.round(resetAtMs);
    }
    if (window.resetAfterSeconds !== undefined) {
        const resetAtMs = nowMs + window.resetAfterSeconds * 1000;
        if (Number.isFinite(resetAtMs) && resetAtMs > 0) return Math.round(resetAtMs);
    }
    return undefined;
}

function buildUsageWindow(window: ParsedWindow, key: 'primary' | 'secondary', nowMs: number): Cx2ccUsageWindow {
    const resetsAt = resolveResetTimeMs(window, nowMs);
    if (window.limitWindowSeconds !== undefined) {
        const { id, label, durationMs } = formatWindowDuration(window.limitWindowSeconds);
        return { id, label, durationMs, ...(resetsAt !== undefined ? { resetsAt } : {}) };
    }
    return {
        id: key,
        label: key === 'primary' ? 'Primary window' : 'Secondary window',
        ...(resetsAt !== undefined ? { resetsAt } : {})
    };
}

function buildPercentAmount(window: ParsedWindow): Cx2ccUsageAmount {
    if (window.usedPercent === undefined) {
        return { unit: 'percent' };
    }
    const clamped = Math.min(Math.max(window.usedPercent, 0), 100);
    const usedFraction = clamped / 100;
    return {
        unit: 'percent',
        used: clamped,
        limit: 100,
        remaining: Math.max(0, 100 - clamped),
        usedFraction,
        remainingFraction: Math.max(0, 1 - usedFraction)
    };
}

function resolveWindowStatus(args: {
    usedFraction?: number;
    allowed?: boolean;
    limitReached?: boolean;
    creditOverage: boolean;
}): Cx2ccUsageStatus {
    const explicitlyAllowed = (args.creditOverage && args.limitReached === true)
        || (args.allowed === true && args.limitReached === false);
    const explicitlyBlocked = !args.creditOverage && (args.limitReached === true || args.allowed === false);
    if (args.usedFraction === undefined) {
        return explicitlyBlocked ? 'exhausted' : 'unknown';
    }
    if (args.usedFraction >= 1) {
        return explicitlyAllowed ? 'warning' : 'exhausted';
    }
    if (explicitlyBlocked) return 'exhausted';
    if (args.usedFraction >= 0.9) return 'warning';
    return 'ok';
}

function buildWindowLimit(args: {
    provider: string;
    key: 'primary' | 'secondary';
    window: ParsedWindow;
    accountId?: string;
    allowed?: boolean;
    limitReached?: boolean;
    creditOverage: boolean;
    nowMs: number;
}): Cx2ccUsageLimit {
    const usageWindow = buildUsageWindow(args.window, args.key, args.nowMs);
    const amount = buildPercentAmount(args.window);
    return {
        id: `${args.provider}:${args.key}`,
        label: usageWindow.label,
        scope: {
            provider: args.provider,
            ...(args.accountId ? { accountId: args.accountId } : {}),
            windowId: usageWindow.id,
            shared: true,
            sharedGroup: `cx2cc:${args.key}:${usageWindow.id}`
        },
        window: usageWindow,
        amount,
        status: resolveWindowStatus({
            usedFraction: amount.usedFraction,
            allowed: args.allowed,
            limitReached: args.limitReached,
            creditOverage: args.creditOverage
        })
    };
}

function buildCreditsLimit(args: {
    provider: string;
    credits: ParsedCredits;
    accountId?: string;
}): Cx2ccUsageLimit | null {
    const { credits } = args;
    if (credits.balance === undefined) return null;
    if (credits.hasCredits === false && credits.balance === 0 && credits.overageLimitReached !== true) {
        return null;
    }
    const exhausted = credits.overageLimitReached === true || (credits.unlimited !== true && credits.balance <= 0);
    return {
        id: `${args.provider}:credits`,
        label: 'Credits balance',
        scope: {
            provider: args.provider,
            ...(args.accountId ? { accountId: args.accountId } : {}),
            tier: 'credits',
            windowId: 'credits',
            shared: true,
            sharedGroup: 'cx2cc:credits'
        },
        window: {
            id: 'credits',
            label: 'Credits'
        },
        amount: {
            unit: 'credits',
            remaining: credits.balance
        },
        status: exhausted ? 'exhausted' : 'ok'
    };
}

function parseResetCredits(payload: Record<string, unknown>): Cx2ccUsageResetCredits | undefined {
    const block = payload.rate_limit_reset_credits;
    if (!block || typeof block !== 'object' || Array.isArray(block) || !('available_count' in block)) return undefined;
    const rawCount = toFiniteNumber(block.available_count);
    if (rawCount === undefined || rawCount < 0) return undefined;
    return { availableCount: Math.trunc(rawCount) };
}

export function parseCx2ccUsageReport(
    payload: unknown,
    options: {
        provider: string;
        accountKey?: string;
        nowMs?: number;
    }
): Cx2ccUsageReport | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isFinite(nowMs) || nowMs <= 0) return null;

    const rateLimit = record.rate_limit && typeof record.rate_limit === 'object' && !Array.isArray(record.rate_limit)
        ? (record.rate_limit as Record<string, unknown>)
        : undefined;
    const primary = rateLimit ? parseWindow(rateLimit.primary_window) : undefined;
    const secondary = rateLimit ? parseWindow(rateLimit.secondary_window) : undefined;
    const allowed = rateLimit && typeof rateLimit.allowed === 'boolean' ? rateLimit.allowed : undefined;
    const limitReached = rateLimit && typeof rateLimit.limit_reached === 'boolean' ? rateLimit.limit_reached : undefined;
    const credits = parseCredits(record.credits);
    const creditOverage = hasPlanCreditOverage(credits, limitReached);

    const email = typeof record.email === 'string' && record.email.trim() ? record.email.trim() : undefined;
    const planType = typeof record.plan_type === 'string' && record.plan_type.trim() ? record.plan_type.trim() : undefined;
    const accountId = email
        ?? (typeof options.accountKey === 'string' && options.accountKey.trim() ? options.accountKey.trim() : undefined);

    const limits: Cx2ccUsageLimit[] = [];
    if (primary) {
        limits.push(buildWindowLimit({
            provider: options.provider,
            key: 'primary',
            window: primary,
            accountId,
            allowed,
            limitReached,
            creditOverage,
            nowMs
        }));
    }
    if (secondary) {
        limits.push(buildWindowLimit({
            provider: options.provider,
            key: 'secondary',
            window: secondary,
            accountId,
            allowed,
            limitReached,
            creditOverage,
            nowMs
        }));
    }
    const creditsLimit = credits
        ? buildCreditsLimit({ provider: options.provider, credits, accountId })
        : null;
    if (creditsLimit) {
        limits.push(creditsLimit);
    }

    if (limits.length === 0) return null;

    const resetCredits = parseResetCredits(record);
    const effectiveAllowed = creditOverage && limitReached === true ? true : allowed;
    const effectiveLimitReached = creditOverage && limitReached === true ? false : limitReached;

    return {
        provider: options.provider,
        fetchedAt: nowMs,
        limits,
        ...(resetCredits ? { resetCredits } : {}),
        metadata: {
            ...(planType ? { planType } : {}),
            ...(email ? { email } : {}),
            ...(accountId ? { accountId } : {}),
            ...(effectiveAllowed !== undefined ? { allowed: effectiveAllowed } : {}),
            ...(effectiveLimitReached !== undefined ? { limitReached: effectiveLimitReached } : {})
        }
    };
}

export function createCx2ccUsageProvider(
    providerId: string,
    options: { now?: () => number; timeoutMs?: number } = {}
): Cx2ccUsageProvider {
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? CX2CC_USAGE_TIMEOUT_MS;

    return {
        id: providerId,
        retainLastGoodOnFailure: false,
        supports(params: Cx2ccUsageFetchParams): boolean {
            return params.provider === providerId
                && params.credential.type === 'api_key'
                && typeof params.credential.apiKey === 'string'
                && params.credential.apiKey.trim().length > 0
                && resolveCx2ccUsageEndpoint(params.baseUrl) !== null;
        },
        async fetchUsage(params: Cx2ccUsageFetchParams, ctx: Cx2ccUsageFetchContext): Promise<Cx2ccUsageReport | null> {
            if (params.provider !== providerId || params.credential.type !== 'api_key') return null;
            const apiKey = params.credential.apiKey?.trim();
            if (!apiKey) return null;
            const endpoint = resolveCx2ccUsageEndpoint(params.baseUrl);
            if (!endpoint) return null;

            const timeoutSignal = AbortSignal.timeout(timeoutMs);
            const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
            try {
                const response = await ctx.fetch(endpoint.url, {
                    method: 'GET',
                    headers: {
                        'x-api-key': apiKey,
                        accept: 'application/json'
                    },
                    redirect: 'error',
                    signal
                });
                if (response.status < 200 || response.status >= 300) {
                    try { await response.body?.cancel(); } catch { /* Ignore body cancel errors. */ }
                    return null;
                }
                if (response.url) {
                    const finalOrigin = new URL(response.url).origin;
                    if (finalOrigin !== endpoint.origin) return null;
                }
                const payload = await response.json();
                return parseCx2ccUsageReport(payload, {
                    provider: params.provider,
                    accountKey: params.accountKey,
                    nowMs: now()
                });
            } catch {
                return null;
            }
        }
    };
}
