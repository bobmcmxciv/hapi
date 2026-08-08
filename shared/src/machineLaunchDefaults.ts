import { CLAUDE_EFFORT_LEVELS, type ClaudeEffortLevel } from './effort'

/**
 * Per-machine launch defaults, advertised by the runner in machine metadata.
 *
 * Why this exists: on machines whose Claude Code is pointed at an
 * Anthropic-compatible proxy (this fork's operator runs cx2cc, which actually
 * serves `gpt-5.6-sol`), the New Session form defaulted to `auto`. Operators
 * then picked an Anthropic preset like `sonnet[1m]` as a placeholder, so the
 * UI showed a model that was never running, and the context-window denominator
 * was metered against the wrong family.
 *
 * The per-(machine, agent) preference in `web/src/components/NewSession/
 * preferences.ts` only lives in one browser's localStorage, so it cannot serve
 * as the machine's default — a phone, a second laptop, or a cleared profile all
 * start over at `auto`. Advertising the default from the machine itself makes
 * it apply everywhere, and keeps it next to the thing it describes: the
 * machine's own provider configuration.
 *
 * Source of truth is the operator-editable `~/.hapi/settings.json`:
 *
 *     { "defaultLaunchModel": "gpt-5.6-sol[1m]", "defaultLaunchEffort": "xhigh" }
 *
 * Deliberately not auto-detected from `ANTHROPIC_MODEL`: that env var carries
 * the bare alias with no `[1m]` suffix, and the suffix is a launch-time
 * declaration the operator opts into — inferring it would silently meter
 * sessions against a 1M window the proxy may not actually grant.
 */
export type MachineLaunchDefaults = {
    model?: string
    effort?: ClaudeEffortLevel
}

/** Longest model id we will accept, to keep a corrupt settings file from bloating metadata. */
const MAX_MODEL_ID_LENGTH = 120

/**
 * Validate raw settings values into launch defaults.
 *
 * Returns `undefined` for absent/invalid input rather than throwing: a typo in
 * a hand-edited settings.json must not stop the runner from registering. An
 * unusable value simply leaves the form on its normal `auto` default.
 */
export function resolveMachineLaunchDefaults(raw: {
    model?: unknown
    effort?: unknown
}): MachineLaunchDefaults | undefined {
    const model = typeof raw.model === 'string' ? raw.model.trim() : ''
    const effortRaw = typeof raw.effort === 'string' ? raw.effort.trim().toLowerCase() : ''

    const resolved: MachineLaunchDefaults = {}
    if (model.length > 0 && model.length <= MAX_MODEL_ID_LENGTH) {
        resolved.model = model
    }
    if ((CLAUDE_EFFORT_LEVELS as readonly string[]).includes(effortRaw)) {
        resolved.effort = effortRaw as ClaudeEffortLevel
    }

    return resolved.model === undefined && resolved.effort === undefined ? undefined : resolved
}
