/*
 * Standalone Vite-served fixture for the mobile session-list layout work
 * (360/390/412px toolbar wrap + machine filter collapse + health-chip height).
 *
 * Mounts the REAL SessionList with sessions spread over several machines so
 * the machine filter bar renders, plus headerLeading/headerActions mirroring
 * router.tsx. No hub / auth / socket needed. Requires VITE_HAPI_BETA=1 so
 * BETA_TIMELINE_ENABLED takes the beta branch (project modes row + min-h-11
 * touch targets) — that flag is exactly what caused the health-chip height
 * split between the HoverTooltip shell (28px) and the inner button (44px).
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { SessionList } from '../src/components/SessionList'
import { DISABLED_SESSION_LIST_SCROLL_STABILITY } from '../src/fork-features/session-list-scroll/sessionListScroll'
import { WorkMobileToggle } from '../src/fork-features/work-overview/WorkOverviewPanel'
import type { ApiClient } from '../src/api/client'
import type { MachineWithOwner, SessionSummary } from '../src/types/api'

function summary(
 overrides: Partial<SessionSummary> & { id: string; name: string; path: string; machineId?: string },
): SessionSummary {
 const { name, path, machineId, ...rest } = overrides
 return {
  active: false,
  thinking: false,
  activeAt: 0,
  updatedAt: 0,
  metadataVersion: 0,
  agentStateVersion: 0,
  todosUpdatedAt: 0,
  todoProgress: null,
  pendingRequestsCount: 0,
  pendingRequestKinds: [],
  pendingRequests: [],
  backgroundTaskCount: 0,
  futureScheduledMessageCount: 0,
  nextScheduledAt: null,
  model: null,
  effort: null,
  ...rest,
  metadata: {
   path,
   name,
   ...(machineId ? { machineId } : {}),
   ...(rest.metadata ?? {}),
  },
 }
}

const MACHINES: MachineWithOwner[] = [
 {
  id: 'machine-t14s',
  namespace: 'default',
  seq: 1,
  createdAt: 0,
  updatedAt: 0,
  active: true,
  activeAt: 1,
  metadata: { host: 'ThinkPad-T14s', platform: 'win32', displayName: 'ThinkPad-T14s' },
  metadataVersion: 1,
  runnerState: null,
  runnerStateVersion: 0,
  ownerUsername: 'admin',
  health: { collectedAt: 1, cpuCount: 12, load1m: 6.4, cpuPercent: 42, memoryPercent: 71, uptimeSeconds: 96_400 },
 },
 {
  id: 'machine-mac173',
  namespace: 'default',
  seq: 2,
  createdAt: 0,
  updatedAt: 0,
  active: true,
  activeAt: 1,
  metadata: { host: 'MAC173INDEX', platform: 'darwin' },
  metadataVersion: 1,
  runnerState: null,
  runnerStateVersion: 0,
  ownerUsername: 'admin',
  health: { collectedAt: 1, cpuCount: 8, load1m: 2.1, cpuPercent: 18, memoryPercent: 55, uptimeSeconds: 4_200 },
 },
 {
  id: 'machine-vircs',
  namespace: 'default',
  seq: 3,
  createdAt: 0,
  updatedAt: 0,
  active: true,
  activeAt: 1,
  metadata: { host: 'VIRCS', platform: 'win32' },
  metadataVersion: 1,
  runnerState: null,
  runnerStateVersion: 0,
  ownerUsername: 'admin',
  // No health reported -> the plain-button chip branch.
 },
 {
  id: 'machine-redmibook',
  namespace: 'default',
  seq: 4,
  createdAt: 0,
  updatedAt: 0,
  active: false,
  activeAt: 0,
  metadata: { host: 'REDMIBOOK', platform: 'win32' },
  metadataVersion: 1,
  runnerState: null,
  runnerStateVersion: 0,
  ownerUsername: 'admin',
 },
 {
  id: 'machine-peter',
  namespace: 'default',
  seq: 5,
  createdAt: 0,
  updatedAt: 0,
  active: true,
  activeAt: 1,
  metadata: { host: 'Peter-Desktop', platform: 'win32', displayName: 'Peter-Desktop' },
  metadataVersion: 1,
  runnerState: null,
  runnerStateVersion: 0,
  ownerUsername: 'peter',
  health: { collectedAt: 1, cpuCount: 16, load1m: 14.9, cpuPercent: 88, memoryPercent: 93, uptimeSeconds: 777_600 },
 },
]

const SESSIONS: SessionSummary[] = []
const GROUPS: Array<{ dir: string; machineId?: string; count: number }> = [
 { dir: '/work/oh-my-pi', machineId: 'machine-t14s', count: 4 },
 { dir: '/work/hapi', machineId: 'machine-t14s', count: 3 },
 { dir: '/work/notes', machineId: 'machine-mac173', count: 3 },
 { dir: '/work/ops', machineId: 'machine-vircs', count: 2 },
 { dir: '/work/redmibook-proj', machineId: 'machine-redmibook', count: 1 },
 { dir: '/peter/proj', machineId: 'machine-peter', count: 2 },
 { dir: '/local/no-machine', count: 1 },
]
for (const group of GROUPS) {
 const tag = group.dir.split('/').pop()!
 for (let index = 0; index < group.count; index++) {
  SESSIONS.push(summary({
   id: `${tag}-${index}`,
   name: `${tag} session ${index}`,
   path: group.dir,
   machineId: group.machineId,
   active: index === 0,
   updatedAt: 1_000_000 - SESSIONS.length,
  }))
 }
}

const queryClient = new QueryClient({
 defaultOptions: { queries: { retry: false, gcTime: 0 } },
})

// Real ApiClient is hub-backed; only updateMachine is reachable from the list
// (rename dialog) and the query hooks all gate on a missing connection.
const api = {
 updateMachine: async () => { },
} as unknown as ApiClient

const machinesById = Object.fromEntries(MACHINES.map(m => [m.id, m]))

function ToolbarIcon(props: { label: string; glyph: string }) {
 return (
  <button
   type="button"
   title={props.label}
   aria-label={props.label}
   className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
  >
   <span aria-hidden className="text-base leading-none">{props.glyph}</span>
  </button>
 )
}

// Mirrors router.tsx SessionsPage headerActions (flex-row-reverse, right-anchored,
// internally wrapping icon cluster: new + settings + usage + browse + work).
const headerActions = (
 <div className="flex min-w-0 flex-row-reverse flex-wrap items-center justify-end gap-2">
  <ToolbarIcon label="new" glyph="＋" />
  <ToolbarIcon label="settings" glyph="⚙" />
  <ToolbarIcon label="usage" glyph="◫" />
  <ToolbarIcon label="browse" glyph="▣" />
  <ToolbarIcon label="work" glyph="⊞" />
 </div>
)

function App() {
 return (
  <QueryClientProvider client={queryClient}>
   <I18nProvider>
    <div className="flex h-dvh min-h-0 flex-col bg-[var(--app-bg)]">
     <SessionList
      sessions={SESSIONS}
      scrollStability={DISABLED_SESSION_LIST_SCROLL_STABILITY}
      onSelect={() => { }}
      onNewSession={() => { }}
      onRefresh={() => { }}
      isLoading={false}
      renderHeader={false}
      headerLeading={<WorkMobileToggle compact />}
      headerActions={headerActions}
      api={api}
      machineLabelsById={Object.fromEntries(MACHINES.map(m => [m.id, m.metadata?.displayName ?? m.metadata?.host ?? m.id]))}
      machineOwnersById={Object.fromEntries(MACHINES.map(m => [m.id, m.ownerUsername ?? '']))}
      machinesById={machinesById}
     />
    </div>
   </I18nProvider>
  </QueryClientProvider>
 )
}

const rootEl = document.getElementById('root')
if (rootEl) {
 ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
   <App />
  </React.StrictMode>
 )
}
