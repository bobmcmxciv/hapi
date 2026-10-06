import type { MachineIconId } from '@hapi/protocol'

/** PATCH /api/machines/:id 的请求体：省略的字段不动，空串 / null 清掉。 */
export type MachinePresentationPatch = {
    displayName?: string
    icon?: MachineIconId | null
}
