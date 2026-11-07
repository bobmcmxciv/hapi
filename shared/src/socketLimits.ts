// Socket.IO carries RPC binary content as base64 inside a JSON envelope. Keep one MiB for
// the envelope and derive the largest raw payload that always fits below the configured cap.
export const SOCKET_MAX_HTTP_BUFFER_SIZE = 48 * 1024 * 1024
export const SOCKET_RPC_FRAMING_HEADROOM_BYTES = 1024 * 1024
export const MAX_SOCKET_RPC_BINARY_BYTES = Math.floor(
    (SOCKET_MAX_HTTP_BUFFER_SIZE - SOCKET_RPC_FRAMING_HEADROOM_BYTES) * 3 / 4
)

/**
 * Slice size for chunked generated-blob reads.
 *
 * Sending a whole blob in one ack frame is what made large downloads fail: the
 * RPC budget is a fixed 30s regardless of size, so a 14 MB file (≈18.7 MB once
 * base64'd) had to clear the CLI↔hub link inside that window or the request was
 * lost outright. Measured on the production hub between 2026-08-01 and 08-12,
 * 52 downloads returned `404` after exactly `30s` — every one of them a timeout
 * being reported as a missing file.
 *
 * 2 MiB keeps each frame ~2.7 MiB base64 (far below the 48 MiB socket cap) and
 * needs only ~35 KB/s to clear the per-chunk budget, versus the ~640 KB/s a
 * 14 MB single-shot transfer needed. Chunks are also individually retryable,
 * so one stalled slice no longer voids the whole download.
 */
export const GENERATED_BLOB_CHUNK_BYTES = 2 * 1024 * 1024

/**
 * Slice size the **hub requests** when it pulls a blob from a CLI (the legacy
 * pull path, kept for envelopes whose bytes were never pushed to the hub).
 *
 * 2 MiB per frame was the second failure mode on slow uplinks: a 2.8 MB base64
 * frame took 40-60 s to clear a 50 KB/s link, so the socket.io pong queued
 * behind it missed the 20 s ping deadline and the CLI socket was dropped
 * mid-transfer (measured on vircs: 27% of chunk reads were followed by a
 * `transport close` within 60 s, against an 8% baseline). 256 KiB clears the
 * same link in ~7 s. CLIs clamp to `GENERATED_BLOB_CHUNK_BYTES` at most and
 * honour smaller requests, so this needs no CLI upgrade.
 */
export const GENERATED_BLOB_PULL_CHUNK_BYTES = 256 * 1024

/**
 * Slice size the CLI pushes to the hub over HTTP when a blob is sent.
 *
 * 2 MiB reduces HTTP stop-and-wait round-trips and hub sidecar fsyncs by 4x
 * compared to 512 KiB while staying well within the hub's 4 MiB per-slice
 * ceiling (`MAX_GENERATED_BLOB_UPLOAD_CHUNK_BYTES`) and keeping per-slice
 * memory bounded.
 */
export const GENERATED_BLOB_UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024
export const MIN_GENERATED_BLOB_UPLOAD_CHUNK_BYTES = 64 * 1024
export const MAX_GENERATED_BLOB_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Largest blob the hub accepts into its store (push or pull), and the maximum
 * snapshot size for `send_file` (~35.25 MiB = `MAX_SOCKET_RPC_BINARY_BYTES`,
 * derived from the 48 MiB Socket.IO frame ceiling so legacy base64 RPC fallback
 * remains compatible; inline `display_image`/`display_video` are capped
 * separately at 25 MiB in `generatedImages.ts`).
 */
export const MAX_GENERATED_BLOB_BYTES = MAX_SOCKET_RPC_BINARY_BYTES

/**
 * Default WebRTC DataChannel payload slice size (16 KiB).
 * Kept well below the 64 KiB cross-browser SCTP message ceiling and distinct
 * from the 2 MiB HTTP upload slice size.
 */
export const P2P_DATACHANNEL_DEFAULT_CHUNK_BYTES = 16 * 1024
export const P2P_DATACHANNEL_MAX_CHUNK_BYTES = 64 * 1024
/** Maximum unacknowledged bytes in flight on a P2P DataChannel before pausing reads. */
export const P2P_DATACHANNEL_WINDOW_BYTES = 256 * 1024
/** Bounded P2P negotiation + first-chunk window before automatic fallback to Hub download. */
export const P2P_NEGOTIATION_TIMEOUT_MS = 10_000
/** Lifetime of a P2P transfer authorization session (renewable while active). */
export const P2P_TRANSFER_TTL_MS = 5 * 60 * 1000
/** Max concurrent P2P direct file transfers per CLI session. */
export const P2P_MAX_CONCURRENT_TRANSFERS_PER_SESSION = 2
