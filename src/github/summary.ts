import { appendFileSync } from 'node:fs'
import type { PipelineResult, RunStatus, VerificationResult } from '../pipeline/types.ts'

/**
 * The run summary that renders inside the Actions UI.
 *
 * Logs are ephemeral and the artifact has to be downloaded, so the one place a
 * human actually looks — the run page — is where the verdict, the baseline
 * attribution and the failing layer belong.
 */

export interface StepSummaryInput {
  status: RunStatus
  target: { tag: string; version: string }
  pluginName: string
  result: Pick<
    PipelineResult,
    'mechanical' | 'fixAttempts' | 'skippedReview' | 'attribution' | 'verification' | 'stoppedBy' | 'e2eSync'
  >
  issueUrl?: string | undefined
  pullRequestUrl?: string | undefined
  runDir: string
}

/** Every verification layer names itself; a new layer must be added here. */
const VERIFY_LABEL: Record<VerificationResult['layer'], string> = {
  boot: 'boot probe',
  web: 'web smoke',
  e2e: 'E2E suite',
}

const VERDICT: Record<RunStatus, string> = {
  compatible: '✅ compatible',
  migrated: '🔧 migrated',
  failed: '❌ failed',
  skipped: '⏭️ skipped',
}

/**
 * Render the markdown summary for `$GITHUB_STEP_SUMMARY`.
 * @param input - run outcome
 */
export function renderStepSummary(input: StepSummaryInput): string {
  const lines: string[] = []
  lines.push(`## dsh-migrate: ${VERDICT[input.status]}`)
  lines.push('')
  lines.push(`**${input.pluginName}** × \`${input.target.tag}\``)
  lines.push('')

  const facts: string[] = [`fast gate: ${input.result.mechanical.ok ? 'pass' : 'fail'}`]
  if (input.result.skippedReview) facts.push('review skipped')
  else facts.push(`repair rounds: ${input.result.fixAttempts}`)
  if (input.result.stoppedBy !== undefined && input.result.stoppedBy !== 'budget') {
    facts.push(`loop stopped: ${input.result.stoppedBy}`)
  }
  lines.push(facts.join(' · '))

  if (input.result.attribution !== undefined) {
    lines.push('')
    lines.push(`**Baseline** — ${input.result.attribution.summary}`)
  }

  const verification = input.result.verification
  if (verification !== undefined) {
    lines.push('')
    const label = VERIFY_LABEL[verification.layer]
    lines.push(`**Verification** — ${label}: ${verification.ok ? 'pass' : 'fail'}${
      verification.skipped === undefined ? '' : ` (skipped: ${verification.skipped})`
    }`)
    if (!verification.ok) {
      lines.push('')
      lines.push('```')
      lines.push(verification.detail.trim().slice(0, 1500) || verification.signature)
      lines.push('```')
    }
  }

  if (input.result.e2eSync !== undefined) {
    lines.push('')
    lines.push(`**E2E branch** — ${input.result.e2eSync.pushed
      ? 'updated'
      : `not updated (${input.result.e2eSync.reason ?? 'unknown'})`}`)
  }

  const links = [input.issueUrl, input.pullRequestUrl].filter((url): url is string => url !== undefined)
  if (links.length > 0) {
    lines.push('')
    lines.push(links.join(' · '))
  }
  lines.push('')
  lines.push(`<sub>reports: \`${input.runDir}\`</sub>`)
  return `${lines.join('\n')}\n`
}

/**
 * Append a summary to the Actions step summary, when the runner provides one.
 * Never throws: a missing summary must not fail a migration.
 * @param markdown - rendered summary
 * @param env - environment holding `GITHUB_STEP_SUMMARY`
 */
export function writeStepSummary(markdown: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.GITHUB_STEP_SUMMARY
  if (path === undefined || path === '') return false
  try {
    appendFileSync(path, markdown, 'utf8')
    return true
  } catch {
    return false
  }
}
