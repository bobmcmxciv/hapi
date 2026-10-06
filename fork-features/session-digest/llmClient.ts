/**
 * 摘要用的模型调用。走 Anthropic Messages 协议（cx2cc-gateway / cx2cc 都支持），
 * 非流式、单轮。地址与密钥来自 env：
 *   HAPI_DIGEST_API_URL  例如 http://172.17.0.1:13030/api/v1（拼 /messages、/models）
 *   HAPI_DIGEST_API_KEY  网关发的 chat scope key
 */

export type LlmConfig = {
    baseUrl: string
    apiKey: string
    fetchImpl?: typeof fetch
    timeoutMs?: number
}

export type LlmCall = (params: { model: string; system: string; prompt: string; maxTokens: number }) => Promise<string>

function headers(apiKey: string): Record<string, string> {
    return {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`
    }
}

export function createLlmCall(config: LlmConfig): LlmCall {
    const fetchImpl = config.fetchImpl ?? fetch
    const base = config.baseUrl.replace(/\/+$/, '')
    return async ({ model, system, prompt, maxTokens }) => {
        const response = await fetchImpl(`${base}/messages`, {
            method: 'POST',
            headers: headers(config.apiKey),
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                system,
                messages: [{ role: 'user', content: prompt }]
            }),
            signal: AbortSignal.timeout(config.timeoutMs ?? 180_000)
        })
        const raw = await response.text()
        if (!response.ok) {
            throw new Error(`LLM HTTP ${response.status}: ${raw.slice(0, 200)}`)
        }
        let body: unknown
        try {
            body = JSON.parse(raw)
        } catch {
            throw new Error(`LLM returned non-JSON: ${raw.slice(0, 200)}`)
        }
        const content = (body as { content?: unknown }).content
        if (!Array.isArray(content)) throw new Error('LLM response has no content')
        const text = content
            .map(block => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
                ? String((block as { text?: unknown }).text ?? '')
                : ''))
            .join('')
        if (!text.trim()) throw new Error('LLM returned empty text')
        return text
    }
}

export async function listLlmModels(config: LlmConfig): Promise<string[]> {
    const fetchImpl = config.fetchImpl ?? fetch
    const base = config.baseUrl.replace(/\/+$/, '')
    const response = await fetchImpl(`${base}/models`, {
        headers: headers(config.apiKey),
        signal: AbortSignal.timeout(config.timeoutMs ?? 15_000)
    })
    if (!response.ok) throw new Error(`models HTTP ${response.status}`)
    const body = await response.json() as { data?: Array<{ id?: unknown }> }
    return (body.data ?? [])
        .map(entry => (typeof entry.id === 'string' ? entry.id : null))
        .filter((id): id is string => id !== null)
}
