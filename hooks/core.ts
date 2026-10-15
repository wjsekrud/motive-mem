// The pure part of intent review: reading the principles doc, splitting the diff, building the review
// request, reading the answer, and the panel text. No `$` here, so `claude plugin test` checks it as is.

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
const DOCS = /\.(md|txt|rst)$/i
export const BINARY =
  /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ttf|otf|woff2?|pbf|mvt|zip|7z|gz|exe|dll|pyd|so|sqlite|db|bin|npy|npz)$/i
const TEST = /(^|\/)(tests?\/|test_[^/]*$|[^/]*_test\.[^/]+$|[^/]*\.test\.[^/]+$)/i

export function isPrincipleDoc(path: string): boolean {
  return path === PRINCIPLES_PATH || path === 'CLAUDE.md' || path.endsWith('/CLAUDE.md') || path === 'AGENTS.md'
}

// ---- principles doc

// The scope field, in either language the skill writes: `- Scope:` or `- 범위:`
const SCOPE = /^\s*[-*]\s*(?:scope|범위)\s*:\s*(.+)$/i

export function parsePrinciples(text: string): Principle[] {
  const out: Principle[] = []
  let current: Principle | undefined
  for (const line of text.split(/\r?\n/)) {
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
const NOT_FOR_REVIEWER = /^##\s+(open questions|needs confirmation|열린 질문|확인 필요)/i

export function forReviewer(text: string): string {
  const out: string[] = []
  let skipping = false
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,2}\s/.test(line)) skipping = NOT_FOR_REVIEWER.test(line)
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    if (c === '*' && glob[i + 1] === '*') {
      source += '.*'
      i += glob[i + 2] === '/' ? 2 : 1
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

export function kindOf(path: string, changed: string[], isBinary: boolean): FileKind {
  if (isPrincipleDoc(path)) return 'principles'
  if (isBinary || BINARY.test(path)) return 'binary'
  if (DOCS.test(path)) return 'docs'
  if (TEST.test(path)) return 'test'
  const markers = HASH_COMMENT.test(path)
    ? ['#']
    : SLASH_COMMENT.test(path)
      ? ['//', '/*', '*']
      : undefined
  if (markers) {
    const body = changed.map(line => line.slice(1).trim()).filter(line => line !== '')
    if (body.every(line => markers.some(marker => line.startsWith(marker)))) return 'comment'
  }
  return 'code'
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
      if (line.startsWith('@@')) continue
      if (line.startsWith('+')) {
        added++
        changed.push(line)
      } else if (line.startsWith('-')) {
        removed++
        changed.push(line)
      }
    }
    const path = status === 'deleted' ? from : to || from
    if (path === '') continue
    out.push({ path, status, added, removed, kind: kindOf(path, changed, isBinary), lines: changed })
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

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(${text.length - max} chars cut)`
}

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
  const order = [...files].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
  const kept: string[] = []
  const left: string[] = []
  let room = maxChars
  for (const file of order) {
    const chunk = chunks.get(file.path)
    if (chunk === undefined || file.kind === 'binary') continue
    if (chunk.length <= room) {
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
    ? input.decisions.map(d => `- ${d.principle} ${d.file}: ${d.why}`).join('\n')
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
    `<request> (oldest first; the last one is this task)\n${prompts}\n</request>`,
    `<author_report> (what Claude told the human when it finished)\n${clip(input.intent.answer, 6000) || '(none — reviewing all uncommitted changes)'}\n</author_report>`,
    `<approved_exceptions> (the human already approved these as exceptions — do not raise the same thing again)\n${decisions}\n</approved_exceptions>`,
    `<changed_files>\n${files}\n</changed_files>`,
    `<diff>\n${budgetDiff(input.files, input.diff, input.maxDiffChars)}\n</diff>`,
    answerIn(input.lang),
  ].join('\n\n')
  return [
    { text: `<principles>\n${forReviewer(input.principles)}\n</principles>`, cache: true },
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
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const strs = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
  const findings: Finding[] = Array.isArray(o.findings)
    ? o.findings.flatMap(item => {
        if (typeof item !== 'object' || item === null) return []
        const f = item as Record<string, unknown>
        const why = str(f.why)
        if (why === '') return []
        const finding: Finding = {
          principle: str(f.principle) || WORKAROUND,
          severity: f.severity === 'violation' ? 'violation' : 'suspect',
          file: str(f.file),
          why,
          evidence: str(f.evidence),
        }
        if (typeof f.line === 'number' && Number.isFinite(f.line)) finding.line = Math.round(f.line)
        return [finding]
      })
    : []
  return {
    summary: str(o.summary),
    intent: o.intent === 'partial' || o.intent === 'mismatch' ? o.intent : 'match',
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
  if (review.status === 'error') return `${w.title} · ${s.failed(review.error ?? '')}`.slice(0, 120)
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
        out.push(`${i + 1}. ${tag(finding, lang)} \`${where(finding)}\` — ${finding.why}`)
        if (finding.evidence) out.push(`   \`${finding.evidence.slice(0, 160)}\``)
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
  if (v.intent !== 'match' && v.intentNote) lines.push(`- ${w.fix.intent}: ${v.intentNote}`)
  for (const line of v.unstated) lines.push(`- ${w.fix.unstated}: ${line}`)
  return lines.join('\n')
}
