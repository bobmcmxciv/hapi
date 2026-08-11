import { logger } from '@/ui/logger'
import { readFile, stat, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { resolve } from 'path'
import type {
    FileReadResponse,
    FileWriteResponse,
    GeneratedBlobChunkRequest,
    GeneratedBlobChunkResponse,
    GeneratedFileResponse,
    GeneratedImageResponse
} from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { GENERATED_BLOB_CHUNK_BYTES } from '@hapi/protocol/socketLimits'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { getGeneratedImage } from '../generatedImages'
import { loadGeneratedFile, readGeneratedFileChunk } from '../generatedFiles'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface ReadFileRequest {
    path: string
}

type ReadFileResponse = FileReadResponse

interface ReadGeneratedImageRequest {
    id: string
}

type ReadGeneratedImageResponse = GeneratedImageResponse

interface ReadGeneratedFileRequest {
    id: string
}

type ReadGeneratedFileResponse = GeneratedFileResponse

interface WriteFileRequest {
    path: string
    content: string
    expectedHash?: string | null
}

export function registerFileHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>(RPC_METHODS.ReadFile, async (data) => {
        logger.debug('Read file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            const resolvedPath = resolve(workingDirectory, data.path)
            const buffer = await readFile(resolvedPath)
            const content = buffer.toString('base64')
            const hash = createHash('sha256').update(buffer).digest('hex')
            return { success: true, content, hash }
        } catch (error) {
            logger.debug('Failed to read file:', error)
            return rpcError(getErrorMessage(error, 'Failed to read file'))
        }
    })

    rpcHandlerManager.registerHandler<ReadGeneratedImageRequest, ReadGeneratedImageResponse>(RPC_METHODS.ReadGeneratedImage, async (data) => {
        logger.debug('Read generated image request:', data.id)

        const image = getGeneratedImage(data.id)
        if (!image) {
            return rpcError('Generated image not found')
        }

        try {
            return {
                success: true,
                content: image.content.toString('base64'),
                mimeType: image.mimeType,
                fileName: image.fileName
            }
        } catch (error) {
            logger.debug('Failed to read generated image:', error)
            return rpcError(getErrorMessage(error, 'Failed to read generated image'))
        }
    })

    rpcHandlerManager.registerHandler<ReadGeneratedFileRequest, ReadGeneratedFileResponse>(RPC_METHODS.ReadGeneratedFile, async (data) => {
        logger.debug('Read generated file request:', data.id)

        const file = await loadGeneratedFile(data.id)
        if (!file) {
            return rpcError('Sent file not found')
        }

        try {
            const buffer = await readFile(file.snapshotPath)
            return {
                success: true,
                content: buffer.toString('base64'),
                mimeType: file.mimeType,
                fileName: file.fileName,
                size: file.size
            }
        } catch (error) {
            logger.debug('Failed to read generated file:', error)
            return rpcError(getErrorMessage(error, 'Failed to read sent file'))
        }
    })

    // Ranged read shared by sent files and generated images/videos. The hub
    // prefers this over the whole-blob methods above so a large transfer is a
    // sequence of independently retryable slices rather than one frame that has
    // to clear a single fixed deadline.
    rpcHandlerManager.registerHandler<GeneratedBlobChunkRequest, GeneratedBlobChunkResponse>(
        RPC_METHODS.ReadGeneratedBlobChunk,
        async (data) => {
            const offset = Number.isFinite(data.offset) ? Math.max(0, Math.floor(data.offset)) : 0
            const requested = Number.isFinite(data.length) ? Math.floor(data.length) : GENERATED_BLOB_CHUNK_BYTES
            const length = Math.max(0, Math.min(requested, GENERATED_BLOB_CHUNK_BYTES))
            logger.debug('Read generated blob chunk request:', data.kind, data.id, offset, length)

            try {
                if (data.kind === 'image') {
                    const image = getGeneratedImage(data.id)
                    if (!image) {
                        return rpcError('Generated image not found')
                    }
                    const size = image.content.length
                    const start = Math.min(offset, size)
                    const slice = image.content.subarray(start, Math.min(start + length, size))
                    return {
                        success: true,
                        content: slice.toString('base64'),
                        offset: start,
                        size,
                        mimeType: image.mimeType,
                        fileName: image.fileName
                    }
                }

                const chunk = await readGeneratedFileChunk(data.id, offset, length)
                if (!chunk) {
                    return rpcError('Sent file not found')
                }
                return {
                    success: true,
                    content: chunk.bytes.toString('base64'),
                    offset: Math.min(offset, chunk.metadata.size),
                    size: chunk.metadata.size,
                    mimeType: chunk.metadata.mimeType,
                    fileName: chunk.metadata.fileName
                }
            } catch (error) {
                logger.debug('Failed to read generated blob chunk:', error)
                return rpcError(getErrorMessage(error, 'Failed to read generated blob'))
            }
        }
    )

    rpcHandlerManager.registerHandler<WriteFileRequest, FileWriteResponse>(RPC_METHODS.WriteFile, async (data) => {
        logger.debug('Write file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            const resolvedPath = resolve(workingDirectory, data.path)
            if (data.expectedHash !== null && data.expectedHash !== undefined) {
                try {
                    const existingBuffer = await readFile(resolvedPath)
                    const existingHash = createHash('sha256').update(existingBuffer).digest('hex')

                    if (existingHash !== data.expectedHash) {
                        return rpcError(`File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`)
                    }
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code !== 'ENOENT') {
                        throw error
                    }
                    return rpcError('File does not exist but hash was provided')
                }
            } else {
                try {
                    await stat(resolvedPath)
                    return rpcError('File already exists but was expected to be new')
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code !== 'ENOENT') {
                        throw error
                    }
                }
            }

            const buffer = Buffer.from(data.content, 'base64')
            await writeFile(resolvedPath, buffer)

            const hash = createHash('sha256').update(buffer).digest('hex')

            return { success: true, hash }
        } catch (error) {
            logger.debug('Failed to write file:', error)
            return rpcError(getErrorMessage(error, 'Failed to write file'))
        }
    })
}
