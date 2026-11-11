import { useLayoutEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { setMessageWindowScope } from '@/lib/message-window-store'
import { setQueuedOutboxScope } from '@/lib/queued-outbox'

/** Never paint a previous account's cached query/window while new credentials hydrate. */
export function BetaIdentityBoundary(props: { scope: string; children: ReactNode }) {
    const queryClient = useQueryClient()
    const [readyScope, setReadyScope] = useState<string | null>(null)
    useLayoutEffect(() => {
        // The durable send outbox is scoped on every build (beta and prod):
        // two accounts on one hub origin must never read each other's
        // pending input.
        setQueuedOutboxScope(props.scope)
        setMessageWindowScope(props.scope)
        queryClient.clear()
        setReadyScope(props.scope)
    }, [props.scope, queryClient])
    if (readyScope !== props.scope) {
        return <div role="status" className="flex h-full items-center justify-center text-sm">正在准备账号环境…</div>
    }
    return props.children
}
