// 의도 리뷰의 순수한 부분: 원칙 문서 읽기, diff 나누기, 리뷰 요청 만들기, 답 읽기, 패널 글.
// `$` 를 쓰지 않으므로 claude plugin test 로 그대로 검사한다.

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

// ---- 원칙 문서

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
    const scope = /^\s*[-*]\s*범위\s*:\s*(.+)$/.exec(line)
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

// 사람끼리 답할 절 — 리뷰어에게는 주지 않는다 (답이 안 난 것이 기준이 되지 않게)
const NOT_FOR_REVIEWER = /^##\s+(열린 질문|확인 필요)/

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

// ---- 리뷰 요청

export const SYSTEM = `너는 이 저장소의 "의도 리뷰어"다. 한 줄씩 보는 코드 리뷰가 아니다. 사람 대신 판단하지 않는다 — 사람이 어디를 봐야 하는지 좁혀 준다.

세 가지만 판단한다.
1. 의도 일치 — diff 가 <요청> 과 <작성자 보고> 에 맞는가. 보고에 없는데 바뀐 것 가운데 요청 범위 밖이거나 다른 동작을 바꾸는 것만 "unstated" 에 넣는다 — 요청한 변경 안의 세부(값·별칭·문구·이름 고르기)는 넣지 않는다. unstated 가 하나라도 있으면 사람 앞에 패널이 열린다 — "큰 문제는 아니지만" 하고 덧붙일 것이라면 넣지 않는다. 보고가 실제보다 부풀려졌는지(검사 통과를 사용자 확인으로, 부분 충족을 완료로) 본다.
2. 원칙 위반 — <원칙> 에 적힌 원칙만 기준이다. 원칙 문서에 없는 기준을 만들지 않는다. <원칙> 의 "허용된 예외" 와 <승인된 예외> 에 해당하면 위반이 아니다.
3. 눈앞 땜질 — 국소 문제를 맞추려고 구조를 우회한 흔적: 단일 진입점을 건너뛴 쓰기·동기화, 이미 한 곳에 있는 판정·식·표의 두 번째 사본, 특정 경우만 고치는 분기, 예외를 삼켜 증상 숨기기, 테스트 기대값·스냅숏을 바꿔 통과시키기, 검사 건너뛰기(skip·xfail), 대기 시간 늘리기, 특정 과제 전용 플래그.

하지 않는 것:
- 스타일·이름·성능 취향, 더 나은 설계 제안, 방어 코드나 검증을 더하라는 제안.
- 가상의 우려("나중에 ~할 수도"). diff 에 근거가 있는 것만 말한다.
- 확신이 없으면 "violation" 이 아니라 "suspect" 로 낮춘다. 근거가 되는 diff 줄을 못 대면 말하지 않는다.
- 문제가 없으면 findings 와 unstated 를 비운다. 빈 결과가 정상이다.
- "attention" 은 findings · unstated 가운데 사람이 직접 열어 봐야 할 곳만 고른다. 둘 다 비었으면 attention 도 비운다.

답은 JSON 하나만 낸다(코드 블록 표시 없이):
{
  "summary": "이 변경이 실제로 한 일 한 문장",
  "intent": "match" | "partial" | "mismatch",
  "intent_note": "의도·보고와 다른 점 한두 문장 (일치면 빈 문자열)",
  "findings": [
    {"principle": "P03", "severity": "violation" | "suspect", "file": "경로", "line": 123, "why": "어떤 원칙을 어떻게 어기는지 한 문장", "evidence": "근거가 된 diff 줄 그대로, 짧게"}
  ],
  "unstated": ["보고에 없는데 바뀐 것 — 파일과 한 줄 설명"],
  "attention": ["사람이 꼭 볼 곳 — 파일:줄 과 이유 (최대 3개)"]
}
"line" 은 바뀐 뒤 파일의 줄 번호(@@ 의 + 쪽 기준)이고 모르면 뺀다. "principle" 은 원칙 ID 이고, 땜질인데 맞는 원칙이 없으면 "땜질" 이라 쓴다. 문장은 한국어로 쓴다.`

const KIND_ORDER: Record<FileKind, number> = {
  code: 0,
  test: 1,
  principles: 2,
  comment: 3,
  docs: 4,
  binary: 5,
}

const KIND_WORD: Record<FileKind, string> = {
  code: '코드',
  test: '테스트',
  principles: '원칙 문서',
  comment: '주석만',
  docs: '문서',
  binary: '바이너리',
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(${text.length - max}자 생략)`
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
  const tail = left.length > 0 ? `\n(분량 때문에 diff 를 뺀 파일: ${left.join(', ')})` : ''
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
}

export function buildPrompt(input: ReviewInput): { text: string; cache?: true }[] {
  const prompts = input.intent.prompts.length
    ? input.intent.prompts.map((p, i) => `${i + 1}. ${clip(p, 2000)}`).join('\n')
    : '(없음)'
  const decisions = input.decisions.length
    ? input.decisions.map(d => `- ${d.principle} ${d.file}: ${d.why}`).join('\n')
    : '(없음)'
  const byFile = new Map<string, string[]>()
  for (const [id, paths] of Object.entries(input.hits)) {
    for (const path of paths) byFile.set(path, [...(byFile.get(path) ?? []), id])
  }
  const files = input.files
    .map(f => {
      const ids = byFile.get(f.path)
      const scope = ids ? ` [원칙 범위: ${ids.join(', ')}]` : ''
      return `- ${f.path} (${KIND_WORD[f.kind]}, ${f.status}, +${f.added} -${f.removed})${scope}`
    })
    .join('\n')
  const rest = [
    `<요청> (오래된 것부터, 마지막이 이번 작업)\n${prompts}\n</요청>`,
    `<작성자 보고> (작업을 마치며 Claude 가 사람에게 한 말)\n${clip(input.intent.answer, 6000) || '(없음 — 미커밋 변경 전체 검토)'}\n</작성자 보고>`,
    `<승인된 예외> (사람이 이미 예외로 승인함 — 같은 건은 다시 지적하지 않는다)\n${decisions}\n</승인된 예외>`,
    `<바뀐 파일>\n${files}\n</바뀐 파일>`,
    `<diff>\n${budgetDiff(input.files, input.diff, input.maxDiffChars)}\n</diff>`,
  ].join('\n\n')
  return [
    { text: `<원칙>\n${forReviewer(input.principles)}\n</원칙>`, cache: true },
    { text: rest },
  ]
}

// ---- 답 읽기

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
          principle: str(f.principle) || '땜질',
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

// ---- 패널·상태 줄·Claude 에게 넘길 글

export function openFindings(review: Review): { finding: Finding; index: number }[] {
  return (review.verdict?.findings ?? [])
    .map((finding, index) => ({ finding, index }))
    .filter(({ index }) => !review.excepted.includes(index))
}

export function hasIssues(review: Review): boolean {
  const v = review.verdict
  return v !== undefined && (openFindings(review).length > 0 || v.unstated.length > 0 || v.intent !== 'match')
}

const INTENT_WORD = { match: '의도 일치', partial: '의도 일부 어긋남', mismatch: '의도와 다름' } as const

export function statusLine(review: Review): string {
  if (review.status === 'running') return '의도 리뷰 · 검토 중…'
  if (review.status === 'error') return `의도 리뷰 · 실패: ${review.error ?? ''}`.slice(0, 120)
  if (review.status === 'skipped') {
    return review.principleDocs.length > 0
      ? `의도 리뷰 · 원칙 문서가 바뀜(${review.principleDocs.join(', ')}) — 확인 필요`
      : '의도 리뷰 · 사소한 변경만(주석·문서)'
  }
  const v = review.verdict
  if (v === undefined) return '의도 리뷰'
  const open = openFindings(review)
  const violations = open.filter(x => x.finding.severity === 'violation').length
  const suspects = open.length - violations
  if (!hasIssues(review)) return `의도 리뷰 ✓ ${INTENT_WORD[v.intent]} · 지적 없음`
  const parts: string[] = [INTENT_WORD[v.intent]]
  if (violations > 0) parts.push(`위반 ${violations}`)
  if (suspects > 0) parts.push(`의심 ${suspects}`)
  if (v.unstated.length > 0) parts.push(`보고 밖 ${v.unstated.length}`)
  return `의도 리뷰 ⚠ ${parts.join(' · ')} — /motive-mem`
}

function clock(at: number): string {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

const LEVEL_WORD: Record<Level, string> = { logic: '로직 변경', tests: '테스트만', trivial: '사소한 변경' }
const ORIGIN_WORD = { turn: '턴', all: '미커밋 전체', retry: '다시 검토' } as const

function where(f: Finding): string {
  return f.line === undefined ? f.file : `${f.file}:${f.line}`
}

export function reviewMarkdown(review: Review, index: number, count: number): string {
  const out: string[] = []
  out.push(
    `**${ORIGIN_WORD[review.origin]} 리뷰 ${index + 1}/${count}** · ${clock(review.at)} · ${LEVEL_WORD[review.level]} · ${review.model}`,
  )
  out.push('')
  if (review.principleDocs.length > 0) {
    out.push(`> 원칙 문서가 바뀌었다: ${review.principleDocs.join(', ')} — 규칙이 바뀌는 변경이니 직접 확인할 것`)
    out.push('')
  }
  if (review.status === 'running') out.push('_검토 중…_')
  if (review.status === 'error') out.push(`리뷰 실패: ${review.error ?? '알 수 없음'}`)
  if (review.status === 'skipped') out.push('주석·문서·바이너리만 바뀌어 모델 리뷰를 건너뛰었다.')
  const v = review.verdict
  if (v !== undefined) {
    out.push(`**한 일** ${v.summary || '(요약 없음)'}`)
    out.push('')
    out.push(`**의도** ${INTENT_WORD[v.intent]}${v.intentNote ? ` — ${v.intentNote}` : ''}`)
    const open = openFindings(review)
    if (open.length > 0) {
      out.push('')
      out.push('**지적**')
      for (const { finding, index: i } of open) {
        const tag = finding.severity === 'violation' ? '위반' : '의심'
        out.push(`${i + 1}. [${finding.principle} ${tag}] \`${where(finding)}\` — ${finding.why}`)
        if (finding.evidence) out.push(`   \`${finding.evidence.slice(0, 160)}\``)
      }
    }
    if (review.excepted.length > 0) out.push(`\n_예외로 승인함: ${review.excepted.map(i => i + 1).join(', ')}번_`)
    if (v.unstated.length > 0) {
      out.push('')
      out.push('**보고에 없던 변경**')
      for (const line of v.unstated) out.push(`- ${line}`)
    }
    if (v.attention.length > 0) {
      out.push('')
      out.push('**사람이 볼 곳**')
      for (const line of v.attention) out.push(`- ${line}`)
    }
    if (!hasIssues(review)) {
      out.push('')
      out.push('지적 없음.')
    }
  }
  const shown = review.files.filter(f => f.kind !== 'binary').slice(0, 12)
  if (shown.length > 0) {
    out.push('')
    out.push(
      `**파일** ${shown.map(f => `${f.path.split('/').pop()}(${KIND_WORD[f.kind]})`).join(', ')}${review.files.length > shown.length ? ` 외 ${review.files.length - shown.length}` : ''}`,
    )
  }
  const hit = Object.keys(review.hits)
  if (hit.length > 0) out.push(`**원칙 범위** ${hit.join(', ')}`)
  return out.join('\n')
}

export function fixPrompt(review: Review): string {
  const v = review.verdict
  if (v === undefined) return ''
  const lines = ['의도 리뷰가 방금 변경에서 아래를 짚었다. 원칙(.claude/principles.md)을 지키는 방향으로 고쳐 줘.', '지적이 틀렸다고 보면 고치지 말고 왜 틀렸는지 말해 줘.', '']
  for (const { finding, index } of openFindings(review)) {
    const tag = finding.severity === 'violation' ? '위반' : '의심'
    lines.push(`${index + 1}. [${finding.principle} ${tag}] ${where(finding)} — ${finding.why}`)
  }
  if (v.intent !== 'match' && v.intentNote) lines.push(`- 의도: ${v.intentNote}`)
  for (const line of v.unstated) lines.push(`- 보고에 없던 변경: ${line}`)
  return lines.join('\n')
}
