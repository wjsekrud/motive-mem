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
  buildPrompt,
  fixPrompt,
  hasIssues,
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

async function git($: Engine, repo: string, args: string[], timeoutMs = 30_000) {
  return $.process.run(['git', '-c', 'core.quotepath=off', '-C', repo, ...args], { timeoutMs })
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

async function snapshot($: Engine, repo: Repo): Promise<Snap | undefined> {
  const stash = await git($, repo.top, ['stash', 'create'])
  let rev = stash.exitCode === 0 ? stash.stdout.trim() : ''
  if (rev === '') {
    const head = await git($, repo.top, ['rev-parse', 'HEAD'])
    rev = head.exitCode === 0 ? head.stdout.trim() : ''
  }
  if (rev === '') return undefined
  const listed = await git($, repo.top, ['ls-files', '--others', '--exclude-standard', '-z'])
  return { rev, untracked: listed.stdout.split('\0').filter(Boolean) }
}

async function changes(
  $: Engine,
  repo: Repo,
  from: string,
  to: string,
  fresh: string[],
): Promise<{ files: FileChange[]; diff: string }> {
  const out = await git($, repo.top, ['diff', '--no-color', '--no-ext-diff', '-M', '-U3', from, to])
  let diff = out.exitCode === 0 ? out.stdout : ''
  const files = parseDiff(diff)
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

async function appendLine($: Engine, path: string, value: unknown, keep: number) {
  const text = await $.fs.read(path).catch(() => '')
  const lines = [...text.split('\n').filter(Boolean), JSON.stringify(value)].slice(-keep)
  await $.fs.write(path, `${lines.join('\n')}\n`)
}

const reviewLog = (repo: Repo) => `${repo.gitDir}/motive-mem/reviews.jsonl`
const decisionLog = (repo: Repo) => `${repo.gitDir}/motive-mem/decisions.jsonl`

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
  const principlesText = await $.fs.read(`${repo.top}/${PRINCIPLES_PATH}`)
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
    await appendLine($, reviewLog(repo), draft, 500)
    return
  }

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
    maxTokens: 4000,
    timeoutMs: 240_000,
  })
  let done: Review
  if (!answer.isAnswered) {
    done = { ...draft, status: 'error', error: answer.reason }
  } else {
    const verdict = parseVerdict(answer.text)
    done =
      verdict === undefined
        ? { ...draft, status: 'error', error: words().unreadable(answer.text.slice(0, 120)) }
        : { ...draft, status: 'done', verdict }
  }
  await replace($, done)
  $.ui.status(statusLine(done, config.lang))
  await appendLine($, reviewLog(repo), done, 500)
  if (hasIssues(done)) {
    const first = openFindings(done)[0]?.finding
    $.ui.toast(
      first ? `${principleLabel(first.principle, config.lang)}: ${first.why}` : statusLine(done, config.lang),
      { timeoutMs: 8000 },
    )
    if (config.openOnIssue) void $.ui.open({ id: PANE, title: words().title })
  }
}

function later($: Engine, work: () => Promise<void>) {
  $.clock.after(0, () => {
    work().catch(err => $.ui.log(`motive-mem: ${String(err)}`, { to: 'debug' }))
  })
}

async function reviewAll($: Engine) {
  const repo = await repoOf($)
  if (repo === undefined) return whyOff($)
  const head = await git($, repo.top, ['rev-parse', 'HEAD'])
  const now = await snapshot($, repo)
  if (head.exitCode !== 0 || now === undefined) return words().command.noHead
  const range = { from: head.stdout.trim(), to: now.rev, fresh: now.untracked }
  later($, () => review($, repo, range, { prompts: [...prompts], answer: '' }, 'all'))
  return words().command.reviewingAll
}

export const register: Register = (on, options) => {
  config = {
    model: String(options.model ?? 'sonnet'),
    effort: String(options.effort ?? 'medium') as Config['effort'],
    maxDiffChars: Number(options.maxDiffChars ?? 60_000),
    openOnIssue: options.openOnIssue !== false,
    lang: langOf(options.language),
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'motive-mem', description: words().command.description })
    const repo = await repoOf($)
    if (repo !== undefined && (await read($, reviews)).length === 0) {
      const saved = await readLines<Review>($, reviewLog(repo), KEEP)
      if (saved.length > 0) await update($, reviews, () => saved)
    }
    const last = (await read($, reviews)).at(-1)
    if (repo !== undefined) {
      $.ui.status(last ? statusLine(last, config.lang) : `${words().title} · ${words().status.on}`)
    }
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (!(await read($, isPaused))) {
      const repo = await repoOf($)
      if (repo === undefined) {
        pending = undefined
      } else {
        if (e.text.trim() !== '') prompts = [...prompts, e.text.trim()].slice(-3)
        // Keep the start of a stopped (aborted) turn — the next turn's review covers both
        if (pending === undefined || pending.repo.top !== repo.top) {
          const snap = await snapshot($, repo).catch(() => undefined)
          pending = snap === undefined ? undefined : { repo, snap }
        }
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
      if (end === undefined) return
      const before = new Set(snap.untracked)
      const fresh = end.untracked.filter(path => !before.has(path))
      if (end.rev === snap.rev && fresh.length === 0) return
      await review($, repo, { from: snap.rev, to: end.rev, fresh }, intent, 'turn')
    })
    return done
  })

  on('command.run', { command: 'motive-mem' }, async ($, e) => {
    const w = words()
    const arg = e.args.trim()
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
    const move = (step: number) =>
      update($, cursor, () => Math.min(list.length - 1, Math.max(0, index + step)))

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
              onPress={() => void $.prompt.fill({ text: fixPrompt(shown, config.lang) })}
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
          <Button key="all" label={p.uncommitted} hotkey="a" onPress={() => void reviewAll($)} />
        </Box>
        {open.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>{p.exceptHint}</Text>
            {open.slice(0, 9).map(({ finding, index: i }) => (
              <Button
                key={`except:${shown.id}:${i}`}
                label={p.except(i + 1, principleLabel(finding.principle, config.lang), finding.file.split('/').pop() ?? '')}
                hotkey={String(i + 1)}
                dimColor
                onPress={async () => {
                  const repo = await repoOf($)
                  if (repo === undefined) return
                  const decision: Decision = {
                    at: await $.clock.now(),
                    principle: finding.principle,
                    file: finding.file,
                    why: finding.why,
                  }
                  await appendLine($, decisionLog(repo), decision, 200)
                  const updated = { ...shown, excepted: [...shown.excepted, i] }
                  await replace($, updated)
                  $.ui.status(statusLine(updated, config.lang))
                }}
              />
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
