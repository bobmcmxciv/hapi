/** Separate build/URL: the production entry never opts in through shared storage. */
export const BETA_TIMELINE_ENABLED = import.meta.env.VITE_HAPI_BETA === '1'
