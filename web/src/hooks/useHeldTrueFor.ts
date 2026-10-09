import { useEffect, useState } from 'react'

/** True once `flag` has stayed true for `ms` without interruption; resets when it turns false. */
export function useHeldTrueFor(flag: boolean, ms: number): boolean {
    const [elapsed, setElapsed] = useState(false)

    useEffect(() => {
        if (!flag) {
            setElapsed(false)
            return
        }
        const timer = setTimeout(() => setElapsed(true), ms)
        return () => clearTimeout(timer)
    }, [flag, ms])

    return flag && elapsed
}
