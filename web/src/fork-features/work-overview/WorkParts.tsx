import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'
import { MachineOsIcon } from '@/components/machinePresentation'
import type { MainlineView, WorkModel, WorkStatus } from './deriveWork'
import { newLineId, useWorkActions } from './workApi'
import './workOverview.css'

const DAY_MS = 86_400_000

const STATUS_VARS: Record<WorkStatus, { bg: string; fg: string; accent: string }> = {
    push: { bg: 'var(--wo-push-bg)', fg: 'var(--wo-push-fg)', accent: 'var(--wo-push)' },
    slow: { bg: 'var(--wo-slow-bg)', fg: 'var(--wo-slow-fg)', accent: 'var(--wo-slow)' },
    stall: { bg: 'var(--wo-stall-bg)', fg: 'var(--wo-stall-fg)', accent: 'var(--wo-stall)' }
}

/** 卡片左侧色条：随业务状态变色。 */
export function statusAccentStyle(status: WorkStatus): CSSProperties {
    return { '--wo-accent': STATUS_VARS[status].accent } as CSSProperties
}

/** 业务状态（由最近活动日期推出）；与会话进程的运行状态分开表达。 */
export function StatusBadge(props: { status: WorkStatus; className?: string }) {
    const { t } = useTranslation()
    const vars = STATUS_VARS[props.status]
    return (
        <span
            className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-px text-[11px] font-medium', props.className)}
            style={{ background: vars.bg, color: vars.fg }}
        >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: vars.accent }} />
            {t(`work.status.${props.status}`)}
        </span>
    )
}

/** 项目摘要给出的阶段（开发中 / 试运行 / 已上线…），原样显示。 */
export function StageBadge(props: { stage: string | null | undefined; className?: string }) {
    if (!props.stage) return null
    const stage = props.stage
    const style = /上线|维护|完成/.test(stage)
        ? { background: 'var(--app-badge-success-bg)', color: 'var(--app-badge-success-text)' }
        : /试运行/.test(stage)
            ? { background: 'var(--wo-slow-bg)', color: 'var(--wo-slow-fg)' }
            : /停滞/.test(stage)
                ? { background: 'var(--wo-stall-bg)', color: 'var(--wo-stall-fg)' }
                : { background: 'var(--wo-push-bg)', color: 'var(--wo-push-fg)' }
    return <span className={cn('inline-flex shrink-0 items-center rounded-md px-1.5 py-px text-[10px] font-medium', props.className)} style={style}>{stage}</span>
}

/** 阶段的小圆点（矩阵里的目录格子用，省地方）。 */
export function stageDotColor(stage: string | null | undefined): string {
    if (!stage) return 'var(--wo-stall)'
    if (/上线|维护|完成/.test(stage)) return 'var(--app-badge-success-text)'
    if (/试运行/.test(stage)) return 'var(--wo-slow)'
    if (/停滞/.test(stage)) return 'var(--wo-stall)'
    return 'var(--wo-push)'
}

/** 会话进程状态：在跑 / 正在生成。 */
export function RunDot(props: { active: boolean; thinking?: boolean; className?: string }) {
    return (
        <span
            className={cn('inline-block h-2 w-2 shrink-0 rounded-full', props.className)}
            style={{
                background: props.active ? 'var(--wo-run)' : 'var(--wo-heat-0)',
                boxShadow: props.thinking ? '0 0 0 3px var(--wo-run-glow)' : props.active ? undefined : 'inset 0 0 0 1px var(--app-border)'
            }}
        />
    )
}

export function NeedBadge(props: { children: ReactNode }) {
    return (
        <span className="inline-flex shrink-0 items-center rounded-full px-2 py-px text-[11px] font-medium" style={{ background: 'var(--wo-need-bg)', color: 'var(--wo-need)' }}>
            {props.children}
        </span>
    )
}

export function heatColor(n: number): string {
    return n <= 0 ? 'var(--wo-heat-0)' : n === 1 ? 'var(--wo-heat-1)' : n === 2 ? 'var(--wo-heat-2)' : n === 3 ? 'var(--wo-heat-3)' : 'var(--wo-heat-4)'
}

/** 一排小方格：最近 N 天每天的会话数。 */
export function HeatStrip(props: { counts: number[]; days: number[]; size?: number; gap?: number; className?: string }) {
    const size = props.size ?? 9
    const gap = props.gap ?? 2
    return (
        <span className={cn('inline-flex shrink-0 items-center', props.className)} style={{ gap }}>
            {props.counts.map((n, index) => (
                <span
                    key={props.days[index] ?? index}
                    title={`${shortDate(props.days[index] ?? 0)}: ${n}`}
                    className="inline-block rounded-[2px]"
                    style={{ width: size, height: size, background: heatColor(n) }}
                />
            ))}
        </span>
    )
}

/** 机器图标一排（设备图标优先，回落到系统图标），超出的显示 +N。 */
export function MachineIconRow(props: { model: WorkModel; machineIds: Array<string | null>; labels: string[]; max?: number }) {
    const max = props.max ?? 5
    const lookup = new Map(props.model.machines.map(machine => [machine.id, machine]))
    const shown = props.machineIds.slice(0, max)
    return (
        <span className="inline-flex shrink-0 items-center gap-1 text-[var(--app-hint)]" title={props.labels.join(' · ')}>
            {shown.map((id, index) => {
                const machine = lookup.get(id)
                return (
                    <span key={`${id ?? '?'}-${index}`} className="flex h-5 w-5 items-center justify-center rounded-md" style={{ background: 'var(--wo-chip)' }}>
                        <MachineOsIcon platform={machine?.platform ?? null} icon={machine?.icon ?? null} className="h-3 w-3" />
                    </span>
                )
            })}
            {props.machineIds.length > max ? <span className="text-[10px]">+{props.machineIds.length - max}</span> : null}
        </span>
    )
}

export function useRelativeDay() {
    const { t } = useTranslation()
    return (at: number, now: number = Date.now()): string => {
        if (!at) return t('work.never')
        const today = new Date(now)
        today.setHours(0, 0, 0, 0)
        if (at >= today.getTime()) return t('work.today')
        const days = Math.max(1, Math.ceil((today.getTime() - at) / DAY_MS))
        return days <= 1 ? t('work.yesterday') : t('work.daysAgo', { n: days })
    }
}

export function shortDate(at: number): string {
    if (!at) return '—'
    const date = new Date(at)
    return `${date.getMonth() + 1}-${date.getDate()}`
}

type IconProps = { className?: string }
const svg = (children: ReactNode) => (props: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={props.className}>{children}</svg>
)

export const WorkGridIcon = svg(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>)
export const TrendUpIcon = svg(<><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>)
export const PlayIcon = svg(<><circle cx="12" cy="12" r="9" /><path d="M10 8.5l5 3.5-5 3.5z" /></>)
export const BellIcon = svg(<><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>)
export const PauseIcon = svg(<><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></>)
export const ArrowRightIcon = svg(<path d="M5 12h14M13 6l6 6-6 6" />)
export const InboxIcon = svg(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>)
export const CrossMachineIcon = svg(<><path d="M7 7h11l-3-3" /><path d="M17 17H6l3 3" /></>)
export const MapIcon = svg(<><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" /></>)
export const CalendarIcon = svg(<><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>)
export const ListTodoIcon = svg(<><rect x="3" y="5" width="6" height="6" rx="1" /><path d="M3 17l2 2 4-4M13 6h8M13 12h8M13 18h8" /></>)

export type AssignChoice =
    | { kind: 'line'; lineId: string }
    | { kind: 'ignored' }
    | { kind: 'unassigned' }

/**
 * 「归到…」下拉：按主线分组列支线，每组末尾可以就地新建支线；另有新建主线、忽略、放回待整理。
 * 新建走 window.prompt（与账号管理页同一做法），建好后直接用新支线完成这次归属。
 */
export function AssignSelect(props: {
    mainlines: MainlineView[]
    value: string | null
    allowUnassign?: boolean
    disabled?: boolean
    onChoose: (choice: AssignChoice) => void
    className?: string
}) {
    const { t } = useTranslation()
    const { upsertLine } = useWorkActions()
    const handle = async (raw: string) => {
        if (raw.startsWith('line:')) return props.onChoose({ kind: 'line', lineId: raw.slice(5) })
        if (raw === 'ignored') return props.onChoose({ kind: 'ignored' })
        if (raw === 'unassigned') return props.onChoose({ kind: 'unassigned' })
        if (raw.startsWith('new-sub:')) {
            const parentId = raw.slice(8)
            const name = window.prompt(t('work.prompt.newSubline'))?.trim()
            if (!name) return
            const parent = props.mainlines.find(line => line.id === parentId)
            const id = newLineId()
            await upsertLine.mutateAsync({ id, parentId, name, goal: '', sort: parent?.sublines.length ?? 0 })
            return props.onChoose({ kind: 'line', lineId: id })
        }
        if (raw === 'new-main') {
            const mainName = window.prompt(t('work.prompt.newMainline'))?.trim()
            if (!mainName) return
            const subName = window.prompt(t('work.prompt.firstSubline'), mainName)?.trim()
            if (!subName) return
            const mainId = newLineId()
            await upsertLine.mutateAsync({ id: mainId, parentId: null, name: mainName, goal: '', sort: props.mainlines.length })
            const subId = newLineId()
            await upsertLine.mutateAsync({ id: subId, parentId: mainId, name: subName, goal: '', sort: 0 })
            return props.onChoose({ kind: 'line', lineId: subId })
        }
    }
    return (
        <select
            aria-label={t('work.assign.label')}
            className={cn(
                'h-8 max-w-full cursor-pointer rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 text-xs text-[var(--app-fg)] outline-none transition-colors hover:border-[var(--wo-push)] focus:border-[var(--wo-push)]',
                props.className
            )}
            value={props.value ? `line:${props.value}` : ''}
            disabled={props.disabled || upsertLine.isPending}
            onChange={event => { void handle(event.target.value) }}
        >
            <option value="" disabled>{t('work.assign.placeholder')}</option>
            {props.mainlines.map(main => (
                <optgroup key={main.id} label={main.name}>
                    {main.sublines.map(sub => <option key={sub.id} value={`line:${sub.id}`}>{sub.name}</option>)}
                    <option value={`new-sub:${main.id}`}>{t('work.assign.newSubline', { name: main.name })}</option>
                </optgroup>
            ))}
            <optgroup label={t('work.assign.more')}>
                <option value="new-main">{t('work.assign.newMainline')}</option>
                <option value="ignored">{t('work.assign.ignore')}</option>
                {props.allowUnassign ? <option value="unassigned">{t('work.assign.unassign')}</option> : null}
            </optgroup>
        </select>
    )
}
