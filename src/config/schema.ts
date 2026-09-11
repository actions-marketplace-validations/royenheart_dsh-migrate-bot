import { DEFAULT_API_KEY_ENV } from '../secrets.ts'

/** User-facing review policy after the first mechanical pass. */
export type ReviewPolicy = 'always' | 'skip-if-mechanical-pass'

/** Language used for the GitHub Issue and pull request bodies. */
export type IssuePrLanguage = 'en' | 'zh'

/**
 * Agent preset id shape, as the `@deepseek-ai/dsh-agent-presets` roster
 * accepts it: the id is both the mounted preset's name and (for user presets)
 * its directory under `<dshHome>/.agent-presets`. The presets shipped with the
 * roster are `standard`, `minimal`, `cordis`, and `ptc`.
 */
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * Preset ids carried over from the external `dsh-anchored-standard`
 * repository, which this Action no longer clones or installs. Rejected by
 * name so an old config fails at validation instead of at preset mount.
 */
export const REMOVED_PRESET_IDS = [
  'anchored-standard',
  'zero-anchored-standard',
  'whoami-standard',
  'eternal-minimal',
  'wire-think-standard',
  'combo-anchored',
] as const

/** DeepSeek thinking effort accepted by `@deepseek-ai/dsh-llm-deepseek`. */
export const THINKING_EFFORTS = ['off', 'low', 'high', 'max'] as const

export type ThinkingEffort = (typeof THINKING_EFFORTS)[number]

/** Prompt files the user may override in config. */
export interface PromptOverrides {
  absorption?: string
  alignment?: string
  fix?: string
}

/** Commands that replace the built-in mechanical suite when present. */
export interface TestConfig {
  commands: string[]
}

export interface DshBackendConfig {
  provider: string
  model: string
  thinking: 'enabled' | 'disabled'
  reasoningEffort: ThinkingEffort
  /** dsh agent preset id the sessions mount (see {@link PRESET_ID_PATTERN}). */
  mode: string
}

export interface IssuePrConfig {
  language: IssuePrLanguage
}

export interface LoopConfig {
  maxAttempts: number
}

export interface WatchConfig {
  /** When true (default), skip the pipeline if dsh has not changed since last success. */
  enabled: boolean
}

export interface SecretsConfig {
  /** Env var / repository-secret name that holds the DeepSeek API key. */
  apiKeyEnv: string
}

export interface QuotaConfig {
  /**
   * Max USD this Action run may spend, priced from this run's own usage
   * at official DeepSeek rates. Insufficient official balance still aborts
   * when unset.
   */
  limit?: number
}

/** dsh boot probe: install the tree into a scratch profile and start the host. */
export interface VerifyBootConfig {
  enabled: boolean
  /**
   * Watchdog in milliseconds. dsh has no hang protection of its own: a plugin
   * whose `apply` never resolves hangs the boot instead of failing it.
   */
  timeoutMs: number
}

/** Keyless browser-free web smoke: boot `dsh web` and assert the plugin attached. */
export interface VerifyWebConfig {
  enabled: boolean
  timeoutMs: number
}

export interface VerifyConfig {
  boot: VerifyBootConfig
  web: VerifyWebConfig
}

/**
 * How an E2E failure is treated. `advisory` reports it; `blocking` fails the
 * run. The default is advisory because the first run authors the suite after
 * the migration, which is a weak signal.
 */
export type E2EGate = 'advisory' | 'blocking'

/** Agent-authored end-to-end suite, kept on its own branch. */
export interface E2EConfig {
  enabled: boolean
  branch: string
  /** Rebase the suite branch onto {@link E2EConfig.baseRef} before updating it. */
  forceRebase: boolean
  /**
   * Branch the suite branch is rebased onto. `migration` follows the branch the
   * current run produced (falling back to the default branch when it is gone);
   * any other value is used verbatim.
   */
  baseRef: string
  /** Directory used only when the repository has no E2E framework to extend. */
  dir: string
  gate: E2EGate
  /** During the repair loop run only the previous failing tests plus smoke. */
  subsetFirst: boolean
}

/**
 * Wall-clock watchdogs. Nothing here is a budget: they exist so a hung
 * subprocess fails loudly instead of holding a job until the runner's own
 * limit kills it six hours later. A hung session is not hypothetical — dsh has
 * no hang protection of its own, and neither did this Action.
 */
export interface TimeoutConfig {
  /** One agent session (A, B, C or the E2E authoring session). */
  agentMs: number
  /** One mechanical command: install, build, typecheck, the plugin's own tests. */
  commandMs: number
  /** The sparse harness checkout. */
  checkoutMs: number
}

export interface MigrateConfig {
  dshVersion: string
  review: { policy: ReviewPolicy }
  tests?: TestConfig
  prompts: PromptOverrides
  dsh: DshBackendConfig
  issuePr: IssuePrConfig
  loop: LoopConfig
  watch: WatchConfig
  secrets: SecretsConfig
  quota: QuotaConfig
  verify: VerifyConfig
  e2e: E2EConfig
  timeouts: TimeoutConfig
}

export const DEFAULT_CONFIG: MigrateConfig = {
  dshVersion: 'latest',
  review: { policy: 'always' },
  prompts: {},
  dsh: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    thinking: 'enabled',
    reasoningEffort: 'max',
    mode: 'standard',
  },
  issuePr: { language: 'en' },
  loop: { maxAttempts: 5 },
  watch: { enabled: true },
  secrets: { apiKeyEnv: DEFAULT_API_KEY_ENV },
  quota: {},
  verify: {
    boot: { enabled: true, timeoutMs: 180_000 },
    web: { enabled: true, timeoutMs: 120_000 },
  },
  e2e: {
    enabled: true,
    branch: 'dsh-migrate/e2e',
    forceRebase: true,
    baseRef: 'migration',
    dir: 'e2e',
    gate: 'advisory',
    subsetFirst: true,
  },
  timeouts: {
    agentMs: 60 * 60_000,
    commandMs: 20 * 60_000,
    checkoutMs: 10 * 60_000,
  },
}
