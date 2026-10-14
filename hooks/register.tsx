// 의도 리뷰: 턴이 끝나면 그 턴에 바뀐 것을 저장소의 .claude/principles.md 에 비춰 다른 모델이 따로 본다.
// 작성자(Claude)의 추론은 넘기지 않고 요청 · 보고 · diff · 원칙만 준다. 결과는 상태 줄 · 토스트 · 패널.
// 턴의 시작과 끝을 `git stash create` 로 찍어(작업 트리를 건드리지 않는다) 그 사이 diff 만 본다.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision, FileChange, Intent, Review } from '../types'
import {
  BINARY,
  PRINCIPLES_PATH,
  SYSTEM,
  buildPrompt,
  fixPrompt,
  hasIssues,
  levelOf,
  openFindings,
  parseDiff,
  parsePrinciples,
  parseVerdict,
  reviewMarkdown,
  scopeHits,
  statusLine,
  untrackedChunk,
} from './core'

type Engine = EngineInterface
type Repo = { top: string; gitDir: string }
type Snap = { rev: string; untracked: string[] }

const PANE = 'motive-mem'
const TITLE = '의도 리뷰'
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

// 모드가 켜지는 조건: git 저장소이고 원칙 파일이 있다
async function repoOf($: Engine): Promise<Repo | undefined> {
  const repo = await gitRepo($)
  if (repo === undefined) return undefined
  return (await $.fs.exists(`${repo.top}/${PRINCIPLES_PATH}`)) ? repo : undefined
}

// 왜 쉬고 있는지 — 명령으로 불렀을 때 안내
async function whyOff($: Engine): Promise<string> {
  return (await gitRepo($)) === undefined
    ? 'git 저장소가 아니라 의도 리뷰가 쉬고 있습니다.'
    : `${PRINCIPLES_PATH} 가 없어 의도 리뷰가 쉬고 있습니다. 원칙 파일을 만들려면 /motive-mem:principles`
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

// ---- 기록 (.git/motive-mem — 저장소 파일이 아니라 다음 턴 diff 에 끼지 않는다)

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

// ---- 상태

async function put($: Engine, review: Review) {
  await update($, reviews, list => [...list.filter(r => r.id !== review.id), review].slice(-KEEP))
  await update($, cursor, () => -1)
}

async function replace($: Engine, review: Review) {
  await update($, reviews, list => list.map(r => (r.id === review.id ? review : r)))
}

// ---- 리뷰 (모듈 변수는 다시 불러오면 처음부터 — 리뷰 목록은 $.state 에 있다)

type Config = { model: string; effort: 'low' | 'medium' | 'high'; maxDiffChars: number; openOnIssue: boolean }

let config: Config = { model: 'sonnet', effort: 'medium', maxDiffChars: 60_000, openOnIssue: true }
let pending: { repo: Repo; snap: Snap } | undefined
let prompts: string[] = []
let serial = 0

async function review(
  $: Engine,
  repo: Repo,
  range: Review['range'],
  intent: Intent,
  origin: Review['origin'],
) {
  const { files, diff } = await changes($, repo, range.from, range.to, range.fresh)
  if (files.length === 0) {
    if (origin !== 'turn') $.ui.toast('검토할 변경이 없습니다.')
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
  $.ui.status(statusLine(draft))
  if (draft.principleDocs.length > 0) {
    $.ui.toast(`원칙 문서가 바뀌었습니다: ${draft.principleDocs.join(', ')}`)
  }
  if (draft.status === 'skipped') {
    await appendLine($, reviewLog(repo), draft, 500)
    return
  }

  const decisions = await readLines<Decision>($, decisionLog(repo), 30)
  const answer = await $.model.complete({
    model: config.model,
    effort: config.effort,
    system: SYSTEM,
    prompt: buildPrompt({ principles: principlesText, decisions, intent, files, diff, hits, maxDiffChars: config.maxDiffChars }),
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
        ? { ...draft, status: 'error', error: `답을 읽지 못함: ${answer.text.slice(0, 120)}` }
        : { ...draft, status: 'done', verdict }
  }
  await replace($, done)
  $.ui.status(statusLine(done))
  await appendLine($, reviewLog(repo), done, 500)
  if (hasIssues(done)) {
    const first = openFindings(done)[0]?.finding
    $.ui.toast(first ? `${first.principle}: ${first.why}` : statusLine(done), { timeoutMs: 8000 })
    if (config.openOnIssue) void $.ui.open({ id: PANE, title: TITLE })
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
  if (head.exitCode !== 0 || now === undefined) return 'HEAD 를 읽지 못했습니다.'
  const range = { from: head.stdout.trim(), to: now.rev, fresh: now.untracked }
  later($, () => review($, repo, range, { prompts: [...prompts], answer: '' }, 'all'))
  return '미커밋 변경 전체를 검토합니다. 끝나면 상태 줄과 패널에 나옵니다.'
}

export const register: Register = (on, options) => {
  config = {
    model: String(options.model ?? 'sonnet'),
    effort: String(options.effort ?? 'medium') as Config['effort'],
    maxDiffChars: Number(options.maxDiffChars ?? 60_000),
    openOnIssue: options.openOnIssue !== false,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'motive-mem',
      description: '의도 리뷰 패널 열기 · all: 미커밋 전체 검토 · pause / resume: 자동 리뷰 멈춤·재개',
    })
    const repo = await repoOf($)
    if (repo !== undefined && (await read($, reviews)).length === 0) {
      const saved = await readLines<Review>($, reviewLog(repo), KEEP)
      if (saved.length > 0) await update($, reviews, () => saved)
    }
    const last = (await read($, reviews)).at(-1)
    if (repo !== undefined) $.ui.status(last ? statusLine(last) : '의도 리뷰 · 켜짐')
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (!(await read($, isPaused))) {
      const repo = await repoOf($)
      if (repo === undefined) {
        pending = undefined
      } else {
        if (e.text.trim() !== '') prompts = [...prompts, e.text.trim()].slice(-3)
        // 멈춘(중단된) 턴의 시작점은 남겨 둔다 — 다음 턴 리뷰가 둘을 같이 본다
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
    const arg = e.args.trim()
    if (arg === 'pause') {
      await update($, isPaused, () => true)
      pending = undefined
      $.ui.status('의도 리뷰 · 멈춤')
      return { text: '자동 리뷰를 멈췄습니다. 다시 켜려면 /motive-mem resume' }
    }
    if (arg === 'resume') {
      await update($, isPaused, () => false)
      $.ui.status('의도 리뷰 · 켜짐')
      return { text: '자동 리뷰를 다시 켰습니다. 다음 턴부터 봅니다.' }
    }
    if (arg === 'all') return { text: await reviewAll($) }
    if ((await repoOf($)) === undefined) return { text: await whyOff($) }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: '의도 리뷰 패널을 열었습니다.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const list = await read($, reviews)
    const paused = await read($, isPaused)
    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>아직 리뷰가 없습니다. 코드를 바꾼 턴이 끝나면 여기에 나옵니다.</Text>
          {paused && <Text color="warning">자동 리뷰 멈춤 — /motive-mem resume</Text>}
          <Button key="all" label="미커밋 전체 검토" hotkey="a" onPress={() => void reviewAll($)} />
        </Box>
      )
    }
    const at = await read($, cursor)
    const index = at < 0 || at >= list.length ? list.length - 1 : at
    const shown = list[index]
    if (shown === undefined) return <Text dimColor>리뷰를 찾지 못했습니다.</Text>
    const open = openFindings(shown)
    const move = (step: number) =>
      update($, cursor, () => Math.min(list.length - 1, Math.max(0, index + step)))

    return (
      <Box flexDirection="column" gap={1}>
        {paused && <Text color="warning">자동 리뷰 멈춤 — /motive-mem resume</Text>}
        <Markdown text={reviewMarkdown(shown, index, list.length)} />
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="prev" label="◀ 이전" hotkey="p" dimColor={index === 0} onPress={() => move(-1)} />
          <Button
            key="next"
            label="다음 ▶"
            hotkey="n"
            dimColor={index === list.length - 1}
            onPress={() => move(1)}
          />
          {hasIssues(shown) && (
            <Button
              key="send"
              label="Claude에게 전달"
              hotkey="c"
              variant="primary"
              onPress={() => void $.prompt.fill({ text: fixPrompt(shown) })}
            />
          )}
          {shown.status !== 'running' && shown.level !== 'trivial' && (
            <Button
              key="retry"
              label="다시 검토"
              hotkey="r"
              onPress={() => {
                later($, async () => {
                  const repo = await repoOf($)
                  if (repo) await review($, repo, shown.range, shown.intent, 'retry')
                })
              }}
            />
          )}
          <Button key="all" label="미커밋 전체" hotkey="a" onPress={() => void reviewAll($)} />
        </Box>
        {open.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>틀린 지적이면 예외로 승인 — 다음 리뷰부터 같은 건을 다시 짚지 않습니다.</Text>
            {open.slice(0, 9).map(({ finding, index: i }) => (
              <Button
                key={`except:${shown.id}:${i}`}
                label={`${i + 1}번 예외 승인 (${finding.principle} ${finding.file.split('/').pop()})`}
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
                  $.ui.status(statusLine(updated))
                }}
              />
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
