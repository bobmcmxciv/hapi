import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { asString, isObject, safeStringify } from '@hapi/protocol'
import type { DecryptedMessage } from '@/types/api'
import type { NormalizedMessage } from '@/chat/types'
import { isCodexContent, isSkippableAgentContent, normalizeAgentRecord } from '@/chat/normalizeAgent'
import { normalizeUserRecord } from '@/chat/normalizeUser'

/**
 * `output/tool_progress`、`agent-message/xxx` —— 外层信封类型 + 内层 payload 类型，
 * 用来给不认识的消息取一个能一眼看出「这是什么」的短标签。
 */
function describePayloadType(content: unknown): string | null {
 if (!isObject(content)) return null
 const outer = asString(content.type)
 const data = isObject(content.data) ? content.data : null
 const inner = data ? asString(data.type) : null
 if (outer && inner) return `${outer}/${inner}`
 return inner ?? outer
}

/**
 * 兜底：agent 侧出现了 normalizer 不认识的 payload。
 *
 * 纯字符串是正常的 agent 文本（hub 直接塞的消息就是这个形状），照旧当文本渲染。
 *
 * 结构化 payload 则以前直接整个 `safeStringify` 成一条 agent 文本消息，于是会话流里
 * 会糊出一大段原始 JSON（Claude 新增 `tool_progress` 心跳时就是这么炸的）。现在改成
 * 一条折叠的系统提示：平时只占一行灰字，需要排查时能展开看到原始 JSON —— 既不丢数据，
 * 也不会再毁掉整个会话的排版。
 */
function unsupportedPayloadMessage(
 message: DecryptedMessage,
 content: unknown,
 meta?: unknown
): NormalizedMessage {
 if (typeof content === 'string') {
  return {
   id: message.id,
   localId: message.localId,
   createdAt: message.createdAt,
   role: 'agent',
   isSidechain: false,
   content: [{ type: 'text', text: content, uuid: message.id, parentUUID: null }],
   meta,
   status: message.status,
   originalText: message.originalText,
   invokedAt: message.invokedAt
  }
 }

 return {
  id: message.id,
  localId: message.localId,
  createdAt: message.createdAt,
  role: 'event',
  isSidechain: false,
  content: {
   type: 'unsupported-payload',
   payloadType: describePayloadType(content),
   payload: safeStringify(content)
  },
  meta,
  invokedAt: message.invokedAt
 }
}

function runtimeMessageMeta(content: unknown, meta: unknown): unknown {
 if (!isObject(content) || content.type !== 'output' || !isObject(content.data)) return meta
 const data = content.data
 if (typeof data.uuid !== 'string' || data.type !== 'assistant') return meta
 return {
  ...(isObject(meta) ? meta : meta === undefined ? {} : { runtimeOriginalMeta: meta }),
  runtimeCanonicalId: data.uuid,
  ...(typeof data.runId === 'string' ? { runtimeRunId: data.runId } : {}),
  ...(typeof data.stopReason === 'string' ? { runtimeStopReason: data.stopReason } : {}),
  ...(typeof data.errorMessage === 'string' ? { runtimeErrorMessage: data.errorMessage } : {}),
 }
}

export function normalizeDecryptedMessage(message: DecryptedMessage): NormalizedMessage | null {
 const record = unwrapRoleWrappedRecordEnvelope(message.content)
 if (!record) {
  return unsupportedPayloadMessage(message, message.content)
 }

 if (record.role === 'user') {
  const normalized = normalizeUserRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
  return normalized
   ? { ...normalized, status: message.resolution ? 'sent' : message.status, originalText: message.originalText, invokedAt: message.resolution ? null : message.invokedAt, resolution: message.resolution }
   : {
    id: message.id,
    localId: message.localId,
    createdAt: message.createdAt,
    role: 'user',
    isSidechain: false,
    content: { type: 'text', text: safeStringify(record.content) },
    meta: record.meta,
    status: message.resolution ? 'sent' : message.status,
    originalText: message.originalText,
    invokedAt: message.resolution ? null : message.invokedAt,
    resolution: message.resolution
   }
 }
 if (record.role === 'agent') {
  if (isSkippableAgentContent(record.content)) {
   return null
  }
  const normalized = normalizeAgentRecord(message.id, message.localId, message.createdAt, record.content, runtimeMessageMeta(record.content, record.meta))
  if (!normalized && isCodexContent(record.content)) {
   return null
  }
  return normalized
   ? { ...normalized, status: message.status, originalText: message.originalText, invokedAt: message.invokedAt }
   : unsupportedPayloadMessage(message, record.content, record.meta)
 }

 return unsupportedPayloadMessage(message, record.content, record.meta)
}
