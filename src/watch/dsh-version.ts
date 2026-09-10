import { execFile } from 'node:child_process'

const REPO = 'deepseek-ai/deepseek-harness'
const RELEASES = `https://api.github.com/repos/${REPO}/releases`
const REPO_URL = `https://github.com/${REPO}.git`

export interface ResolvedVersion {
  tag: string
  version: string
}

export interface ResolveOptions {
  /**
   * Token for the releases call. The Action passes `GITHUB_TOKEN`; without one
   * the request is unauthenticated and shares the 60-requests-per-hour bucket
   * of the whole runner IP range, which is what makes `latest` fail with 403.
   */
  token?: string | undefined
  fetchImpl?: typeof fetch | undefined
  /** Tag lister used when the REST API refuses the request. */
  listTags?: ((url: string) => Promise<string[]>) | undefined
}

function tagToVersion(tag: string): string {
  return tag.startsWith('dsh-v') ? tag.slice('dsh-v'.length) : tag.replace(/^v/, '')
}

function splitVersion(version: string): { main: number[]; pre: string[] | undefined } {
  const dash = version.indexOf('-')
  const core = dash < 0 ? version : version.slice(0, dash)
  const pre = dash < 0 ? undefined : version.slice(dash + 1)
  const main = core.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
  return { main, pre: pre === undefined ? undefined : pre.split('.') }
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right)
      if (diff !== 0) return diff > 0 ? 1 : -1
      continue
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    if (left !== right) return left > right ? 1 : -1
  }
  return 0
}

/**
 * Semver ordering for dsh release tags, used to pick the newest tag when the
 * release list is unavailable: `0.1.5-rc.1` > `0.1.5-alpha.2` > `0.1.3-alpha.2`.
 * @param a - left version (no `dsh-v` prefix)
 * @param b - right version (no `dsh-v` prefix)
 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a)
  const right = splitVersion(b)
  for (let index = 0; index < Math.max(left.main.length, right.main.length); index += 1) {
    const diff = (left.main[index] ?? 0) - (right.main[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre === undefined && right.pre === undefined) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return comparePrerelease(left.pre, right.pre)
}

/**
 * `git ls-remote --tags --refs <url>` tag names, the unauthenticated fallback
 * when the REST API refuses: the git protocol does not share the API bucket.
 * @param url - repository URL
 */
export function listRemoteTags(url: string): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['ls-remote', '--tags', '--refs', url], { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ls-remote ${url} failed: ${stderr.trim() !== '' ? stderr.trim() : error.message}`))
        return
      }
      const tags = stdout
        .split('\n')
        .map(line => line.slice(line.indexOf('refs/tags/') + 'refs/tags/'.length).trim())
        .filter(line => line !== '' && !line.endsWith('^{}'))
      resolvePromise(tags)
    })
  })
}

function newestDshTag(tags: readonly string[]): string | undefined {
  let newest: string | undefined
  for (const tag of tags) {
    if (!tag.startsWith('dsh-v')) continue
    if (newest === undefined || compareVersions(tagToVersion(tag), tagToVersion(newest)) > 0) newest = tag
  }
  return newest
}

function rateLimitNote(response: Response): string {
  const remaining = response.headers.get('x-ratelimit-remaining')
  const reset = response.headers.get('x-ratelimit-reset')
  if (remaining !== '0') return ''
  if (reset === null) return ' (rate limit exhausted)'
  const seconds = Number(reset) * 1000 - Date.now()
  const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60_000) : 0
  return minutes > 0 ? ` (rate limit exhausted, resets in ~${minutes}min)` : ' (rate limit exhausted)'
}

/**
 * Resolve `latest` against public GitHub releases, or pass through a pin.
 * Authenticated when a token is available; on a refusal from the REST API
 * (rate limit, outage, network) it falls back to `git ls-remote`.
 * @param requested - `latest` or a concrete `0.1.1-rc.2` / `dsh-v0.1.1-rc.2`
 * @param options - token, injectable fetch, and the fallback tag lister
 */
export async function resolveDshVersion(
  requested: string,
  options: ResolveOptions = {},
): Promise<ResolvedVersion> {
  if (requested !== 'latest') {
    const tag = requested.startsWith('dsh-v') ? requested : `dsh-v${requested}`
    return { tag, version: tagToVersion(tag) }
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const listTags = options.listTags ?? listRemoteTags
  const fallback = async (reason: string): Promise<ResolvedVersion> => {
    const tag = newestDshTag(await listTags(REPO_URL))
    if (tag === undefined) throw new Error(`${reason}; no dsh-v* tag found via git ls-remote`)
    return { tag, version: tagToVersion(tag) }
  }

  let response: Response
  try {
    response = await fetchImpl(RELEASES, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-migrate-action',
        ...(options.token === undefined || options.token === '' ? {} : { Authorization: `Bearer ${options.token}` }),
      },
    })
  } catch (error) {
    return await fallback(`failed to list dsh releases: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      return await fallback(`failed to list dsh releases: HTTP ${response.status}${rateLimitNote(response)}`)
    }
    throw new Error(`failed to list dsh releases: HTTP ${response.status}`)
  }
  const body: unknown = await response.json()
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error('dsh release list is empty')
  }
  for (const item of body) {
    if (typeof item !== 'object' || item === null) continue
    const tag = (item as { tag_name?: unknown }).tag_name
    if (typeof tag === 'string' && tag.startsWith('dsh-v')) {
      return { tag, version: tagToVersion(tag) }
    }
  }
  throw new Error('no dsh-v* release tag found')
}
