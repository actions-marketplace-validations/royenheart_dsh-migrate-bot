import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SeenState } from '../watch/seen.ts'
import type { BootProbeResult } from './boot.ts'

/** Where the baseline tag came from, so the report can say how much to trust it. */
export type BaselineSource = 'state' | 'declared-peers' | 'none'

export interface Baseline {
  tag?: string
  source: BaselineSource
}

const DSH_SCOPE = '@deepseek-ai/dsh-'

/**
 * Pick the version to run the baseline probe against.
 *
 * Order: the tag the Action last processed (authoritative), then the harness
 * version the plugin itself declares in its `@deepseek-ai/dsh-*` ranges (a
 * usable proxy when there is no recorded state yet), then nothing.
 * @param seen - recorded state for this repository
 * @param workdir - plugin working tree
 */
export function resolveBaseline(seen: SeenState | undefined, workdir: string): Baseline {
  const recorded = seen?.verified?.tag ?? seen?.tag
  if (recorded !== undefined && recorded !== '') return { tag: recorded, source: 'state' }

  const declared = declaredDshVersion(workdir)
  if (declared !== undefined) return { tag: `dsh-v${declared}`, source: 'declared-peers' }
  return { source: 'none' }
}

/** Lowest concrete version among the plugin's `@deepseek-ai/dsh-*` ranges. */
export function declaredDshVersion(workdir: string): string | undefined {
  const path = join(workdir, 'package.json')
  if (!existsSync(path)) return undefined
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof pkg !== 'object' || pkg === null) return undefined

  const found: string[] = []
  for (const key of ['devDependencies', 'peerDependencies', 'dependencies']) {
    const block = (pkg as Record<string, unknown>)[key]
    if (typeof block !== 'object' || block === null) continue
    for (const [name, range] of Object.entries(block as Record<string, unknown>)) {
      if (!name.startsWith(DSH_SCOPE) || typeof range !== 'string') continue
      const match = range.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
      if (match?.[0] !== undefined) found.push(match[0])
    }
  }
  if (found.length === 0) return undefined
  return found.sort(compareSemverish)[0]
}

/** Loose ordering good enough to pick the lowest of a handful of versions. */
function compareSemverish(a: string, b: string): number {
  const core = (value: string): number[] => value.split('-')[0]!.split('.').map(part => Number.parseInt(part, 10) || 0)
  const [aCore, bCore] = [core(a), core(b)]
  for (let index = 0; index < 3; index += 1) {
    const diff = (aCore[index] ?? 0) - (bCore[index] ?? 0)
    if (diff !== 0) return diff
  }
  // A prerelease sorts below its release.
  const aPre = a.includes('-')
  const bPre = b.includes('-')
  if (aPre === bPre) return a < b ? -1 : a > b ? 1 : 0
  return aPre ? -1 : 1
}

export interface Attribution {
  /** The plugin was already broken before this run touched it. */
  preExisting: boolean
  /** The baseline passed and the target failed: the corridor caused it. */
  regression: boolean
  /** One line for the report and for the agent's context. */
  summary: string
}

/**
 * Turn the two probe results into attribution and a scope hint.
 *
 * The baseline never decides whether the run proceeds — a plugin several
 * corridors behind is exactly what this Action exists to fix. It decides what
 * the report says and how far back the agent has to look.
 * @param baseline - baseline probe result, if one ran
 * @param current - target probe result
 * @param source - how the baseline tag was chosen
 */
export function attribute(
  baseline: BootProbeResult | undefined,
  current: BootProbeResult,
  source: BaselineSource,
): Attribution {
  if (baseline === undefined || source === 'none') {
    return {
      preExisting: false,
      regression: false,
      summary: 'no baseline probe (no recorded tag and no declared harness version); scope unknown',
    }
  }
  if (baseline.outcome === 'pass' && current.outcome !== 'pass') {
    return {
      preExisting: false,
      regression: true,
      summary: `baseline passed (${source}), target ${current.outcome}: the from→to corridor caused this`,
    }
  }
  if (baseline.outcome !== 'pass' && current.outcome === 'pass') {
    return {
      preExisting: true,
      regression: false,
      summary: `baseline was already broken (${source}), target now passes: this run also repaired a pre-existing break`,
    }
  }
  if (baseline.outcome !== 'pass') {
    const same = baseline.signature === current.signature
    return {
      preExisting: true,
      regression: false,
      summary: same
        ? `baseline already broken with the same signature (${source}): the plugin is behind by more than one corridor — look further back than from→to`
        : `baseline already broken (${source}) with a different signature: the plugin is behind by more than one corridor — look further back than from→to`,
    }
  }
  return { preExisting: false, regression: false, summary: `both baseline and target pass (${source})` }
}

/**
 * Evidence-based early stop: two rounds that produced the same failure
 * signature changed nothing, so another identical round is waste. This looks
 * at observed output only — it never guesses at a cause.
 * @param previous - signature of the previous round
 * @param next - signature of the round that just ran
 */
export function signatureStalled(previous: string | undefined, next: string): boolean {
  return previous !== undefined && previous === next && next !== ''
}
