#!/usr/bin/env bun

// Fast-path `hook-forwarder` before loading the full CLI/Hub/SDK module graph.
// Each PreToolUse/SessionStart hook spawns `hapi hook-forwarder <port>`; skipping
// heavy top-level imports avoids ~100-300MB Commit Charge spikes when an agent
// invokes multiple tools in parallel.
if (process.argv[2] === 'hook-forwarder') {
    const { runSessionHookForwarder } = await import('./claude/utils/sessionHookForwarder')
    await runSessionHookForwarder(process.argv.slice(3))
} else {
    // Side-effect: registers Claude + Codex fork providers into the
    // fork-features registry. Must precede any RPC dispatch that may
    // receive ForkSpawnSession. See fork-features/trunk-patches.md.
    await import('../../fork-features/session-fork/register')
    const { runCli } = await import('./commands/runCli')
    await runCli()
}
