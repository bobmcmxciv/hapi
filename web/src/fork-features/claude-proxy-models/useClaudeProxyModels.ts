import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { registerClaudeProxyContextWindows } from '@/chat/modelConfig'
import { buildClaudeProxyModelOptions, claudeProxyContextWindows, type ClaudeProxyModelOption } from './claudeProxyModelOptions'
import type { ClaudeProxyModelSummary, ClaudeProxyModelsResponse } from './types'

export type ClaudeProxyModelsState = {
    /** hub 配了代理目录 URL。false 时调用方回落静态 CLAUDE_PROXY_MODEL_IDS。 */
    configured: boolean
    models: ClaudeProxyModelSummary[]
    /**
     * 选择器用的选项。`null` = 目录**不可用**（未配置 / 尚在加载 / 从未成功抓到），
     * 调用方保留静态清单；数组（可为空）= 目录权威，静态代理项应被它替换。
     */
    options: ClaudeProxyModelOption[] | null
    ids: string[]
    defaultModel: string | null
    isLoading: boolean
    /** 抓取失败（hub 或代理）；有旧快照时 models 仍非空。 */
    error: string | null
    stale: boolean
    fetchedAt: number | null
    source: string | null
    refetch: (force?: boolean) => void
}

const EMPTY_MODELS: ClaudeProxyModelSummary[] = []

/**
 * fork(claude-proxy-models)：Claude 会话可用的代理模型目录（hub `GET /api/claude-proxy-models`）。
 * 目录是全 hub 一份（不按机器），60s 内复用；窗口聚焦时重新校验。
 * 副作用：把代理声明的契约窗口注册进 modelConfig，状态栏分母据此取真值。
 */
export function useClaudeProxyModels(args: {
    api: ApiClient | null
    enabled?: boolean
}): ClaudeProxyModelsState {
    const { api } = args
    const enabled = Boolean(args.enabled !== false && api)
    const queryClient = useQueryClient()

    const query = useQuery({
        queryKey: queryKeys.claudeProxyModels,
        queryFn: async (): Promise<ClaudeProxyModelsResponse> => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getClaudeProxyModels()
        },
        enabled,
        staleTime: 60_000,
        refetchOnWindowFocus: true,
        retry: false,
    })

    const data = query.data
    const models = data?.models ?? EMPTY_MODELS
    const configured = data?.configured === true
    const fetchedAt = data?.fetchedAt ?? null
    const hasSnapshot = configured && fetchedAt !== null

    const options = useMemo(
        () => (hasSnapshot ? buildClaudeProxyModelOptions(models) : null),
        [hasSnapshot, models]
    )
    const ids = useMemo(() => models.map((model) => model.id), [models])

    useEffect(() => {
        if (hasSnapshot) {
            registerClaudeProxyContextWindows(claudeProxyContextWindows(models))
        }
    }, [hasSnapshot, models])

    const error = data?.error
        ?? (query.error instanceof Error
            ? query.error.message
            : query.error
                ? 'Failed to load proxy models'
                : null)

    return {
        configured,
        models,
        options,
        ids,
        defaultModel: data?.defaultModel ?? null,
        isLoading: enabled && query.isLoading,
        error,
        stale: data?.stale === true,
        fetchedAt,
        source: data?.source ?? null,
        refetch: (force = true) => {
            if (!api) return
            if (!force) {
                void query.refetch()
                return
            }
            // 强制刷新走 hub 的 ?refresh=1（跳过 hub 与代理两级 TTL），结果直接写进缓存。
            void api.getClaudeProxyModels(true)
                .then((fresh) => queryClient.setQueryData(queryKeys.claudeProxyModels, fresh))
                .catch(() => { void query.refetch() })
        }
    }
}
