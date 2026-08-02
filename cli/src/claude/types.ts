/**
 * Schema validates fields used in the codebase and keeps explicit
 * log fields required by the CLI and UI.
 */

import { z } from "zod";

// Usage statistics for assistant messages - used in apiSession.ts
export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative().optional(),
  context_window: z.number().int().positive().optional(),
  cost_usd: z.number().nonnegative().optional(),
  service_tier: z.string().optional(),
});

// `passthrough` keeps fields the SDK adds going forward (e.g. `model`, future
// usage breakdowns) so the hub forwards them verbatim. Without it, Zod's
// default `strip` mode silently drops every undeclared key — the metadata
// pipeline lost `message.model` and `system/turn_duration.messageId` that way.
const RawMessageSchema = z.object({
  role: z.string().optional(),
  content: z.unknown(),
  usage: UsageSchema.optional(),
  model: z.string().optional(),
}).passthrough();

const RawJSONLinesBaseSchema = z.object({
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  isSidechain: z.boolean().optional(),
  // The tool_use id of the Agent/Task tool_use that spawned this sidechain
  // message, when present. Preserved (not just consumed) so downstream (web
  // tracer) can group sidechain messages directly by this id rather than
  // solely by exact-matching a sidechain root's prompt text.
  parentToolUseId: z.string().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  userType: z.string().optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  version: z.string().optional(),
  gitBranch: z.string().optional(),
  timestamp: z.string().optional(),
  providerMessageId: z.string().optional(),
});

// Main schema with validation for the fields used in the app
// NOTE: Schema remains lenient on message content to handle SDK variations
export const RawJSONLinesSchema = z.discriminatedUnion("type", [
  // User message - validates uuid and message.content
  RawJSONLinesBaseSchema.extend({
    type: z.literal("user"),
    uuid: z.string(),
    message: RawMessageSchema,
    mode: z.string().optional(),
    toolUseResult: z.unknown().optional(),
  }),

  // Assistant message - only validates uuid and type
  // message object is optional to handle synthetic error messages
  RawJSONLinesBaseSchema.extend({
    uuid: z.string(),
    type: z.literal("assistant"),
    message: RawMessageSchema.optional(),
    requestId: z.string().optional(),
  }),

  // Summary message - validates summary and leafUuid
  RawJSONLinesBaseSchema.extend({
    type: z.literal("summary"),
    summary: z.string(),
    leafUuid: z.string(),
  }),

  // Claude Code's native interactive CLI title event.
  RawJSONLinesBaseSchema.extend({
    type: z.literal("ai-title"),
    aiTitle: z.string(),
  }),

  // Token accounting frame, derived from the SDK `result` message.
  //
  // Needed because `usage` on an `assistant` message comes from the upstream's
  // `message_start`, and an OpenAI-compatible proxy cannot fill it in: those
  // upstreams only report usage at the *end* of the stream, so `message_start`
  // is necessarily zeroed and every assistant row for such a model records
  // 0 tokens. The `result` message is the only place the real counts appear.
  //
  // `modelUsage` is keyed by the SDK's raw model id (which may carry a context
  // variant suffix like "[1m]") and is a **running total for the SDK process,
  // not a per-turn figure** — a long-lived runner session reports cumulative
  // counts on every frame (measured live: 55931 → 111945 → 168046 across three
  // turns). Consumers must take deltas between adjacent frames of the same
  // session, treating a drop as a process restart; see
  // fork-features/usage/usageAggregate.ts.
  RawJSONLinesBaseSchema.extend({
    type: z.literal("usage_report"),
    uuid: z.string(),
    modelUsage: z.record(z.string(), z.object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cacheReadInputTokens: z.number().optional(),
      cacheCreationInputTokens: z.number().optional(),
    }).passthrough()),
  }),

  // System message - validates uuid and subtype data used by the UI.
  // `passthrough` preserves fields like `messageId` on `turn_duration` and any
  // future system subtype data the hub forwards to the web reducer.
  RawJSONLinesBaseSchema.extend({
    type: z.literal("system"),
    uuid: z.string(),
    subtype: z.string().optional(),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
    session_id: z.string().optional(),
    retryAttempt: z.number().optional(),
    maxRetries: z.number().optional(),
    error: z.unknown().optional(),
    durationMs: z.number().optional(),
    messageId: z.string().optional(),
  }).passthrough(),
]);

export type RawJSONLines = z.infer<typeof RawJSONLinesSchema>;
