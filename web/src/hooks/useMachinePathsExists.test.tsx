import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import { useMachinePathsExists } from './useMachinePathsExists'

describe('useMachinePathsExists', () => {
    it('does not re-request when the caller passes a new array with the same paths', async () => {
        const checkMachinePathsExists = vi.fn(async (_machineId: string, paths: string[]) => ({
            exists: Object.fromEntries(paths.map((path) => [path, true]))
        }))
        const api = { checkMachinePathsExists } as unknown as ApiClient

        const { result, rerender } = renderHook(
            ({ paths }) => useMachinePathsExists(api, 'machine-1', paths),
            { initialProps: { paths: ['/a', '/b'] } }
        )
        await waitFor(() => expect(result.current.pathExistence).toEqual({ '/a': true, '/b': true }))

        rerender({ paths: ['/a', '/b'] })
        rerender({ paths: ['/a', '/b'] })
        expect(checkMachinePathsExists).toHaveBeenCalledTimes(1)

        rerender({ paths: ['/a', '/c'] })
        await waitFor(() => expect(checkMachinePathsExists).toHaveBeenCalledTimes(2))
        expect(checkMachinePathsExists).toHaveBeenLastCalledWith('machine-1', ['/a', '/c'])
    })
})
