import type { BlobStore } from './blobStore'
import type { GeneratedBlobFetcher } from './blobFetcher'

export { BlobStore, BlobSessionMismatchError, isSafeBlobId } from './blobStore'
export type { BlobRecord } from './blobStore'
export { GeneratedBlobFetcher } from './blobFetcher'
export {
    DEFAULT_BLOB_DOWNLOAD_TICKET_TTL_MS,
    issueBlobDownloadTicket,
    parseBlobDownloadRoutePath,
    verifyBlobDownloadTicket,
    type BlobDownloadTicketClaims
} from './downloadTicket'

/** What the web routes need to serve generated blobs from the hub's own disk. */
export type GeneratedBlobServices = {
    store: BlobStore
    fetcher: GeneratedBlobFetcher
    /** How long a download request waits on a running pull before answering 202. */
    pendingWaitMs?: number
    /** How long a download/ticket request waits on an active push to finish before answering 202. */
    pushReadyWaitMs?: number
    /** Secret used to sign and verify short-lived single-file download tickets. */
    ticketSecret?: Uint8Array | string
    /** Ticket lifetime in milliseconds (defaults to 10 minutes). */
    ticketTtlMs?: number
}
