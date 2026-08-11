import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { ReasoningGroupView } from '../src/components/assistant-ui/reasoning-group'
import { I18nProvider } from '../src/lib/i18n-context'

// 复刻生产里的祖先链：reasoning 折叠块渲染在 AssistantMessage 的
// MessagePrimitive.Root 内。sticky 手柄的回归就出在这一层——一旦这个 root 用了
// overflow-x-hidden（而非 -clip），overflow-y 会计算成 auto，root 变成滚动容器，
// sticky 便吸在这个矮盒子上而不是聊天视口。fixture 必须带上这层包裹，否则测不到。
// 这里刻意复用 AssistantMessage 的类串，把「消息层用 -clip」这条不变量钉进 e2e。
const ASSISTANT_MESSAGE_ROOT_CLASS = 'px-1 min-w-0 max-w-full overflow-x-clip'

function App() {
    const [isOpen, setIsOpen] = useState(false)

    return (
        <I18nProvider>
            <main className="h-screen overflow-y-auto p-6" data-testid="scroll-viewport">
                <div className="h-[700px]" />
                <div className={ASSISTANT_MESSAGE_ROOT_CLASS} data-testid="assistant-message-root">
                    <ReasoningGroupView
                        isOpen={isOpen}
                        isStreaming={false}
                        onToggle={() => setIsOpen((open) => !open)}
                    >
                        <div className="h-[1800px]" data-testid="long-reasoning">Long reasoning</div>
                    </ReasoningGroupView>
                </div>
                <div className="h-[700px]" />
            </main>
        </I18nProvider>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
