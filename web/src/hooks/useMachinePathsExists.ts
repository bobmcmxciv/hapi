import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'

export function useMachinePathsExists(
    api: ApiClient,
    machineId: string | null,
    paths: string[]
): {
    pathExistence: Record<string, boolean>
    checkPathsExists: (pathsToCheck: string[]) => Promise<Record<string, boolean>>
} {
    const [pathExistence, setPathExistence] = useState<Record<string, boolean>>({})
    // Callers rebuild `paths` whenever the session list changes (every SSE update),
    // so key the request on the contents; an identity dependency re-sent the whole
    // batch to the machine on every update.
    const pathsKey = paths.join('\n')
    const stablePaths = useMemo(() => (pathsKey ? pathsKey.split('\n') : []), [pathsKey])

    useEffect(() => {
        setPathExistence({})
    }, [machineId])

    useEffect(() => {
        let cancelled = false

        if (!machineId || stablePaths.length === 0) {
            setPathExistence({})
            return () => {
                cancelled = true
            }
        }

        void api.checkMachinePathsExists(machineId, stablePaths)
            .then((result) => {
                if (cancelled) return
                setPathExistence(result.exists ?? {})
            })
            .catch(() => {
                if (cancelled) return
                setPathExistence({})
            })

        return () => {
            cancelled = true
        }
    }, [api, machineId, stablePaths])

    const checkPathsExists = useCallback(async (pathsToCheck: string[]) => {
        if (!machineId || pathsToCheck.length === 0) {
            return {}
        }

        const result = await api.checkMachinePathsExists(machineId, pathsToCheck)
        const exists = result.exists ?? {}
        setPathExistence((current) => ({ ...current, ...exists }))
        return exists
    }, [api, machineId])

    return {
        pathExistence,
        checkPathsExists,
    }
}
