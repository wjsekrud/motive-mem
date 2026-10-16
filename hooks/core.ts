// The pure part of intent review: reading the principles doc, splitting the diff, building the review
// request, reading the answer, the panel text, and the locking of the shared logs (given a lock and a clock).
// No `$` here, so `claude plugin test` checks it as is.

import type {
  Decision,
  FileChange,
  FileKind,
  Finding,
  Intent,
  Level,
  Principle,
  Review,
  Verdict,
} from '../types'
import { WORDS, type Lang } from './text'

export const PRINCIPLES_PATH = '.claude/principles.md'

const HASH_COMMENT = /\.(py|ps1|psm1|sh|toml|ya?ml|cfg|ini|spec)$/i
const SLASH_COMMENT = /\.(m?[jt]sx?|c[jt]s|css|scss|c|h|cpp|hpp|cs|java|go|rs|swift|kt)$/i
const CSS = /\.(css|scss)$/i
const DOCS = /\.(md|txt|rst)$/i
// Text files the build reads — a change to them is not a docs change
const BUILD_TEXT = /(^|\/)(requirements[^/]*|constraints[^/]*|CMakeLists)\.txt$/i
// Comments the toolchain reads: silencing a check or switching a build flag is not a comment-only change
const DIRECTIVE =
  /^(#!|\/\/\/|\/\/\s*(go:|\+build))|@ts-|eslint|prettier-ignore|istanbul ignore|c8 ignore|noqa|type:|pylint|mypy|pyright|nolint|clang-format|pragma|-\*-|#requires/i
export const BINARY =
  /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ttf|otf|woff2?|pbf|mvt|zip|7z|gz|exe|dll|pyd|so|sqlite|db|bin|npy|npz)$/i
const TEST = /(^|\/)(tests?\/|test_[^/]*$|[^/]*_test\.[^/]+$|[^/]*\.test\.[^/]+$)/i

export function isPrincipleDoc(path: string): boolean {
  return path === PRINCIPLES_PATH || path === 'CLAUDE.md' || path.endsWith('/CLAUDE.md') || path === 'AGENTS.md'
}

// ---- principles doc

// The scope field, in either language the skill writes: `- Scope:` or `- 범위:`
const SCOPE = /^\s*[-*]\s*(?:scope|범위)\s*:\s*(.+)$/i

// The lines of a markdown file, each with whether it sits inside a ``` or ~~~ fence (a `#` there is not a heading)
function markdownLines(text: string): { line: string; isFenced: boolean }[] {
  let fence = ''
  return text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map(line => {
      const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
      if (mark !== undefined && (fence === '' || mark.startsWith(fence))) {
        fence = fence === '' ? mark : ''
        return { line, isFenced: true }
      }
      return { line, isFenced: fence !== '' }
    })
}

export function parsePrinciples(text: string): Principle[] {
  const out: Principle[] = []
  let current: Principle | undefined
  for (const { line, isFenced } of markdownLines(text)) {
    if (isFenced) continue
    const head = /^##\s+([A-Z]\d{1,3})\s+(.+?)\s*$/.exec(line)
    if (head) {
      current = { id: head[1] ?? '', title: head[2] ?? '', scope: [] }
      out.push(current)
      continue
    }
    if (/^#{1,2}\s/.test(line)) {
      current = undefined
      continue
    }
    const scope = SCOPE.exec(line)
    if (scope && current) {
      current.scope.push(
        ...(scope[1] ?? '')
          .split(',')
          .map(part => part.replace(/`/g, '').trim())
          .filter(Boolean),
      )
    }
  }
  return out
}

// Sections for people to settle among themselves — kept from the reviewer so an unanswered question
// never becomes a criterion
// — at any heading level, until the next heading of the same level or higher
const NOT_FOR_REVIEWER = /^(#{1,6})\s+[*_]*\s*(open questions|needs confirmation|열린\s*질문|확인\s*필요)/i

export function forReviewer(text: string): string {
  const out: string[] = []
  let cutLevel = 0
  for (const { line, isFenced } of markdownLines(text)) {
    const level = isFenced ? 0 : (/^(#{1,6})\s/.exec(line)?.[1]?.length ?? 0)
    if (level > 0) {
      if (cutLevel > 0 && level <= cutLevel) cutLevel = 0
      if (cutLevel === 0 && NOT_FOR_REVIEWER.test(line)) cutLevel = level
    }
    if (cutLevel === 0) out.push(line)
  }
  return out.join('\n')
}

export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` is zero or more whole folders; a trailing `**` is anything below
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i += 1
      }
    } else if (c === '*') {
      source += '[^/]*'
    } else if (c === '?') {
      source += '[^/]'
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

export function scopeHits(principles: Principle[], paths: string[]): Record<string, string[]> {
  const hits: Record<string, string[]> = {}
  for (const principle of principles) {
    const patterns = principle.scope.map(globToRegExp)
    const matched = paths.filter(path => patterns.some(re => re.test(path)))
    if (matched.length > 0) hits[principle.id] = matched
  }
  return hits
}

// ---- diff

function headerPath(raw: string, prefix: string): string {
  let path = raw.replace(/\t$/, '')
  if (path === '/dev/null') return ''
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

// A changed line that is only a comment. Leaning towards "no": a comment wrongly taken for code costs one review,
// code wrongly taken for a comment skips the review.
function isCommentLine(path: string, line: string): boolean {
  if (DIRECTIVE.test(line)) return false
  if (HASH_COMMENT.test(path)) return line.startsWith('#')
  if (!SLASH_COMMENT.test(path)) return false
  if (line.startsWith('//')) return true
  // `/* … */ code` is code
  if (line.startsWith('/*')) return !/\*\/\s*\S/.test(line)
  // A block's middle or end line: `* text`, `*`, `*/` — not `*ptr = 1` or a CSS `* {`
  return /^\*(\s|\/|$)/.test(line) && !(CSS.test(path) && /[{};]/.test(line))
}

export function kindOf(
  path: string,
  changed: string[],
  isBinary: boolean,
  more: { from?: string; wrapsCode?: boolean } = {},
): FileKind {
  if (isPrincipleDoc(path) || (more.from !== undefined && isPrincipleDoc(more.from))) return 'principles'
  if (isBinary || BINARY.test(path)) return 'binary'
  if (DOCS.test(path) && !BUILD_TEXT.test(path)) return 'docs'
  if (TEST.test(path)) return 'test'
  const body = changed.map(line => line.slice(1).trim()).filter(line => line !== '')
  // No changed lines (a rename, a mode change) or a block comment opened around unchanged lines: code
  if (body.length === 0 || (more.wrapsCode && SLASH_COMMENT.test(path))) return 'code'
  return body.every(line => isCommentLine(path, line)) ? 'comment' : 'code'
}

export function parseDiff(diff: string): FileChange[] {
  const out: FileChange[] = []
  for (const chunk of diff.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split('\n')
    const pair = /^a\/(.*) b\/(.*)$/.exec(lines[0] ?? '')
    let from = pair?.[1] ?? ''
    let to = pair?.[2] ?? ''
    let status: FileChange['status'] = 'modified'
    let isBinary = false
    let isInHunk = false
    let added = 0
    let removed = 0
    const changed: string[] = []
    // A block comment a changed line opens (`/*` with no `*/` after it) that is still open at an unchanged line
    // comments that code out — or, on the `-` side, back in
    const open = { '+': false, '-': false }
    let wrapsCode = false
    for (const line of lines.slice(1)) {
      if (!isInHunk) {
        if (line.startsWith('--- ')) from = headerPath(line.slice(4), 'a/')
        else if (line.startsWith('+++ ')) to = headerPath(line.slice(4), 'b/')
        else if (line.startsWith('new file mode')) status = 'added'
        else if (line.startsWith('deleted file mode')) status = 'deleted'
        else if (line.startsWith('rename from ')) {
          status = 'renamed'
          from = line.slice('rename from '.length)
        } else if (line.startsWith('rename to ')) to = line.slice('rename to '.length)
        else if (line.startsWith('Binary files ')) isBinary = true
        else if (line.startsWith('@@')) isInHunk = true
        continue
      }
      if (line.startsWith('@@')) {
        if (open['+'] || open['-']) wrapsCode = true
        open['+'] = open['-'] = false
        continue
      }
      const sign = line.charAt(0)
      if (sign === '+' || sign === '-') {
        if (sign === '+') added++
        else removed++
        changed.push(line)
        const opens = line.lastIndexOf('/*')
        const closes = line.lastIndexOf('*/')
        if (opens > closes) open[sign] = true
        else if (closes > opens) open[sign] = false
      } else if (sign === ' ' && (open['+'] || open['-'])) {
        wrapsCode = true
      }
    }
    if (open['+'] || open['-']) wrapsCode = true
    const path = status === 'deleted' ? from : to || from
    if (path === '') continue
    out.push({ path, status, added, removed, kind: kindOf(path, changed, isBinary, { from, wrapsCode }), lines: changed })
  }
  return out
}

export function untrackedChunk(path: string, text: string): string {
  const body = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${body.length} @@`,
    ...body.map(line => `+${line}`),
    '',
  ].join('\n')
}

export function levelOf(files: { kind: FileKind }[]): Level {
  if (files.some(file => file.kind === 'code')) return 'logic'
  if (files.some(file => file.kind === 'test')) return 'tests'
  return 'trivial'
}

// ---- review request (in English whatever the language; only the answer's sentences follow `lang`)

const ANSWER_LANGUAGE: Record<Lang, string> = { en: 'English', ko: 'Korean' }

// The `principle` a band-aid gets when no principle covers it. Older logs hold the Korean '땜질'.
export const WORKAROUND = 'workaround'

export function systemPrompt(lang: Lang): string {
  return `You are this repository's "intent reviewer". This is not a line-by-line code review. You do not decide in the human's place — you narrow down where the human should look.

Judge only three things.
1. Intent match — does the diff match <request> and <author_report>? Of the changes the report does not mention, put in "unstated" only those outside the request's scope or that change other behavior — not details inside the requested change (choice of values, aliases, wording, names). Any entry in "unstated" opens a panel in front of the human — if you would add "not a big deal, but", leave it out. Check whether the report claims more than happened (passing checks presented as user confirmation, partial presented as done).
2. Principle violations — only the principles written in <principles> count. Do not invent criteria the principles document does not state. Anything covered by the allowed exceptions in <principles> or by <approved_exceptions> is not a violation. A principle's scope is a hint of where it usually bites, not a boundary: a change outside it that does what the principle forbids still breaks it.
3. Band-aid fixes — signs of routing around the structure to make a local problem go away: a write or sync that skips the single entry point, a second copy of a rule, formula or table that already lives in one place, a branch that fixes only one specific case, swallowing an exception to hide a symptom, changing test expectations or snapshots to make them pass, skipping checks (skip, xfail), lengthening waits, a flag for one particular task.

What you do not do:
- Style, naming or performance taste; proposals for a better design; suggestions to add defensive code or validation.
- Hypothetical concerns ("this might … later"). Say only what the diff gives grounds for.
- When unsure, lower "violation" to "suspect". If you cannot point to the diff line it rests on, do not say it.
- When nothing is wrong, leave findings and unstated empty. An empty result is normal.
- "attention" picks, from findings and unstated, only the places a human must open themselves. If both are empty, leave attention empty too.

Answer with a single JSON object only (no code fence):
{
  "summary": "one sentence on what this change actually did",
  "intent": "match" | "partial" | "mismatch",
  "intent_note": "one or two sentences on how it differs from the intent and the report (empty string if it matches)",
  "findings": [
    {"principle": "P03", "severity": "violation" | "suspect", "file": "path", "line": 123, "why": "one sentence: which principle it breaks and how", "evidence": "the diff line it rests on, verbatim, short"}
  ],
  "unstated": ["a change not in the report — the file and a one-line description"],
  "attention": ["where the human must look — file:line and why (at most 3)"]
}
"line" is the line number in the file after the change (the + side of @@); omit it if unknown. "principle" is the ID of the principle the finding breaks — use it whenever one applies, band-aids included; write "${WORKAROUND}" only for a band-aid that no principle covers. ${answerIn(lang)} Quote evidence as it appears in the diff.`
}

function answerIn(lang: Lang): string {
  return `Write every sentence of the answer in ${ANSWER_LANGUAGE[lang]}, whatever language the request, report and principles are in.`
}

const KIND_ORDER: Record<FileKind, number> = {
  code: 0,
  test: 1,
  principles: 2,
  comment: 3,
  docs: 4,
  binary: 5,
}

const KIND_NAME: Record<FileKind, string> = {
  code: 'code',
  test: 'test',
  principles: 'principles doc',
  comment: 'comments only',
  docs: 'docs',
  binary: 'binary',
}

// The first `max` UTF-16 units, never ending on half of a surrogate pair (the API refuses a lone one)
export function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const end = Math.max(0, max)
  return text.slice(0, /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) ? end - 1 : end)
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${cut(text, max)}\n…(${text.length - max} chars cut)`
}

// The request's own tags, defused inside what goes between them — a report, a diff or a principles file that
// closes </author_report> and opens <approved_exceptions> must not read as the request's structure
const TAGS = /<(\/?)(principles|request|author_report|approved_exceptions|changed_files|diff)>/gi
const untag = (text: string) => text.replace(TAGS, '‹$1$2›')

function chunksByPath(diff: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const file = parseDiff(chunk)[0]
    if (file) map.set(file.path, chunk)
  }
  return map
}

export function budgetDiff(files: FileChange[], diff: string, maxChars: number): string {
  const chunks = chunksByPath(diff)
  // Code first; within a kind the smaller first, so one big file (a lockfile, generated data) cannot push the rest out
  const size = (f: FileChange) => chunks.get(f.path)?.length ?? 0
  const order = [...files].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || size(a) - size(b))
  const kept: string[] = []
  const left: string[] = []
  let room = maxChars
  for (const file of order) {
    if (file.kind === 'binary') continue
    const chunk = chunks.get(file.path)
    if (chunk === undefined) {
      left.push(`${file.path} (+${file.added} -${file.removed})`)
    } else if (chunk.length <= room) {
      kept.push(chunk)
      room -= chunk.length
    } else if (kept.length === 0) {
      kept.push(clip(chunk, room))
      room = 0
    } else {
      left.push(`${file.path} (+${file.added} -${file.removed})`)
    }
  }
  const tail = left.length > 0 ? `\n(diff left out for length: ${left.join(', ')})` : ''
  return kept.join('') + tail
}

export type ReviewInput = {
  principles: string
  decisions: Decision[]
  intent: Intent
  files: FileChange[]
  diff: string
  hits: Record<string, string[]>
  maxDiffChars: number
  lang: Lang
}

export function buildPrompt(input: ReviewInput): { text: string; cache?: true }[] {
  const prompts = input.intent.prompts.length
    ? input.intent.prompts.map((p, i) => `${i + 1}. ${clip(p, 2000)}`).join('\n')
    : '(none)'
  const decisions = input.decisions.length
    ? untag(input.decisions.map(d => `- ${d.principle} ${d.file}: ${d.why}`).join('\n'))
    : '(none)'
  const byFile = new Map<string, string[]>()
  for (const [id, paths] of Object.entries(input.hits)) {
    for (const path of paths) byFile.set(path, [...(byFile.get(path) ?? []), id])
  }
  const files = input.files
    .map(f => {
      const ids = byFile.get(f.path)
      const scope = ids ? ` [in scope of: ${ids.join(', ')}]` : ''
      return `- ${f.path} (${KIND_NAME[f.kind]}, ${f.status}, +${f.added} -${f.removed})${scope}`
    })
    .join('\n')
  const rest = [
    `<request> (oldest first; the last one is this task)\n${untag(prompts)}\n</request>`,
    `<author_report> (what Claude told the human when it finished)\n${untag(clip(input.intent.answer, 6000)) || (input.intent.isAll ? '(none — reviewing all uncommitted changes)' : '(none)')}\n</author_report>`,
    `<approved_exceptions> (the human already approved these as exceptions — do not raise the same thing again)\n${decisions}\n</approved_exceptions>`,
    `<changed_files>\n${untag(files)}\n</changed_files>`,
    `<diff>\n${untag(budgetDiff(input.files, input.diff, input.maxDiffChars))}\n</diff>`,
    answerIn(input.lang),
  ].join('\n\n')
  return [
    { text: `<principles>\n${untag(forReviewer(input.principles))}\n</principles>`, cache: true },
    { text: rest },
  ]
}

// ---- reading the answer

export function parseVerdict(text: string): Verdict | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  // An answer that does not say match / partial / mismatch, or whose lists are not lists, is unreadable —
  // never a clean pass
  const intent = typeof o.intent === 'string' ? o.intent.trim().toLowerCase() : ''
  if (intent !== 'match' && intent !== 'partial' && intent !== 'mismatch') return undefined
  if (o.findings !== undefined && !Array.isArray(o.findings)) return undefined
  // One line each: the panel shows these inside markdown
  const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
  const strs = (v: unknown) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []).map(str).filter(Boolean)
  const findings: Finding[] = (Array.isArray(o.findings) ? o.findings : []).flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const f = item as Record<string, unknown>
    const why = str(f.why) || str(f.reason) || str(f.description)
    if (why === '') return []
    const finding: Finding = {
      principle: str(f.principle) || WORKAROUND,
      severity: str(f.severity).toLowerCase() === 'violation' ? 'violation' : 'suspect',
      file: str(f.file),
      why,
      evidence: str(f.evidence),
    }
    if (typeof f.line === 'number' && Number.isFinite(f.line)) finding.line = Math.round(f.line)
    return [finding]
  })
  return {
    summary: str(o.summary),
    intent,
    intentNote: str(o.intent_note),
    findings,
    unstated: strs(o.unstated),
    attention: strs(o.attention).slice(0, 3),
  }
}

// ---- panel, status line, and the text handed back to Claude

export function openFindings(review: Review): { finding: Finding; index: number }[] {
  return (review.verdict?.findings ?? [])
    .map((finding, index) => ({ finding, index }))
    .filter(({ index }) => !review.excepted.includes(index))
}

export function hasIssues(review: Review): boolean {
  const v = review.verdict
  return v !== undefined && (openFindings(review).length > 0 || v.unstated.length > 0 || v.intent !== 'match')
}

export function principleLabel(id: string, lang: Lang): string {
  return id === WORKAROUND || id === '땜질' ? WORDS[lang].workaround : id
}

function tag(finding: Finding, lang: Lang): string {
  return `[${principleLabel(finding.principle, lang)} ${WORDS[lang].severity[finding.severity]}]`
}

export function statusLine(review: Review, lang: Lang): string {
  const w = WORDS[lang]
  const s = w.status
  if (review.status === 'running') return `${w.title} · ${s.running}`
  if (review.status === 'error') return cut(`${w.title} · ${s.failed(review.error ?? '')}`.replace(/\s+/g, ' '), 120)
  if (review.status === 'skipped') {
    return review.principleDocs.length > 0
      ? `${w.title} · ${s.docsChanged(review.principleDocs.join(', '))}`
      : `${w.title} · ${s.trivial}`
  }
  const v = review.verdict
  if (v === undefined) return w.title
  const open = openFindings(review)
  const violations = open.filter(x => x.finding.severity === 'violation').length
  const suspects = open.length - violations
  if (!hasIssues(review)) return `${w.title} ✓ ${w.intent[v.intent]} · ${s.noFindings}`
  const parts: string[] = [w.intent[v.intent]]
  if (violations > 0) parts.push(s.violations(violations))
  if (suspects > 0) parts.push(s.suspects(suspects))
  if (v.unstated.length > 0) parts.push(s.unstated(v.unstated.length))
  return `${w.title} ⚠ ${parts.join(' · ')} — /motive-mem`
}

function clock(at: number): string {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

function where(f: Finding): string {
  return f.line === undefined ? f.file : `${f.file}:${f.line}`
}

// Inline code that holds backticks of its own
function code(text: string): string {
  const fence = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length)) + 1)
  return fence.length > 1 ? `${fence} ${text} ${fence}` : `\`${text}\``
}

export function reviewMarkdown(review: Review, index: number, count: number, lang: Lang): string {
  const w = WORDS[lang]
  const p = w.panel
  const out: string[] = []
  out.push(
    `**${p.header(w.origin[review.origin], index + 1, count)}** · ${clock(review.at)} · ${w.level[review.level]} · ${review.model}`,
  )
  out.push('')
  if (review.principleDocs.length > 0) {
    out.push(`> ${p.docsChanged(review.principleDocs.join(', '))}`)
    out.push('')
  }
  if (review.status === 'running') out.push(`_${p.running}_`)
  if (review.status === 'error') out.push(p.failed(review.error ?? p.unknown))
  if (review.status === 'skipped') out.push(p.skipped)
  const v = review.verdict
  if (v !== undefined) {
    out.push(`**${p.did}** ${v.summary || p.noSummary}`)
    out.push('')
    out.push(`**${w.intent[v.intent]}**${v.intentNote ? ` — ${v.intentNote}` : ''}`)
    const open = openFindings(review)
    if (open.length > 0) {
      out.push('')
      out.push(`**${p.findings}**`)
      for (const { finding, index: i } of open) {
        out.push(`${i + 1}. ${tag(finding, lang)} ${code(where(finding))} — ${finding.why}`)
        if (finding.evidence) out.push(`   ${code(cut(finding.evidence, 160))}`)
      }
    }
    if (review.excepted.length > 0) out.push(`\n_${p.excepted(review.excepted.map(i => i + 1))}_`)
    if (v.unstated.length > 0) {
      out.push('')
      out.push(`**${p.unstated}**`)
      for (const line of v.unstated) out.push(`- ${line}`)
    }
    if (v.attention.length > 0) {
      out.push('')
      out.push(`**${p.attention}**`)
      for (const line of v.attention) out.push(`- ${line}`)
    }
    if (!hasIssues(review)) {
      out.push('')
      out.push(p.noFindings)
    }
  }
  const shown = review.files.filter(f => f.kind !== 'binary').slice(0, 12)
  if (shown.length > 0) {
    out.push('')
    out.push(
      `**${p.files}** ${shown.map(f => `${f.path.split('/').pop()}(${w.kind[f.kind]})`).join(', ')}${review.files.length > shown.length ? p.more(review.files.length - shown.length) : ''}`,
    )
  }
  const hit = Object.keys(review.hits)
  if (hit.length > 0) out.push(`**${p.inScope}** ${hit.join(', ')}`)
  return out.join('\n')
}

export function fixPrompt(review: Review, lang: Lang): string {
  const v = review.verdict
  if (v === undefined) return ''
  const w = WORDS[lang]
  const lines = [...w.fix.intro, '']
  for (const { finding, index } of openFindings(review)) {
    lines.push(`${index + 1}. ${tag(finding, lang)} ${where(finding)} — ${finding.why}`)
  }
  if (v.intent !== 'match') lines.push(`- ${w.fix.intent}: ${v.intentNote || w.intent[v.intent]}`)
  for (const line of v.unstated) lines.push(`- ${w.fix.unstated}: ${line}`)
  return lines.join('\n')
}

// ---- logs that several sessions write (.git/motive-mem)

// $.fs refuses to read a file over 4 MiB, so a log stays well under it — even when every character takes 3 bytes
export const LOG_MAX_CHARS = 1_000_000

// The log's text after adding one value, keeping the last `keep` lines and no more than `maxChars`
export function appendedLog(text: string, value: unknown, keep: number, maxChars = LOG_MAX_CHARS): string {
  const lines = [...text.split('\n').filter(Boolean), JSON.stringify(value)].slice(-keep)
  let size = lines.reduce((sum, line) => sum + line.length + 1, 0)
  while (lines.length > 1 && size > maxChars) size -= (lines.shift()?.length ?? 0) + 1
  return `${lines.join('\n')}\n`
}

// A review as the log keeps it: the request and the report clipped as the reviewer saw them, and only the new
// files a retry would look at
export function forLog(review: Review, freshLimit: number): Review {
  return {
    ...review,
    range: { ...review.range, fresh: review.range.fresh.slice(0, freshLimit) },
    intent: {
      ...review.intent,
      prompts: review.intent.prompts.map(p => cut(p, 2000)),
      answer: cut(review.intent.answer, 6000),
    },
  }
}

// Reviews read back from the log: the last line of each id wins (a later approval rewrites one), in time order
export function latestById(list: Review[], keep: number): Review[] {
  const byId = new Map<string, Review>()
  for (const review of list) {
    byId.delete(review.id)
    byId.set(review.id, review)
  }
  return [...byId.values()].sort((a, b) => a.at - b.at).slice(-keep)
}

// A lock other processes can see. register.tsx keeps it in a git ref that `update-ref` creates only when absent.
export type Lock = {
  // Takes the lock if it is free: the id to drop it by, or undefined when someone else holds it (or it failed)
  take: (stamp: string) => Promise<string | undefined>
  // Who holds it: the stamp they took it with and its id, or undefined when free
  peek: () => Promise<{ id: string; stamp: string } | undefined>
  // Drops the lock only while it is still `id`
  drop: (id: string) => Promise<void>
}

export type Clock = { now: () => Promise<number>; sleep: (ms: number) => Promise<void> }

// A holder that crashed leaves its lock behind; past `staleMs` it is broken. Past `waitMs` the work runs unlocked —
// one log line at risk is better than a review or an approval that never gets written. (A lock that fails while
// nobody holds it — a leftover ref lockfile, a read-only repository — also ends there. It is not given up sooner:
// under contention "free but not taken" is just someone else's turn, and giving up then loses lines.)
export const LOCK_LIMITS = { staleMs: 5_000, waitMs: 8_000, stepMs: 50 }

const stampTime = (stamp: string) => Number(stamp.split(' ').at(-1))

export async function withLock<T>(
  lock: Lock,
  clock: Clock,
  owner: string,
  work: () => Promise<T>,
  limits = LOCK_LIMITS,
): Promise<T> {
  const start = await clock.now()
  let held: string | undefined
  for (;;) {
    held = await lock.take(`${owner} ${await clock.now()}`).catch(() => undefined)
    if (held !== undefined) break
    const now = await clock.now()
    if (now - start >= limits.waitMs) break
    const holder = await lock.peek().catch(() => undefined)
    // An unreadable stamp is NaN, which never counts as fresh
    if (holder !== undefined && !(now - stampTime(holder.stamp) < limits.staleMs)) {
      await lock.drop(holder.id).catch(() => undefined)
    }
    await clock.sleep(limits.stepMs)
  }
  try {
    return await work()
  } finally {
    if (held !== undefined) await lock.drop(held).catch(() => undefined)
  }
}

// Runs the work it is given one at a time, in the order given — a session's own writes never interleave
export function inOrder(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return work => {
    const run = tail.then(work)
    tail = run.catch(() => undefined)
    return run
  }
}
