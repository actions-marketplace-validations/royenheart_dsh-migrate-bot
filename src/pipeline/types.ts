import type { MigrateConfig } from '../config/schema.ts'
import type { MechanicalResult } from '../mechanical/run.ts'
import type { AgentRunner } from '../agents/types.ts'
import type { ReportStore } from '../reports/store.ts'
import type { ResolvedVersion } from '../watch/dsh-version.ts'
import type { QuotaSnapshot } from '../quota/types.ts'
import type { Attribution } from '../verify/baseline.ts'

export type RunStatus = 'compatible' | 'migrated' | 'failed' | 'skipped'

/** Which gate produced a verification outcome. */
export type VerifyLayer = 'boot' | 'web' | 'e2e'

/** One verification round: V2 (boot) short-circuits before V3 (E2E). */
export interface VerificationResult {
  ok: boolean
  layer: VerifyLayer
  /** Normalized failure class, compared across rounds to detect a stalled loop. */
  signature: string
  detail: string
  /** Layers that were skipped and why, for the report. */
  skipped?: string
}

export interface E2ESyncOutcome {
  ok: boolean
  pushed: boolean
  reason?: string
  detail?: string
}

export interface PublishResult {
  issueUrl?: string
  issueNumber?: number
  pullRequestUrl?: string
  pullRequestNumber?: number
}

export interface PipelineResult {
  status: RunStatus
  mechanical: MechanicalResult
  published: PublishResult
  runDir: string
  skippedReview: boolean
  fixAttempts: number
  /** Baseline-vs-target attribution, when a baseline probe ran. */
  attribution?: Attribution
  /** Outcome of the final verification round. */
  verification?: VerificationResult
  /** Why the repair loop stopped before exhausting its budget. */
  stoppedBy?: 'budget' | 'blocker' | 'stalled'
  /** Suite-branch sync result, when the E2E branch was updated. */
  e2eSync?: E2ESyncOutcome
}

export interface GithubPublisher {
  publish(input: {
    title: string
    issueBody: string
    prBody: string
    branch: string
    workdir: string
  }): Promise<PublishResult>
  commentIssue?(issueNumber: number, body: string, workdir: string): Promise<void>
}

export interface QuotaPort {
  query(): Promise<QuotaSnapshot>
}

export interface PipelinePorts {
  config: MigrateConfig
  workdir: string
  target: ResolvedVersion
  store: ReportStore
  apiKey: string
  runMechanical: () => MechanicalResult
  isDirty: () => boolean
  diff: () => string
  agent: AgentRunner
  github?: GithubPublisher
  quota?: QuotaPort
  harness?: { path: string; tag: string } | undefined
  /**
   * V2: load the tree into a scratch profile and boot dsh under the target.
   * Absent when `verify.boot.enabled` is false or no dsh binary is available.
   */
  probeTarget?: (() => Promise<VerificationResult>) | undefined
  /**
   * V2b: boot `dsh web` headlessly and report whether it serves with the plugin
   * mounted. Absent when `verify.web.enabled` is false or no dsh binary exists.
   */
  probeWeb?: (() => Promise<VerificationResult>) | undefined
  /**
   * V3/V4: run the agent-authored suite. `subset` runs only the previously
   * failing tests plus smoke; `full` runs everything.
   */
  runE2E?: ((mode: 'subset' | 'full') => Promise<VerificationResult>) | undefined
  /** Baseline-vs-target attribution computed before the loop starts. */
  attribution?: Attribution | undefined
  /** P7: publish the suite to its own branch. Never blocks the migration. */
  syncE2E?: (() => Promise<E2ESyncOutcome>) | undefined
}

export interface PipelineLogger {
  info(message: string): void
}
