// What the plugin shows a person, in each language it speaks — chosen by the `language` option.
// The reviewer's prompt is not here: it lives in core.ts, in English, and only its output language follows this.

import type { FileKind, Level, Review, Verdict } from '../types'

export type Lang = 'en' | 'ko'

export function langOf(value: unknown): Lang {
  return value === 'ko' ? 'ko' : 'en'
}

export type Words = {
  title: string
  intent: Record<Verdict['intent'], string>
  level: Record<Level, string>
  origin: Record<Review['origin'], string>
  kind: Record<FileKind, string>
  severity: Record<'violation' | 'suspect', string>
  workaround: string
  status: {
    on: string
    paused: string
    running: string
    failed: (error: string) => string
    docsChanged: (docs: string) => string
    trivial: string
    noFindings: string
    violations: (n: number) => string
    suspects: (n: number) => string
    unstated: (n: number) => string
    snapshotFailed: (why: string) => string
  }
  panel: {
    header: (origin: string, nth: number, count: number) => string
    docsChanged: (docs: string) => string
    running: string
    failed: (error: string) => string
    unknown: string
    skipped: string
    did: string
    noSummary: string
    findings: string
    excepted: (numbers: number[]) => string
    unstated: string
    attention: string
    noFindings: string
    files: string
    more: (n: number) => string
    inScope: string
    empty: string
    pausedBanner: string
    notFound: string
    prev: string
    next: string
    send: string
    retry: string
    reviewAll: string
    uncommitted: string
    exceptHint: string
    except: (nth: number, principle: string, file: string) => string
  }
  fix: { intro: string[]; intent: string; unstated: string }
  command: {
    description: string
    notRepo: string
    noPrinciples: (path: string) => string
    nothing: string
    noHead: string
    reviewingAll: string
    paused: string
    resumed: string
    opened: string
  }
  docsChangedToast: (docs: string) => string
  unreadable: (text: string) => string
  interrupted: string
  notSaved: (error: string) => string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const en: Words = {
  title: 'Intent review',
  intent: { match: 'matches intent', partial: 'partly off intent', mismatch: 'off intent' },
  level: { logic: 'logic change', tests: 'tests only', trivial: 'trivial change' },
  origin: { turn: 'Turn', all: 'Uncommitted', retry: 'Re-run' },
  kind: {
    code: 'code',
    test: 'test',
    principles: 'principles doc',
    comment: 'comments only',
    docs: 'docs',
    binary: 'binary',
  },
  severity: { violation: 'violation', suspect: 'suspect' },
  workaround: 'workaround',
  status: {
    on: 'on',
    paused: 'paused',
    running: 'reviewing…',
    failed: error => `failed: ${error}`,
    docsChanged: docs => `principle docs changed (${docs}) — check them`,
    trivial: 'trivial change only (comments, docs)',
    noFindings: 'no findings',
    violations: n => plural(n, 'violation'),
    suspects: n => plural(n, 'suspect'),
    unstated: n => `${n} not in report`,
    snapshotFailed: why => `could not snapshot the work tree, this turn is not reviewed (${why})`,
  },
  panel: {
    header: (origin, nth, count) => `${origin} review ${nth}/${count}`,
    docsChanged: docs => `Principle docs changed: ${docs} — this changes the rules, check it yourself`,
    running: 'Reviewing…',
    failed: error => `Review failed: ${error}`,
    unknown: 'unknown',
    skipped: 'Only comments, docs or binaries changed — skipped the model review.',
    did: 'What it did',
    noSummary: '(no summary)',
    findings: 'Findings',
    excepted: numbers => `Approved as exceptions: ${numbers.map(n => `#${n}`).join(', ')}`,
    unstated: 'Changed but not in the report',
    attention: 'Where to look',
    noFindings: 'No findings.',
    files: 'Files',
    more: n => ` and ${n} more`,
    inScope: 'In scope of',
    empty: 'No reviews yet. They show up here when a turn that changed code ends.',
    pausedBanner: 'Automatic review paused — /motive-mem resume',
    notFound: 'Review not found.',
    prev: '◀ Prev',
    next: 'Next ▶',
    send: 'Send to Claude',
    retry: 'Review again',
    reviewAll: 'Review all uncommitted',
    uncommitted: 'All uncommitted',
    exceptHint: "Wrong finding? Approve it as an exception — later reviews won't raise the same thing again.",
    except: (nth, principle, file) => `Approve #${nth} as exception (${principle} ${file})`,
  },
  fix: {
    intro: [
      'The intent review flagged the following in the last change. Fix it so the principles (.claude/principles.md) hold.',
      "If you think a finding is wrong, don't change the code — say why it is wrong.",
    ],
    intent: 'Intent',
    unstated: 'Changed but not in the report',
  },
  command: {
    description: 'Open the intent review panel · all: review all uncommitted changes · pause / resume: stop or restart automatic review',
    notRepo: 'Intent review is idle: this is not a git repository.',
    noPrinciples: path => `Intent review is idle: no ${path}. To create one, run /motive-mem:principles`,
    nothing: 'Nothing to review.',
    noHead: 'Could not read HEAD.',
    reviewingAll: 'Reviewing all uncommitted changes. The result shows in the status line and the panel.',
    paused: 'Automatic review paused. To turn it back on: /motive-mem resume',
    resumed: 'Automatic review is back on, from the next turn.',
    opened: 'Opened the intent review panel.',
  },
  docsChangedToast: docs => `Principle docs changed: ${docs}`,
  unreadable: text => `could not read the answer: ${text}`,
  interrupted: `stopped before it finished — review it again`,
  notSaved: error => `Could not save the approval: ${error}`,
}

const ko: Words = {
  title: '의도 리뷰',
  intent: { match: '의도 일치', partial: '의도 일부 어긋남', mismatch: '의도와 다름' },
  level: { logic: '로직 변경', tests: '테스트만', trivial: '사소한 변경' },
  origin: { turn: '턴', all: '미커밋 전체', retry: '다시 검토' },
  kind: {
    code: '코드',
    test: '테스트',
    principles: '원칙 문서',
    comment: '주석만',
    docs: '문서',
    binary: '바이너리',
  },
  severity: { violation: '위반', suspect: '의심' },
  workaround: '땜질',
  status: {
    on: '켜짐',
    paused: '멈춤',
    running: '검토 중…',
    failed: error => `실패: ${error}`,
    docsChanged: docs => `원칙 문서가 바뀜(${docs}) — 확인 필요`,
    trivial: '사소한 변경만(주석·문서)',
    noFindings: '지적 없음',
    violations: n => `위반 ${n}`,
    suspects: n => `의심 ${n}`,
    unstated: n => `보고 밖 ${n}`,
    snapshotFailed: why => `작업 트리를 찍지 못해 이번 턴은 리뷰하지 않음 (${why})`,
  },
  panel: {
    header: (origin, nth, count) => `${origin} 리뷰 ${nth}/${count}`,
    docsChanged: docs => `원칙 문서가 바뀌었다: ${docs} — 규칙이 바뀌는 변경이니 직접 확인할 것`,
    running: '검토 중…',
    failed: error => `리뷰 실패: ${error}`,
    unknown: '알 수 없음',
    skipped: '주석·문서·바이너리만 바뀌어 모델 리뷰를 건너뛰었다.',
    did: '한 일',
    noSummary: '(요약 없음)',
    findings: '지적',
    excepted: numbers => `예외로 승인함: ${numbers.join(', ')}번`,
    unstated: '보고에 없던 변경',
    attention: '사람이 볼 곳',
    noFindings: '지적 없음.',
    files: '파일',
    more: n => ` 외 ${n}`,
    inScope: '원칙 범위',
    empty: '아직 리뷰가 없습니다. 코드를 바꾼 턴이 끝나면 여기에 나옵니다.',
    pausedBanner: '자동 리뷰 멈춤 — /motive-mem resume',
    notFound: '리뷰를 찾지 못했습니다.',
    prev: '◀ 이전',
    next: '다음 ▶',
    send: 'Claude에게 전달',
    retry: '다시 검토',
    reviewAll: '미커밋 전체 검토',
    uncommitted: '미커밋 전체',
    exceptHint: '틀린 지적이면 예외로 승인 — 다음 리뷰부터 같은 건을 다시 짚지 않습니다.',
    except: (nth, principle, file) => `${nth}번 예외 승인 (${principle} ${file})`,
  },
  fix: {
    intro: [
      '의도 리뷰가 방금 변경에서 아래를 짚었다. 원칙(.claude/principles.md)을 지키는 방향으로 고쳐 줘.',
      '지적이 틀렸다고 보면 고치지 말고 왜 틀렸는지 말해 줘.',
    ],
    intent: '의도',
    unstated: '보고에 없던 변경',
  },
  command: {
    description: '의도 리뷰 패널 열기 · all: 미커밋 전체 검토 · pause / resume: 자동 리뷰 멈춤·재개',
    notRepo: 'git 저장소가 아니라 의도 리뷰가 쉬고 있습니다.',
    noPrinciples: path => `${path} 가 없어 의도 리뷰가 쉬고 있습니다. 원칙 파일을 만들려면 /motive-mem:principles`,
    nothing: '검토할 변경이 없습니다.',
    noHead: 'HEAD 를 읽지 못했습니다.',
    reviewingAll: '미커밋 변경 전체를 검토합니다. 끝나면 상태 줄과 패널에 나옵니다.',
    paused: '자동 리뷰를 멈췄습니다. 다시 켜려면 /motive-mem resume',
    resumed: '자동 리뷰를 다시 켰습니다. 다음 턴부터 봅니다.',
    opened: '의도 리뷰 패널을 열었습니다.',
  },
  docsChangedToast: docs => `원칙 문서가 바뀌었습니다: ${docs}`,
  unreadable: text => `답을 읽지 못함: ${text}`,
  interrupted: `끝나기 전에 멈춤 — 다시 검토할 것`,
  notSaved: error => `예외 승인을 저장하지 못했습니다: ${error}`,
}

export const WORDS: Record<Lang, Words> = { en, ko }
