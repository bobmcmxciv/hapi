import type { BlobStore } from './blobStore'
import type { GeneratedBlobFetcher } from './blobFetcher'

export { BlobStore } from './blobStore'
export type { BlobRecord } from './blobStore'
export { GeneratedBlobFetcher } from './blobFetcher'

/** What the web routes need to serve generated blobs from the hub's own disk. */
export type GeneratedBlobServices = {
    store: BlobStore
    fetcher: GeneratedBlobFetcher
    /** How long a download request waits on a running pull before answering 202. */
    pendingWaitMs?: number
}
