import type { MultiUserGatewayStore } from './gatewayStore'
import { parseAccessToken } from '../../hub/src/utils/accessToken'
import { hashApiToken } from './token'

/**
 * 把 CLI 的 bearer token 解析成它所属账号的 namespace。
 *
 * 两种候选哈希，按序尝试：
 *
 * 1. **完整串** —— gateway 自己签发的 token（`hapi_mu_<base64url>`）就是这么存的。
 * 2. **剥掉 `:namespace` 后缀的 baseToken** —— 本 fork 的 pre-gateway 体系按
 *    baseToken 存哈希（见 migrateLegacyGateway 搬过来的那批），而 runner 侧配置
 *    的 `CLI_API_TOKEN` 允许带 `:<namespace>` 后缀。只按完整串比会让所有带后缀
 *    的历史 runner 在换芯后直接 401。
 *
 * 无论命中哪个，namespace 都取自**账号记录**而不是客户端给的后缀 —— 后缀只用于
 * 定位 token，不能自证身份。这条是 pre-gateway 时代就有的安全属性，别退化。
 *
 * base64url 字母表不含 `:`，所以两种 token 的取值空间不重叠，先后顺序不会误判。
 */
export function resolveGatewayCliNamespace(store: MultiUserGatewayStore, plaintextToken: string): string | null {
    const candidates = [plaintextToken]
    const parsed = parseAccessToken(plaintextToken)
    if (parsed && parsed.baseToken !== plaintextToken) candidates.push(parsed.baseToken)

    for (const candidate of candidates) {
        const token = store.getActiveTokenByHash(hashApiToken(candidate))
        if (!token) continue
        const account = store.getAccount(token.accountId)
        if (account && account.disabledAt === null) return account.defaultNamespace
    }
    return null
}
