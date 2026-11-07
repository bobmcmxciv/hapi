import chalk from 'chalk'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { AGY_PERMISSION_MODES } from '@hapi/protocol/modes'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'

const AGY_HEADLESS_EXECUTABLE = 'C:\\Windows\\System32\\config\\systemprofile\\AppData\\Roaming\\npm\\node_modules\\@twsxtd\\hapi\\node_modules\\@twsxtd\\hapi-win32-x64\\bin\\hapi.exe'

export function parseAgyCommandOptions(commandArgs: string[]) {
    const options = parseRemoteAgentCommandOptions(
        commandArgs,
        AGY_PERMISSION_MODES,
        ['pty'],
    )
    return { ...options, startingMode: options.startingMode ?? 'pty' as const }
}

export const agyCommand: CommandDefinition = {
    name: 'agy',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        if (commandArgs.includes('-h') || commandArgs.includes('--help')) {
            console.log('Usage: hapi agy [--resume [sessionId]] [--model <model>] [--permission-mode <mode>]')
            return
        }
        const modeIdx = commandArgs.indexOf('--hapi-starting-mode')
        const requestedMode = modeIdx !== -1 ? commandArgs[modeIdx + 1] : undefined
        if (requestedMode && requestedMode !== 'pty' && existsSync(AGY_HEADLESS_EXECUTABLE)) {
            const child = spawn(AGY_HEADLESS_EXECUTABLE, ['agy', ...commandArgs], {
                stdio: 'inherit',
                env: process.env
            })
            await new Promise<void>((_, reject) => {
                child.on('error', reject)
                child.on('exit', (code) => {
                    process.exit(code ?? 0)
                })
            })
            return
        }
        try {
            const options = parseAgyCommandOptions(commandArgs)

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runAgy } = await import('@/agy/runAgy')
            await runAgy(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
