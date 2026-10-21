import { describe, expect, it } from 'vitest'
import { extractBackgroundTaskDelta } from './backgroundTasks'

describe('extractBackgroundTaskDelta', () => {
    it('tracks Antigravity background task and subagent lifecycle', () => {
        expect(extractBackgroundTaskDelta({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_tool_action',
                    name: 'RUN_COMMAND',
                    toolName: 'run_command',
                    content: 'Tool is running as a background task with task id: abc/task-10'
                }
            }
        })).toEqual({ started: 1, completed: 0 })

        expect(extractBackgroundTaskDelta({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_tool_action',
                    name: 'INVOKE_SUBAGENT',
                    toolName: 'invoke_subagent',
                    content: 'Subagent started with conversationId: 12345678-90ab'
                }
            }
        })).toEqual({ started: 1, completed: 0 })

        expect(extractBackgroundTaskDelta({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_tool_action',
                    name: 'SYSTEM_MESSAGE',
                    content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-21T00:00:00Z sender=abc/task-10 content=Task id "abc/task-10" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>'
                }
            }
        })).toEqual({ started: 0, completed: 1 })

        expect(extractBackgroundTaskDelta({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_tool_action',
                    name: 'SYSTEM_MESSAGE',
                    content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-21T00:00:00Z sender=12345678-90ab content=Subagent report ready\n</SYSTEM_MESSAGE>'
                }
            }
        })).toEqual({ started: 0, completed: 1 })

        expect(extractBackgroundTaskDelta({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_tool_action',
                    name: 'SYSTEM_MESSAGE',
                    content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-21T00:00:00Z sender=system content=[Notice] All your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>'
                }
            }
        })).toEqual({ started: 0, completed: 999 })
    })
})
