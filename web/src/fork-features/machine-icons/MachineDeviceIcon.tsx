import type { ReactNode } from 'react'
import { isMachineIconId, type MachineIconId } from '@hapi/protocol'

/**
 * fork(machine-icons)：可为每台机器选择的设备外形图标。
 *
 * 系统图标（Windows / Apple / Linux）只能区分到「哪个 OS」，同一个人名下三台
 * Windows 在会话列表里长得一模一样。这里按设备形态给出一套线稿，选定后替换
 * 系统图标出现在机器筛选格、项目分组标题、会话页头等所有标注机器的地方。
 *
 * 线稿统一 24×24、currentColor 描边；Apple 系设备（iMac / Mac mini / MacBook /
 * iPad / iPhone）在通用外形里加一枚苹果标，和非 Apple 同类在小尺寸下也分得开。
 */

const APPLE_PATH = 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.031 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.56-1.702'

/** 以 (cx, cy) 为中心、高 size 的实心苹果标（原图 24 高）。 */
function AppleMark(props: { cx: number; cy: number; size: number }) {
    const k = props.size / 24
    return (
        <path
            d={APPLE_PATH}
            fill="currentColor"
            stroke="none"
            transform={`translate(${props.cx - 12 * k} ${props.cy - 12 * k}) scale(${k})`}
        />
    )
}

const GLYPHS: Record<MachineIconId, ReactNode> = {
    'rack-server': (
        <>
            <rect x="2.5" y="3" width="19" height="4" rx="1" />
            <rect x="2.5" y="10" width="19" height="4" rx="1" />
            <rect x="2.5" y="17" width="19" height="4" rx="1" />
            <path d="M6 5h.01M6 12h.01M6 19h.01M10.5 5h7M10.5 12h7M10.5 19h7" />
        </>
    ),
    workstation: (
        <>
            <rect x="6" y="2.5" width="12" height="19" rx="2" />
            <path d="M9.5 6.5h5M9.5 9.5h5" />
            <circle cx="12" cy="16" r="2" />
        </>
    ),
    desktop: (
        <>
            <rect x="2" y="4" width="13" height="10" rx="1.5" />
            <path d="M6 18.5h5M8.5 14v4.5" />
            <rect x="17.5" y="4" width="4.5" height="14.5" rx="1" />
            <path d="M19.75 7h.01" />
        </>
    ),
    'mini-pc': (
        <>
            <rect x="3" y="8" width="18" height="9" rx="2.5" />
            <path d="M6.75 12.5h.01M11 12.5h2M15.5 12.5h2" />
        </>
    ),
    imac: (
        <>
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M2 13.5h20M9.5 17l-.75 4h6.5l-.75-4" />
            <AppleMark cx={12} cy={8.4} size={6} />
        </>
    ),
    'mac-mini': (
        <>
            <rect x="3" y="3" width="18" height="18" rx="4.5" />
            <AppleMark cx={12} cy={12.2} size={8.5} />
        </>
    ),
    laptop: (
        <>
            <rect x="4.5" y="4.5" width="15" height="11" rx="1.5" />
            <path d="M2 19h20" />
        </>
    ),
    'gaming-laptop': (
        <>
            <rect x="4" y="4" width="16" height="11" rx="1" />
            <path d="M4 15 2 18.5v1h20v-1L20 15" />
            <path d="M12.75 6.5 10.5 10h3l-2.25 3.5" />
        </>
    ),
    macbook: (
        <>
            <rect x="4.5" y="4.5" width="15" height="11" rx="1.5" />
            <path d="M2 19h20" />
            <AppleMark cx={12} cy={10.2} size={6} />
        </>
    ),
    tablet: (
        <>
            <rect x="4.5" y="2.5" width="15" height="19" rx="2" />
            <path d="M11 18.5h2" />
        </>
    ),
    ipad: (
        <>
            <rect x="4.5" y="2.5" width="15" height="19" rx="2.5" />
            <AppleMark cx={12} cy={12.2} size={7} />
        </>
    ),
    phone: (
        <>
            <rect x="6.5" y="2" width="11" height="20" rx="2.5" />
            <path d="M12 5h.01M10.5 19h3" />
        </>
    ),
    iphone: (
        <>
            <rect x="6.5" y="2" width="11" height="20" rx="3" />
            <path d="M10.5 5h3" />
            <AppleMark cx={12} cy={12.6} size={6} />
        </>
    ),
    handheld: (
        <>
            <rect x="2" y="7" width="20" height="10" rx="3" />
            <rect x="7.5" y="9" width="9" height="6" rx="0.75" />
            <path d="M4.75 12h.01M19.25 12h.01" />
        </>
    ),
    nas: (
        <>
            <rect x="4" y="3" width="16" height="18" rx="2" />
            <rect x="7" y="6" width="4" height="9" rx="1" />
            <rect x="13" y="6" width="4" height="9" rx="1" />
            <path d="M8 18h.01M10.5 18h.01" />
        </>
    ),
    router: (
        <>
            <rect x="3" y="12" width="18" height="7" rx="2" />
            <path d="M7 12 5.5 5.5M17 12l1.5-6.5M7 15.5h.01M10 15.5h.01M13 15.5h.01" />
        </>
    ),
    'dev-board': (
        <>
            <rect x="5" y="5" width="14" height="14" rx="2" />
            <rect x="9" y="9" width="6" height="6" rx="1" />
            <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
        </>
    ),
    vm: (
        <>
            <path d="M17 7V5.5A1.5 1.5 0 0 0 15.5 4h-11A1.5 1.5 0 0 0 3 5.5v9A1.5 1.5 0 0 0 4.5 16H7" />
            <rect x="7" y="7" width="14" height="12" rx="1.5" />
            <path d="M7 10.5h14" />
        </>
    ),
    cloud: (
        <path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.5 4.5 0 0 1 0 9z" />
    )
}

/** 选择器里的排列（前置「跟随系统」后正好 4×5）：台式 → 笔记本 → 移动设备 → 网络/虚拟。 */
export const MACHINE_ICON_PICKER_ORDER: readonly MachineIconId[] = [
    'rack-server', 'workstation', 'desktop',
    'mini-pc', 'imac', 'mac-mini', 'laptop',
    'gaming-laptop', 'macbook', 'tablet', 'ipad',
    'phone', 'iphone', 'handheld', 'nas',
    'router', 'dev-board', 'vm', 'cloud'
]

/** 不认识的值（旧词表、手改的库）当作未设置，回落到系统图标。 */
export function resolveMachineIcon(value: unknown): MachineIconId | null {
    return isMachineIconId(value) ? value : null
}

export function machineIconLabelKey(icon: MachineIconId): string {
    return `machineIcon.${icon}`
}

export function MachineDeviceGlyph(props: { icon: MachineIconId; className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            {GLYPHS[props.icon]}
        </svg>
    )
}
