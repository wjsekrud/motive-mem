// Intent review: when a turn ends, a separate model checks what that turn changed against the repository's
// .claude/principles.md. It gets the request, the report, the diff and the principles — never the author's
// (Claude's) reasoning. Results go to the status line, a toast and a panel.
// The start and end of a turn are snapshotted with `git stash create` (the working tree is never touched),
// and only the diff between them is reviewed.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision, FileChange, Intent, Review } from '../types'
import {
  BINARY,
  PRINCIPLES_PATH,
  appendedLog,
  buildPrompt,
  cut,
  fixPrompt,
  forLog,
  hasIssues,
  inOrder,
  kindOf,
  latestById,
  levelOf,
  openFindings,
  parseDiff,
  parsePrinciples,
  parseVerdict,
  principleLabel,
  reviewMarkdown,
  scopeHits,
  statusLine,
  systemPrompt,
  untrackedChunk,
  withLock,
  type Lock,
} from './core'
import { WORDS, langOf, type Lang } from './text'

type Engine = EngineInterface
type Repo = { top: string; gitDir: string }
type Snap = { rev: string; untracked: string[] }

const PANE = 'motive-mem'
const KEEP = 40
const FRESH_LIMIT = 30
const FRESH_MAX_CHARS = 200_000

const reviews = atom({ plugin: 'motive-mem', key: 'reviews' } as const, [])
const cursor = atom({ plugin: 'motive-mem', key: 'cursor' } as const, -1)
const isPaused = atom({ plugin: 'motive-mem', key: 'isPaused' } as const, false)

// ---- git

async function git($: Engine, repo: string, args: string[], stdin?: string) {
  return $.process.run(['git', '-c', 'core.quotepath=off', '-C', repo, ...args], { timeoutMs: 30_000, stdin })
}

async function gitRepo($: Engine): Promise<Repo | undefined> {
  const cwd = await $.session.cwd()
  const found = await $.process
    .run(['git', '-C', cwd, 'rev-parse', '--show-toplevel', '--absolute-git-dir'])
    .catch(() => undefined)
  if (found === undefined || found.exitCode !== 0) return undefined
  const [top, gitDir] = found.stdout.trim().split(/\r?\n/)
  return top && gitDir ? { top, gitDir } : undefined
}

// When the mode is on: a git repository that has a principles file
async function repoOf($: Engine): Promise<Repo | undefined> {
  const repo = await gitRepo($)
  if (repo === undefined) return undefined
  return (await $.fs.exists(`${repo.top}/${PRINCIPLES_PATH}`)) ? repo : undefined
}

// Why it is idle — the answer when a command is run
async function whyOff($: Engine): Promise<string> {
  const c = words().command
  return (await gitRepo($)) === undefined ? c.notRepo : c.noPrinciples(PRINCIPLES_PATH)
}

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] ?? ''

// The snapshot, or why there is none. `git stash create` fails while another git command holds the index lock
// (an editor's `git status`, another session's snapshot) and while the index has unmerged or intent-to-add
// entries. A failure is never taken for a clean tree — that would review the wrong diff: it is retried a few
// times, then reported.
async function snapshot($: Engine, repo: Repo): Promise<Snap | string> {
  let failure = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await $.clock.sleep(150 * attempt)
    const stash = await git($, repo.top, ['stash', 'create'])
    if (stash.exitCode !== 0) {
      failure = firstLine(stash.stderr) || `git stash create: ${stash.exitCode}`
      continue
    }
    // Empty output: nothing changed since HEAD
    let rev = stash.stdout.trim()
    if (rev === '') {
      const head = await git($, repo.top, ['rev-parse', '--verify', '-q', 'HEAD'])
      if (head.exitCode !== 0) return words().command.noHead
      rev = head.stdout.trim()
    }
    const listed = await git($, repo.top, ['ls-files', '--others', '--exclude-standard', '-z'])
    if (listed.exitCode !== 0) {
      failure = firstLine(listed.stderr)
      continue
    }
    const untracked = listed.stdout.split('\0').filter(Boolean)
    // Cut at 4 MiB: the last path may be half of one
    if (listed.isStdoutTruncated) untracked.pop()
    return { rev, untracked }
  }
  return failure
}

async function changes(
  $: Engine,
  repo: Repo,
  from: string,
  to: string,
  fresh: string[],
): Promise<{ files: FileChange[]; diff: string }> {
  // a/ and b/ whatever diff.noprefix, diff.mnemonicPrefix or diff.srcPrefix say — parseDiff reads them
  const out = await git($, repo.top, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '-M',
    '-U3',
    from,
    to,
  ])
  let diff = out.exitCode === 0 ? out.stdout : ''
  const files = parseDiff(diff)
  if (out.isStdoutTruncated) {
    // Past 4 MiB the output is cut: the last file's diff is partial and the ones after it are missing. Every
    // changed file is still listed — as code, unless its name says otherwise — so none drops out unseen.
    const last = files.at(-1)
    if (last?.kind === 'comment') last.kind = 'code'
    const known = new Set(files.map(f => f.path))
    const names = await git($, repo.top, ['diff', '--name-only', '-z', '-M', from, to])
    for (const path of names.stdout.split('\0').filter(Boolean)) {
      if (known.has(path)) continue
      files.push({ path, status: 'modified', added: 0, removed: 0, kind: kindOf(path, [], false), lines: [] })
    }
  }
  for (const path of fresh.slice(0, FRESH_LIMIT)) {
    const text = BINARY.test(path)
      ? undefined
      : await $.fs.read(`${repo.top}/${path}`).catch(() => undefined)
    if (text === undefined || text.length > FRESH_MAX_CHARS || text.includes('\u0000')) {
      files.push({ path, status: 'untracked', added: 0, removed: 0, kind: 'binary', lines: [] })
      continue
    }
    const chunk = untrackedChunk(path, text)
    diff += chunk
    files.push(...parseDiff(chunk).map(file => ({ ...file, status: 'untracked' as const })))
  }
  return { files, diff }
}

// ---- logs (.git/motive-mem — outside the work tree, so they never show up in the next turn's diff)

async function readLines<T>($: Engine, path: string, limit: number): Promise<T[]> {
  const text = await $.fs.read(path).catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as T]
      } catch {
        return []
      }
    })
}

// Sessions in the same repository share these logs, and $.fs only reads and writes whole files. So a write holds
// a git ref as the lock: `update-ref <ref> <id> ''` creates it only while it is absent, which git decides
// atomically across processes. The ref points at a blob holding who took it and when (gc drops it afterwards).
const LOCK_REF = 'refs/motive-mem/lock'
const owner = Math.random().toString(36).slice(2)
const oneAtATime = inOrder()

function gitLock($: Engine, repo: Repo): Lock {
  return {
    take: async stamp => {
      const blob = await git($, repo.top, ['hash-object', '-w', '--stdin'], stamp)
      const id = blob.stdout.trim()
      if (blob.exitCode !== 0 || id === '') return undefined
      const made = await git($, repo.top, ['update-ref', LOCK_REF, id, ''])
      return made.exitCode === 0 ? id : undefined
    },
    peek: async () => {
      const out = await git($, repo.top, ['cat-file', '--batch'], `${LOCK_REF}\n`)
      const [head = '', ...body] = out.stdout.split('\n')
      const [id, type] = head.split(' ')
      return out.exitCode === 0 && type === 'blob' && id ? { id, stamp: body.join('\n').trim() } : undefined
    },
    drop: async id => {
      await git($, repo.top, ['update-ref', '-d', LOCK_REF, id])
    },
  }
}

const READ_LIMIT = 4 * 1024 * 1024

// The log as it stands: '' when there is none yet, or when it grew past what $.fs reads (it starts over then).
// Any other failure to read throws — writing after it would wipe the lines that could not be read.
async function logText($: Engine, path: string): Promise<string> {
  if (!(await $.fs.exists(path))) return ''
  const { size } = await $.fs.stat(path)
  return size > READ_LIMIT ? '' : $.fs.read(path)
}

async function appendLine($: Engine, repo: Repo, path: string, value: unknown, keep: number) {
  const clock = { now: () => $.clock.now(), sleep: (ms: number) => $.clock.sleep(ms) }
  await oneAtATime(() =>
    withLock(gitLock($, repo), clock, owner, async () => {
      await $.fs.write(path, appendedLog(await logText($, path), value, keep))
    }),
  )
}

const reviewLog = (repo: Repo) => `${repo.gitDir}/motive-mem/reviews.jsonl`
const decisionLog = (repo: Repo) => `${repo.gitDir}/motive-mem/decisions.jsonl`
const LOG_KEEP = 200

// A failed log write must not take the result with it: it is noted in the debug log
async function logReview($: Engine, repo: Repo, review: Review) {
  await appendLine($, repo, reviewLog(repo), forLog(review, FRESH_LIMIT), LOG_KEEP).catch(err =>
    $.ui.log(`motive-mem: could not write the review log: ${String(err)}`, { to: 'debug' }),
  )
}

// ---- state

async function put($: Engine, review: Review) {
  await update($, reviews, list => [...list.filter(r => r.id !== review.id), review].slice(-KEEP))
  await update($, cursor, () => -1)
}

async function replace($: Engine, review: Review) {
  await update($, reviews, list => list.map(r => (r.id === review.id ? review : r)))
}

// ---- review (module variables start over on reload — the review list lives in $.state)

type Config = {
  model: string
  effort: 'low' | 'medium' | 'high'
  maxDiffChars: number
  openOnIssue: boolean
  lang: Lang
}

let config: Config = { model: 'sonnet', effort: 'medium', maxDiffChars: 60_000, openOnIssue: true, lang: 'en' }
let pending: { repo: Repo; snap: Snap } | undefined
let prompts: string[] = []
let serial = 0

function words() {
  return WORDS[config.lang]
}

async function review(
  $: Engine,
  repo: Repo,
  range: Review['range'],
  intent: Intent,
  origin: Review['origin'],
) {
  const { files, diff } = await changes($, repo, range.from, range.to, range.fresh)
  if (files.length === 0) {
    if (origin !== 'turn') $.ui.toast(words().command.nothing)
    return
  }
  // Gone when this very turn deleted it: the deletion is still reviewed (and flagged as a principles change)
  const principlesText = await $.fs.read(`${repo.top}/${PRINCIPLES_PATH}`).catch(() => '')
  const hits = scopeHits(
    parsePrinciples(principlesText),
    files.filter(f => f.kind === 'code' || f.kind === 'test').map(f => f.path),
  )
  const level = levelOf(files)
  const at = await $.clock.now()
  const draft: Review = {
    id: `${at}-${serial++}`,
    at,
    origin,
    status: level === 'trivial' ? 'skipped' : 'running',
    level,
    range,
    files: files.map(({ lines: _lines, ...summary }) => summary),
    principleDocs: files.filter(f => f.kind === 'principles').map(f => f.path),
    hits,
    intent,
    model: config.model,
    excepted: [],
  }
  await put($, draft)
  $.ui.status(statusLine(draft, config.lang))
  if (draft.principleDocs.length > 0) {
    $.ui.toast(words().docsChangedToast(draft.principleDocs.join(', ')))
  }
  if (draft.status === 'skipped') {
    await logReview($, repo, draft)
    return
  }

  // From here on the draft is on screen as running: whatever happens, it ends as done or error — never stuck
  let done: Review
  try {
    const decisions = await readLines<Decision>($, decisionLog(repo), 30)
    const answer = await $.model.complete({
      model: config.model,
      effort: config.effort,
      system: systemPrompt(config.lang),
      prompt: buildPrompt({
        principles: principlesText,
        decisions,
        intent,
        files,
        diff,
        hits,
        maxDiffChars: config.maxDiffChars,
        lang: config.lang,
      }),
      maxTokens: 8000,
      timeoutMs: 240_000,
    })
    if (!answer.isAnswered) {
      const why =
        answer.reason === 'api-error'
          ? `api-error: ${answer.error}${answer.status === null ? '' : ` (${answer.status})`}`
          : answer.reason
      done = { ...draft, status: 'error', error: why }
    } else {
      const verdict = parseVerdict(answer.text)
      done =
        verdict === undefined
          ? { ...draft, status: 'error', error: words().unreadable(cut(answer.text, 120)) }
          : { ...draft, status: 'done', verdict }
    }
  } catch (err) {
    done = { ...draft, status: 'error', error: String(err) }
  }
  await replace($, done)
  $.ui.status(statusLine(done, config.lang))
  if (hasIssues(done)) {
    const first = openFindings(done)[0]?.finding
    $.ui.toast(
      first ? `${principleLabel(first.principle, config.lang)}: ${first.why}` : statusLine(done, config.lang),
      { timeoutMs: 8000 },
    )
    if (config.openOnIssue) {
      // Show this review: another one may have started — and finished — after it
      const index = (await read($, reviews)).findIndex(r => r.id === done.id)
      if (index >= 0) await update($, cursor, () => index)
      void $.ui.open({ id: PANE, title: words().title })
    }
  }
  await logReview($, repo, done)
}

function later($: Engine, work: () => Promise<void>) {
  $.clock.after(0, () => {
    work().catch(err => $.ui.log(`motive-mem: ${String(err)}`, { to: 'debug' }))
  })
}

async function reviewAll($: Engine) {
  const repo = await repoOf($)
  if (repo === undefined) return whyOff($)
  const head = await git($, repo.top, ['rev-parse', '--verify', '-q', 'HEAD'])
  if (head.exitCode !== 0) return words().command.noHead
  const now = await snapshot($, repo)
  if (typeof now === 'string') return words().status.snapshotFailed(now)
  const range = { from: head.stdout.trim(), to: now.rev, fresh: now.untracked }
  later($, () => review($, repo, range, { prompts: [...prompts], answer: '', isAll: true }, 'all'))
  return words().command.reviewingAll
}

export const register: Register = (on, options) => {
  const maxDiffChars = Number(options.maxDiffChars)
  config = {
    model: typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : 'sonnet',
    effort: options.effort === 'low' || options.effort === 'high' ? options.effort : 'medium',
    maxDiffChars: Number.isFinite(maxDiffChars) && maxDiffChars >= 1000 ? maxDiffChars : 60_000,
    openOnIssue: options.openOnIssue !== false,
    lang: langOf(options.language),
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const w = words()
    await $.command.register({ name: 'motive-mem', description: w.command.description })
    const repo = await repoOf($)
    if (repo !== undefined && (await read($, reviews)).length === 0) {
      const saved = latestById(await readLines<Review>($, reviewLog(repo), LOG_KEEP), KEEP)
      if (saved.length > 0) await update($, reviews, () => saved)
    }
    // A review the previous environment was still running (it was reloaded) never finishes: let it be run again
    if ((await read($, reviews)).some(r => r.status === 'running')) {
      await update($, reviews, list =>
        list.map(r => (r.status === 'running' ? { ...r, status: 'error' as const, error: w.interrupted } : r)),
      )
    }
    if (repo !== undefined) {
      const last = (await read($, reviews)).at(-1)
      $.ui.status(
        (await read($, isPaused))
          ? `${w.title} · ${w.status.paused}`
          : last
            ? statusLine(last, config.lang)
            : `${w.title} · ${w.status.on}`,
      )
    }
    return started
  })

  on('turn.start', async ($, e, next) => {
    // A subagent's or teammate's run belongs to the main turn, whose review covers what it changed
    if (e.agentId !== undefined || (await read($, isPaused))) return next(e)
    const repo = await repoOf($)
    if (repo === undefined) {
      pending = undefined
      return next(e)
    }
    if (e.text.trim() !== '') prompts = [...prompts, e.text.trim()].slice(-3)
    // Keep the start of a stopped (aborted) turn — the next turn's review covers both
    if (pending === undefined || pending.repo.top !== repo.top) {
      const snap = await snapshot($, repo).catch(err => String(err))
      if (typeof snap === 'string') {
        pending = undefined
        $.ui.status(cut(`${words().title} · ${words().status.snapshotFailed(snap)}`, 160))
      } else {
        pending = { repo, snap }
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.isAborted || pending === undefined) return done
    const { repo, snap } = pending
    pending = undefined
    const intent: Intent = { prompts: [...prompts], answer: e.answer }
    later($, async () => {
      const end = await snapshot($, repo)
      if (typeof end === 'string') {
        $.ui.status(cut(`${words().title} · ${words().status.snapshotFailed(end)}`, 160))
        return
      }
      const before = new Set(snap.untracked)
      const fresh = end.untracked.filter(path => !before.has(path))
      if (end.rev === snap.rev && fresh.length === 0) return
      await review($, repo, { from: snap.rev, to: end.rev, fresh }, intent, 'turn')
    })
    return done
  })

  on('command.run', { command: 'motive-mem' }, async ($, e) => {
    const w = words()
    const arg = e.args.trim().toLowerCase()
    if (arg === 'pause') {
      await update($, isPaused, () => true)
      pending = undefined
      $.ui.status(`${w.title} · ${w.status.paused}`)
      return { text: w.command.paused }
    }
    if (arg === 'resume') {
      await update($, isPaused, () => false)
      $.ui.status(`${w.title} · ${w.status.on}`)
      return { text: w.command.resumed }
    }
    if (arg === 'all') return { text: await reviewAll($) }
    if ((await repoOf($)) === undefined) return { text: await whyOff($) }
    await $.ui.open({ id: PANE, title: w.title })
    return { text: w.command.opened }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const w = words()
    const p = w.panel
    const list = await read($, reviews)
    const paused = await read($, isPaused)
    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{p.empty}</Text>
          {paused && <Text color="warning">{p.pausedBanner}</Text>}
          <Button key="all" label={p.reviewAll} hotkey="a" onPress={() => void reviewAll($)} />
        </Box>
      )
    }
    const at = await read($, cursor)
    const index = at < 0 || at >= list.length ? list.length - 1 : at
    const shown = list[index]
    if (shown === undefined) return <Text dimColor>{p.notFound}</Text>
    const open = openFindings(shown)
    // Handlers read the state as it is when pressed, not as it was drawn: two presses before a redraw both count
    const move = async (step: number) => {
      const count = (await read($, reviews)).length
      await update($, cursor, at => {
        const from = at < 0 || at >= count ? count - 1 : at
        return Math.min(count - 1, Math.max(0, from + step))
      })
    }

    return (
      <Box flexDirection="column" gap={1}>
        {paused && <Text color="warning">{p.pausedBanner}</Text>}
        <Markdown text={reviewMarkdown(shown, index, list.length, config.lang)} />
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="prev" label={p.prev} hotkey="p" dimColor={index === 0} onPress={() => move(-1)} />
          <Button
            key="next"
            label={p.next}
            hotkey="n"
            dimColor={index === list.length - 1}
            onPress={() => move(1)}
          />
          {hasIssues(shown) && (
            <Button
              key="send"
              label={p.send}
              hotkey="c"
              variant="primary"
              onPress={() => void $.prompt.fill({ text: fixPrompt(shown, config.lang), mode: 'append' })}
            />
          )}
          {shown.status !== 'running' && shown.level !== 'trivial' && (
            <Button
              key="retry"
              label={p.retry}
              hotkey="r"
              onPress={() => {
                later($, async () => {
                  const repo = await repoOf($)
                  if (repo) await review($, repo, shown.range, shown.intent, 'retry')
                })
              }}
            />
          )}
          <Button key="all" label={p.uncommitted} hotkey="a" onPress={async () => $.ui.toast(await reviewAll($))} />
        </Box>
        {open.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>{p.exceptHint}</Text>
            {open.slice(0, 9).map(({ finding, index: i }) => (
              <Button
                key={`except:${shown.id}:${i}`}
                label={p.except(i + 1, principleLabel(finding.principle, config.lang), finding.file.split('/').pop() ?? '')}
                // One digit only — the engine refuses the whole pane over a "10"
                hotkey={i < 9 ? String(i + 1) : undefined}
                dimColor
                onPress={async () => {
                  const repo = await repoOf($)
                  if (repo === undefined) return
                  let updated = undefined as Review | undefined
                  await update($, reviews, list =>
                    list.map(r => {
                      if (r.id !== shown.id || r.excepted.includes(i)) return r
                      updated = { ...r, excepted: [...r.excepted, i] }
                      return updated
                    }),
                  )
                  // Already approved by an earlier press
                  if (updated === undefined) return
                  $.ui.status(statusLine(updated, config.lang))
                  const decision: Decision = {
                    at: await $.clock.now(),
                    principle: finding.principle,
                    file: finding.file,
                    why: finding.why,
                  }
                  const saved = await appendLine($, repo, decisionLog(repo), decision, LOG_KEEP).then(
                    () => true,
                    err => {
                      $.ui.toast(words().notSaved(String(err)), { timeoutMs: 8000 })
                      return false
                    },
                  )
                  // The review's line again, with the approval, so a later session restores it approved
                  if (saved) await logReview($, repo, updated)
                }}
              />
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
