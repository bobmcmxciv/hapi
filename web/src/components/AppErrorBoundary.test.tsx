import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCrashGuardForTests, attachCrashReporter, type ClientErrorReport } from '@/lib/crashGuard'
import { AppErrorBoundary } from './AppErrorBoundary'

function Bomb(props: { armed: boolean }) {
    if (props.armed) {
        throw new Error('render exploded')
    }
    return <div>content alive</div>
}

describe('AppErrorBoundary', () => {
    beforeEach(() => {
        __resetCrashGuardForTests()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })
    afterEach(() => {
        vi.restoreAllMocks()
        __resetCrashGuardForTests()
    })

    it('渲染异常时展示兜底 UI（含错误信息与刷新出口）并上报', () => {
        const received: ClientErrorReport[] = []
        attachCrashReporter((report) => received.push(report))

        render(
            <AppErrorBoundary>
                <Bomb armed />
            </AppErrorBoundary>
        )

        expect(screen.getByText('界面出错了 · Something went wrong')).toBeInTheDocument()
        expect(screen.getByText(/render exploded/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Reload/ })).toBeInTheDocument()
        expect(received).toHaveLength(1)
        expect(received[0]).toMatchObject({ source: 'error-boundary', message: 'Error: render exploded' })
    })

    it('重试按钮清除错误态并重新渲染子树', () => {
        function Harness() {
            const [armed, setArmed] = useState(true)
            return (
                <>
                    <button type="button" onClick={() => setArmed(false)}>defuse</button>
                    <AppErrorBoundary>
                        <Bomb armed={armed} />
                    </AppErrorBoundary>
                </>
            )
        }
        render(<Harness />)
        expect(screen.getByText('界面出错了 · Something went wrong')).toBeInTheDocument()

        fireEvent.click(screen.getByText('defuse'))
        fireEvent.click(screen.getByRole('button', { name: /Retry/ }))

        expect(screen.getByText('content alive')).toBeInTheDocument()
        expect(screen.queryByText('界面出错了 · Something went wrong')).not.toBeInTheDocument()
    })

    it('无异常时透明传递子树', () => {
        render(
            <AppErrorBoundary>
                <Bomb armed={false} />
            </AppErrorBoundary>
        )
        expect(screen.getByText('content alive')).toBeInTheDocument()
    })
})
