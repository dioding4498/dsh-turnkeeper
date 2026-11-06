/**
 * dsh-turnkeeper — per-turn cost meter + runtime guardrails.
 *
 * The turnkeeper keeps the clock and the gate: it measures real wall-clock cost
 * per turn (model / tools / idle), and refuses, before dispatch, the calls that
 * break the standing rules — a long silent chain of tool calls, the third
 * attempt at something that already failed twice, or a rerun of a command known
 * to take minutes in the foreground.
 *
 * Two jobs:
 *  1. Measure real wall-clock cost per turn (model / tools / idle) and expose
 *     `turn_cost` so the agent closes every turn with one honest line.
 *  2. Enforce, not advise: `tools/pre-execute` denies calls that break the
 *     standing rules — more than N root tool calls without an interim report,
 *     the third attempt at a tool that already failed twice, and re-running a
 *     command that is known to take minutes in the foreground.
 *
 * Every denial carries a machine-readable reason, so the model corrects itself
 * on the next step instead of burning another minute on the same mistake.
 */
import { readFileSync, statSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = ['tools']

const MAX_TURNS = 40

/**
 * Defaults. Live values come from `$DSH_HOME/turn-cost.config.json`, re-read
 * whenever its mtime changes, so thresholds can be tuned without a reload.
 */
const DEFAULTS = {
  stepGate: 8,
  stepGateMode: 'dynamic',
  stepGateFloor: 4,
  stepGateCeil: 20,
  stepGateMultiplier: 1.4,
  stepGateMinSamples: 5,
  stepGateWindowDays: 7,
  stepGateWorkTurnMin: 3,
  retryGate: 2,
  slowLearnMs: 30_000,
  slowBlockMs: 60_000,
  exempt: ['turn_cost', 'ask_user_question', 'todo_write', 'send_message', 'exit_plan_mode'],
  enabled: true,
}

const SHELL_TOOLS = /^(pwsh|powershell|bash|sh|shell|exec|ops_bash|run_command|terminal)$/i

const ledgerDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'))
const ledgerPath = join(ledgerDir, 'turnkeeper.jsonl')
const configPath = join(ledgerDir, 'turnkeeper.config.json')

function normalizeConfig(raw) {
  const number = (key, floor) => {
    const value = Number(raw?.[key])
    return Number.isFinite(value) && value >= floor ? Math.round(value) : DEFAULTS[key]
  }
  const bounded = (key, floor, ceiling) => {
    const value = Number(raw?.[key])
    if (!Number.isFinite(value)) return DEFAULTS[key]
    return Math.min(Math.max(Math.round(value), floor), ceiling)
  }
  const ratio = (key) => {
    const value = Number(raw?.[key])
    return Number.isFinite(value) && value >= 1 && value <= 5 ? value : DEFAULTS[key]
  }
  const exempt = Array.isArray(raw?.exempt)
    ? raw.exempt.filter(item => typeof item === 'string')
    : DEFAULTS.exempt
  const gateFloor = bounded('stepGateFloor', 2, 60)
  const gateCeiling = bounded('stepGateCeil', gateFloor + 1, 60)
  return {
    stepGate: number('stepGate', 1),
    stepGateMode: raw?.stepGateMode === 'fixed' ? 'fixed' : DEFAULTS.stepGateMode,
    stepGateFloor: gateFloor,
    stepGateCeil: gateCeiling,
    stepGateMultiplier: ratio('stepGateMultiplier'),
    stepGateMinSamples: bounded('stepGateMinSamples', 1, 200),
    stepGateWindowDays: bounded('stepGateWindowDays', 1, 90),
    stepGateWorkTurnMin: bounded('stepGateWorkTurnMin', 0, 30),
    retryGate: number('retryGate', 1),
    slowLearnMs: number('slowLearnMs', 500),
    slowBlockMs: number('slowBlockMs', 500),
    exempt: new Set(exempt),
    enabled: raw?.enabled !== false,
  }
}

let configCache = { mtimeMs: -1, value: normalizeConfig(DEFAULTS) }

function config() {
  try {
    const stat = statSync(configPath)
    if (stat.mtimeMs !== configCache.mtimeMs) {
      configCache = { mtimeMs: stat.mtimeMs, value: normalizeConfig(JSON.parse(readFileSync(configPath, 'utf8'))) }
    }
  } catch {
    // Missing or malformed file: keep the last good values.
  }
  return configCache.value
}

const clock = () => Date.now()

/** How often the dynamic step gate re-reads the ledger. */
const GATE_REFRESH_MS = 5 * 60_000

/**
 * The live step-gate ceiling. Recomputed from the ledger every few minutes:
 * the 80th percentile of tool calls per turn over the recent window, times a
 * headroom factor, bounded by floor and ceiling. Too few samples (a fresh
 * install) keeps the configured constant, so the gate never starts at zero.
 */
const gateState = { gate: DEFAULTS.stepGate, samples: 0, p80: 0, source: 'fixed', at: 0 }

async function refreshGate() {
  const cfg = config()
  const at = clock()
  if (cfg.stepGateMode === 'fixed') {
    Object.assign(gateState, { gate: cfg.stepGate, samples: 0, p80: 0, source: 'fixed', at })
    return gateState
  }
  let calls = []
  try {
    const since = at - cfg.stepGateWindowDays * 86_400_000
    calls = (await readLedger())
      .filter((record) => {
        const stamp = Date.parse(record?.at)
        return Number.isFinite(stamp) && stamp >= since
      })
      .map(record => Number(record?.toolCalls) || 0)
      .filter(count => count > 0 && count >= cfg.stepGateWorkTurnMin)
      .sort((a, b) => a - b)
  } catch {
    calls = []
  }
  if (calls.length < cfg.stepGateMinSamples) {
    Object.assign(gateState, { gate: cfg.stepGate, samples: calls.length, p80: 0, source: 'fixed', at })
    return gateState
  }
  const p80 = calls[Math.min(calls.length - 1, Math.floor(calls.length * 0.8))]
  const gate = Math.min(Math.max(Math.ceil(p80 * cfg.stepGateMultiplier) + 2, cfg.stepGateFloor), cfg.stepGateCeil)
  Object.assign(gateState, { gate, samples: calls.length, p80, source: 'dynamic', at })
  return gateState
}

function gateBasis() {
  if (gateState.source !== 'dynamic') return `上限 ${gateState.gate} 次`
  return `动态上限 ${gateState.gate} 次，依据近 ${config().stepGateWindowDays} 天 ${gateState.samples} 个有效工作轮（≥${config().stepGateWorkTurnMin} 次调用）的 80 分位 ${gateState.p80} 次`
}

function stateFor(store, sessionId) {
  let entry = store.get(sessionId)
  if (entry === undefined) {
    entry = { turns: new Map(), guards: new Map(), order: [], slow: new Map(), lastTurn: 0 }
    store.set(sessionId, entry)
  }
  return entry
}

function bucketFor(store, sessionId, turn) {
  const entry = stateFor(store, sessionId)
  let bucket = entry.turns.get(turn)
  if (bucket === undefined) {
    bucket = {
      turn,
      startedAt: clock(),
      modelMs: 0,
      modelCalls: 0,
      toolMs: 0,
      toolCalls: 0,
      tools: [],
      errors: 0,
      retries: 0,
    }
    entry.turns.set(turn, bucket)
    entry.order.push(turn)
    entry.lastTurn = Math.max(entry.lastTurn, turn)
    while (entry.order.length > MAX_TURNS) {
      const old = entry.order.shift()
      entry.turns.delete(old)
      entry.guards.delete(old)
    }
  }
  return bucket
}

function guardFor(store, sessionId, turn) {
  const entry = stateFor(store, sessionId)
  let guard = entry.guards.get(turn)
  if (guard === undefined) {
    guard = { calls: 0, blocked: 0, byStep: 0, byRetry: 0, bySlow: 0, failures: new Map(), gated: false, lastDeny: '' }
    entry.guards.set(turn, guard)
  }
  return guard
}

function seconds(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function percent(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0
}

function commandOf(args) {
  if (typeof args === 'string') return args
  if (args === null || typeof args !== 'object') return ''
  const value = args.command ?? args.cmd ?? args.script ?? args.code
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join(' ')
  return ''
}

function prefixOf(command) {
  return command.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function isBackgrounded(args, command) {
  if (args !== null && typeof args === 'object' && (args.run_in_background === true || args.background === true)) return true
  return /\b(Start-Job|nohup|run_in_background)\b|-Background\b/i.test(command)
}

function summarize(bucket, finishedAt) {
  const totalMs = Math.max(finishedAt - bucket.startedAt, 0)
  const otherMs = Math.max(totalMs - bucket.modelMs - bucket.toolMs, 0)
  const slowest = [...bucket.tools].sort((a, b) => b.ms - a.ms).slice(0, 3)
  const top = slowest.length > 0 ? slowest.map(entry => `${entry.name} ${seconds(entry.ms)}`).join('、') : '无'
  const line = `第 ${bucket.turn} 轮 ${seconds(totalMs)}：模型 ${seconds(bucket.modelMs)}(${percent(bucket.modelMs, totalMs)}%, ${bucket.modelCalls} 次) / 工具 ${seconds(bucket.toolMs)}(${percent(bucket.toolMs, totalMs)}%, ${bucket.toolCalls} 次) / 其它 ${seconds(otherMs)}`
  const detail = [
    `最慢工具：${top}`,
    bucket.retries > 0 || bucket.errors > 0 ? `重试 ${bucket.retries} 次，报错 ${bucket.errors} 次` : '',
  ].filter(Boolean).join('；')
  return { turn: bucket.turn, totalMs, modelMs: bucket.modelMs, toolMs: bucket.toolMs, otherMs, modelCalls: bucket.modelCalls, toolCalls: bucket.toolCalls, retries: bucket.retries, errors: bucket.errors, slowest: slowest.map(e => `${e.name} ${seconds(e.ms)}`), line, detail }
}

function guardLine(guard) {
  if (guard === undefined) return ''
  const parts = []
  if (guard.byStep > 0) parts.push(`步数闸门 ${guard.byStep}`)
  if (guard.byRetry > 0) parts.push(`重试熔断 ${guard.byRetry}`)
  if (guard.bySlow > 0) parts.push(`慢命令拦截 ${guard.bySlow}`)
  return guard.blocked === 0 ? '护栏本轮未拦截。' : `护栏本轮拦截 ${guard.blocked} 次（${parts.join('、')}）。`
}

function advise(summary) {
  const total = summary.totalMs
  if (total <= 0) return { kind: 'empty', text: '本轮没有可测耗时。' }
  const toolShare = percent(summary.toolMs, total)
  const modelShare = percent(summary.modelMs, total)
  const otherShare = percent(summary.otherMs, total)
  if (summary.retries > 0 || summary.errors > 0) return { kind: 'retry', text: '有失败与重试，下轮先确认路径再动手，失败最多重试一次。' }
  if (toolShare >= 50 && summary.toolCalls > 0) return { kind: 'tool', text: `工具占 ${toolShare}%，下轮把长命令放后台、合并重复调用，先给计划再执行。` }
  if (modelShare >= 60) return { kind: 'model', text: `模型生成占 ${modelShare}%，上下文偏重，下轮先压缩历史、少读大文件。` }
  if (otherShare >= 30) return { kind: 'idle', text: `空转占 ${otherShare}%，多半在等用户或后台回调，下轮先做独立步骤再回来收结果。` }
  return { kind: 'balanced', text: '分布均衡，保持当前节奏。' }
}

async function readLedger() {
  try {
    const text = await readFile(ledgerPath, 'utf8')
    const records = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        // Torn or truncated line: skip it, keep the rest.
      }
    }
    return records
  } catch {
    return []
  }
}

const decisionsPath = join(ledgerDir, 'turnkeeper.decisions.jsonl')
const policyPath = join(ledgerDir, 'turnkeeper.policy.json')

/**
 * Adopting advice must change what happens next, not just add a line to a log.
 * Each kind maps to a time-boxed runtime cap that the pre-execute guard honours,
 * so the model is actually stopped instead of politely reminded.
 */
const POLICY_WINDOW_MS = 24 * 3_600_000
const POLICY_BY_KIND = {
  model: { gate: 8 },
  retry: { retryGate: 1 },
  tool: { slowBlockMs: 30_000 },
}

let policyCache = { text: '', value: {} }

function readPolicySync() {
  try {
    const text = readFileSync(policyPath, 'utf8')
    if (policyCache.text === text) return policyCache.value
    const parsed = JSON.parse(text)
    policyCache = { text, value: parsed !== null && typeof parsed === 'object' ? parsed : {} }
    return policyCache.value
  } catch {
    return {}
  }
}

function activePolicy() {
  const all = readPolicySync()
  const now = Date.now()
  const live = {}
  for (const [kind, entry] of Object.entries(all)) {
    const until = Date.parse(entry?.until)
    if (Number.isFinite(until) && until > now) live[kind] = entry
  }
  return live
}

/** Smallest active cap for one numeric key, or undefined when nothing is adopted. */
function policyCap(key) {
  let best
  for (const entry of Object.values(activePolicy())) {
    const value = Number(entry?.[key])
    if (!Number.isFinite(value) || value <= 0) continue
    best = best === undefined ? value : Math.min(best, value)
  }
  return best
}

async function adoptPolicy(kind, decision) {
  const all = { ...readPolicySync() }
  const shape = POLICY_BY_KIND[kind]
  if (decision !== 'accept' || shape === undefined) {
    if (all[kind] === undefined) return
    delete all[kind]
  } else {
    all[kind] = { ...shape, at: new Date().toISOString(), until: new Date(Date.now() + POLICY_WINDOW_MS).toISOString() }
  }
  try {
    await mkdir(ledgerDir, { recursive: true })
    await writeFile(policyPath, `${JSON.stringify(all, null, 2)}\n`, 'utf8')
    policyCache = { text: '', value: {} }
  } catch {
    // A policy we cannot persist must not break the decision itself.
  }
}

async function readDecisions() {
  try {
    const text = await readFile(decisionsPath, 'utf8')
    const items = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        items.push(JSON.parse(trimmed))
      } catch {
        // Skip a torn decision line.
      }
    }
    return items
  } catch {
    return []
  }
}

/**
 * Advice categories. Two turns sharing a kind get the same advice, so the
 * repeats can be folded or muted instead of repeating the same paragraph.
 */
function kindOf(record) {
  if (typeof record?.adviceKind === 'string' && record.adviceKind !== '') return record.adviceKind
  const text = String(record?.suggestion ?? '')
  if (/重试|报错/.test(text)) return 'retry'
  if (/工具占/.test(text)) return 'tool'
  if (/模型生成占/.test(text)) return 'model'
  if (/空转占/.test(text)) return 'idle'
  if (/分布均衡/.test(text)) return 'balanced'
  if (/没有可测耗时/.test(text)) return 'empty'
  return 'other'
}

const MUTE_WINDOW_MS = 7 * 86_400_000

function adviceState(record, sessionDecisions, seen) {
  const kind = kindOf(record)
  const at = Date.parse(record?.at)
  const muted = sessionDecisions.some(item => kindOf({ adviceKind: item.kind, suggestion: '' }) === kind
    && Number.isFinite(at)
    && Number.isFinite(Date.parse(item.at))
    && Date.parse(item.at) <= at
    && Date.parse(item.at) + MUTE_WINDOW_MS > at)
  const repeatOf = seen.get(kind) ?? 0
  seen.set(kind, record.turn)
  return { kind, muted, repeatOf }
}

function aggregateDays(records, days) {
  const since = Date.now() - days * 86_400_000
  const picked = records.filter((record) => {
    const at = Date.parse(record?.at)
    return Number.isFinite(at) && at >= since
  })
  if (picked.length === 0) return undefined
  const sum = (key) => picked.reduce((total, record) => total + (Number(record?.[key]) || 0), 0)
  const totalMs = sum('totalMs')
  const modelMs = sum('modelMs')
  const toolMs = sum('toolMs')
  const otherMs = Math.max(totalMs - modelMs - toolMs, 0)
  const blocked = sum('blocked')
  const byStep = sum('byStep')
  const byRetry = sum('byRetry')
  const bySlow = sum('bySlow')
  const daysUsed = new Set(picked.map(record => String(record.at).slice(0, 10)))
  const perDay = new Map()
  for (const record of picked) {
    const day = String(record.at).slice(0, 10)
    const entry = perDay.get(day) ?? { turns: 0, ms: 0 }
    entry.turns += 1
    entry.ms += Number(record.totalMs) || 0
    perDay.set(day, entry)
  }
  const busiest = [...perDay.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 3)
  const line = `最近 ${days} 天：${picked.length} 轮 / ${daysUsed.size} 个活跃日，合计 ${seconds(totalMs)}（模型 ${percent(modelMs, totalMs)}% / 工具 ${percent(toolMs, totalMs)}% / 其他 ${percent(otherMs, totalMs)}%）`
  const detail = `最忙的几天：${busiest.map(([day, entry]) => `${day} ${entry.turns} 轮 ${seconds(entry.ms)}`).join('、')}；日均 ${seconds(totalMs / Math.max(daysUsed.size, 1))}`
  const guard = blocked === 0
    ? '护栏期间未拦截。'
    : `护栏共拦截 ${blocked} 次（步数 ${byStep} / 重试 ${byRetry} / 慢命令 ${bySlow}）`
  return { line, detail, guard, suggestion: advise({ totalMs, modelMs, toolMs, otherMs, retries: sum('retries'), errors: sum('errors'), toolCalls: sum('toolCalls') }).text }
}

async function appendLedger(record) {
  try {
    await mkdir(ledgerDir, { recursive: true })
    await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // The ledger is a convenience; never fail a turn over it.
  }
}

/**
 * Interim report: an assistant message that carries substantive prose, with or
 * without tool calls alongside it. Only silent tool-call chains count as
 * "no report yet" — that is the behaviour the gate exists to stop.
 */
function reportsProgress(message) {
  const content = message?.content
  if (!Array.isArray(content)) return false
  return content.some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length >= 12)
}

function releaseGate(store, sessionId, turn) {
  const guard = stateFor(store, sessionId).guards.get(turn)
  if (guard === undefined) return
  guard.calls = 0
  guard.gated = false
}

export function apply(ctx) {
  const store = new Map()
  let lastActive = undefined
  let lastTurn = 0

  ctx.effect(() => {
    void refreshGate()
    const timer = setInterval(() => { void refreshGate() }, GATE_REFRESH_MS)
    return () => clearInterval(timer)
  }, 'turnkeeper: dynamic step gate')

  const decisionPath = decisionsPath

  const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

  const toneOf = (record) => {
    const total = Number(record?.totalMs) || 0
    if (total <= 0) return 'info'
    const toolShare = (Number(record?.toolMs) || 0) / total
    if ((Number(record?.blocked) || 0) > 0 || (Number(record?.errors) || 0) > 0) return 'warn'
    if (toolShare >= 0.7) return 'warn'
    if (toolShare < 0.5 && (Number(record?.modelMs) || 0) / total < 0.6) return 'good'
    return 'info'
  }

  const summaryFor = async (sessionId) => {
    const records = (await readLedger())
      .filter(record => String(record?.session ?? '') === String(sessionId ?? ''))
    const decisions = (await readDecisions())
      .filter(item => String(item?.session ?? '') === String(sessionId ?? ''))
    const seen = new Map()
    return records.map(record => ({ record, ...adviceState(record, decisions, seen) })).slice(-20).map(({ record, kind, muted, repeatOf }) => ({
      turn: record.turn,
      totalMs: record.totalMs,
      modelMs: record.modelMs,
      toolMs: record.toolMs,
      toolCalls: record.toolCalls,
      modelCalls: record.modelCalls,
      retries: record.retries,
      errors: record.errors,
      blocked: record.blocked,
      slowest: record.slowest,
      suggestion: record.suggestion,
      kind,
      muted,
      repeatOf,
      gate: record.gate,
      tone: toneOf(record),
    }))
  }

  const historyFor = async ({ scope, session, days, limit }) => {
    const since = days > 0 ? Date.now() - days * 86_400_000 : 0
    const all = await readLedger()
    const decisionList = await readDecisions()
    const decisions = new Map()
    for (const item of decisionList) {
      if (item === null || typeof item !== 'object') continue
      decisions.set(`${item.session}#${item.turn}`, item)
    }
    const sessionDecisions = decisionList.filter(item => (
      scope === 'all' || String(item?.session ?? '') === String(session ?? '')
    ))
    const picked = all.filter((record) => {
      const at = Date.parse(record?.at)
      if (since > 0 && (!Number.isFinite(at) || at < since)) return false
      if (scope === 'session' && String(record?.session ?? '') !== String(session ?? '')) return false
      return true
    })
    const sum = key => picked.reduce((total, record) => total + (Number(record?.[key]) || 0), 0)
    const seen = new Map()
    const turns = picked.map(record => ({ record, ...adviceState(record, sessionDecisions.filter(item => String(item?.session ?? '') === String(record?.session ?? '')), seen) }))
      .slice(-limit)
      .reverse()
      .map(({ record, kind, muted, repeatOf }) => {
        const key = `${record.session}#${record.turn}`
        const decision = decisions.get(key)
        return {
          key,
          session: String(record.session ?? '').replace(/^session-/, '').slice(0, 8),
          sessionId: String(record.session ?? ''),
          turn: record.turn,
          at: record.at,
          totalMs: record.totalMs,
          modelMs: record.modelMs,
          toolMs: record.toolMs,
          modelCalls: record.modelCalls,
          toolCalls: record.toolCalls,
          retries: record.retries,
          errors: record.errors,
          blocked: record.blocked,
          slowest: record.slowest,
          suggestion: record.suggestion,
          kind,
          muted,
          repeatOf,
          gate: record.gate,
          tone: toneOf(record),
          decision: decision?.decision ?? '',
          note: decision?.note ?? '',
        }
      })
    const current = config()
    return {
      gate: Math.min(gateState.gate, policyCap('gate') ?? gateState.gate),
      policy: Object.entries(activePolicy()).map(([kind, entry]) => ({ kind, ...entry })),
      totals: {
        turns: picked.length,
        totalMs: sum('totalMs'),
        modelMs: sum('modelMs'),
        toolMs: sum('toolMs'),
        blocked: sum('blocked'),
        retries: sum('retries'),
        errors: sum('errors'),
      },
      config: { stepGate: current.stepGate, retryGate: current.retryGate, slowBlockMs: current.slowBlockMs },
      turns,
    }
  }

  ctx.effect(() => {
    const server = ctx.get('webServer')
    if (server === undefined || server === null) return () => {}
    const dispose = server.register({
      kind: 'prefix',
      path: '/turnkeeper',
      resource: async (request) => {
        const url = new URL(request.url)
        if (url.pathname === '/turnkeeper/summary') {
          const session = url.searchParams.get('session') ?? ''
          return jsonResponse({ gate: Math.min(gateState.gate, policyCap('gate') ?? gateState.gate), turns: await summaryFor(session) })
        }
        if (url.pathname === '/turnkeeper/history') {
          const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'session'
          const days = Number(url.searchParams.get('days') ?? '0') || 0
          const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? '120') || 120))
          return jsonResponse(await historyFor({
            scope,
            session: url.searchParams.get('session') ?? '',
            days,
            limit,
          }))
        }
        return jsonResponse({ error: 'not found' }, 404)
      },
    })
    /**
     * Resource routes answer GET/HEAD only, so decisions need a real HTTP
     * handler: an exact route beats the `/turnkeeper` prefix above.
     */
    const writeDecision = async (body) => {
      const session = String(body?.session ?? '')
      const turn = Number(body?.turn) || 0
      let kind = typeof body?.kind === 'string' ? body.kind : ''
      if (kind === '') {
        const hit = (await readLedger()).find(item => String(item?.session ?? '') === session && Number(item?.turn) === turn)
        kind = hit === undefined ? '' : kindOf(hit)
      }
      const record = {
        at: new Date().toISOString(),
        session,
        turn,
        kind,
        decision: body?.decision === 'reject' ? 'reject' : 'accept',
        note: typeof body?.note === 'string' ? body.note.slice(0, 2000) : '',
      }
      await mkdir(ledgerDir, { recursive: true })
      await appendFile(decisionsPath, `${JSON.stringify(record)}\n`, 'utf8')
      await adoptPolicy(record.kind, record.decision)
      return record
    }

    const disposeDecisions = server.register({
      kind: 'exact',
      path: '/turnkeeper/decisions',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        let body = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          body = {}
        }
        try {
          const record = await writeDecision(body)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, decision: record.decision, kind: record.kind }))
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String(error) }))
        }
      },
    })

    return () => {
      dispose()
      disposeDecisions()
    }
  }, 'turnkeeper: summary route')

  const resolveSession = () => {
    try {
      const initiator = ctx.get('agents')?.currentInitiator?.()
      if (initiator !== undefined) return initiator.id
    } catch {
      // fall through
    }
    return lastActive
  }

  ctx.effect(() => {
    const offPreStep = ctx.on('agent/pre-step', (payload, next) => {
      lastActive = payload.agent.id
      lastTurn = payload.turn
      bucketFor(store, payload.agent.id, payload.turn)
      guardFor(store, payload.agent.id, payload.turn)
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message?.role !== 'assistant') continue
        if (reportsProgress(message)) releaseGate(store, payload.agent.id, payload.turn)
        break
      }
      return next()
    })

    const offSessionEvent = ctx.on('session/event', (session, event) => {
      const type = event?.type ?? event?.kind
      if (type !== 'assistant/message') return
      const message = event?.message ?? event?.data?.message
      const sessionId = session?.id ?? event?.sessionId
      const turn = event?.turn ?? event?.data?.turn ?? lastTurn
      if (sessionId === undefined || !reportsProgress(message)) return
      releaseGate(store, sessionId, turn)
    })

    const offStream = ctx.on('llm/stream', (options, next) => {
      const startedAt = clock()
      const sessionId = resolveSession()
      const finish = (retried) => {
        if (sessionId === undefined) return
        const bucket = bucketFor(store, sessionId, lastTurn)
        bucket.modelMs += clock() - startedAt
        bucket.modelCalls += 1
        if (retried) bucket.retries += 1
      }
      const iterate = async function* () {
        let settled = false
        try {
          const stream = await next()
          for await (const chunk of stream) yield chunk
          settled = true
        } finally {
          finish(!settled)
        }
      }
      return iterate()
    })

    const offPreExecute = ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.parent !== undefined) return next()
      const cfg = config()
      if (!cfg.enabled || cfg.exempt.has(exec.name)) return next()
      const sessionId = exec.agent?.id ?? resolveSession()
      if (sessionId === undefined) return next()
      const turn = lastTurn
      const guard = guardFor(store, sessionId, turn)
      const deny = (reason, code, stat) => {
        guard.blocked += 1
        guard[stat] += 1
        guard.lastDeny = reason
        return { kind: 'deny', reason, info: { name: 'turn_cost', code } }
      }

      const effectiveGate = Math.min(gateState.gate, policyCap('gate') ?? gateState.gate)
      if (guard.gated || guard.calls >= effectiveGate) {
        guard.gated = true
        const adopted = policyCap('gate') === undefined
          ? ''
          : `（你采纳过收紧建议，闸门临时收到 ${effectiveGate} 次）`
        return deny(
          `步数闸门：本轮已连续 ${guard.calls} 次工具调用未汇报（${gateBasis()}）${adopted}。现在停手，先用一段文字汇报进度（做了什么/发现什么/下一步），再继续调用工具；后台任务用 job_output 收，别重复发起。`,
          'STEP_GATE',
          'byStep',
        )
      }

      const retryLimit = Math.min(cfg.retryGate, policyCap('retryGate') ?? cfg.retryGate)
      const failures = guard.failures.get(exec.name) ?? 0
      if (failures >= retryLimit) {
        return deny(
          `重试熔断：${exec.name} 本轮已失败 ${failures} 次，不要再原样重试。换一条路（改参数/换工具）或直接汇报失败原因。`,
          'RETRY_GATE',
          'byRetry',
        )
      }

      if (SHELL_TOOLS.test(exec.name)) {
        const command = commandOf(exec.arguments)
        const known = command === '' ? undefined : stateFor(store, sessionId).slow.get(prefixOf(command))
        const slowLimit = Math.min(cfg.slowBlockMs, policyCap('slowBlockMs') ?? cfg.slowBlockMs)
        if (known !== undefined && known >= slowLimit && !isBackgrounded(exec.arguments, command)) {
          return deny(
            `慢命令拦截：这条命令上次前台执行用了 ${seconds(known)}，会卡住整轮。改成 run_in_background 后台跑，或拆成短命令。`,
            'SLOW_COMMAND',
            'bySlow',
          )
        }
      }

      guard.calls += 1
      return next()
    })

    const offTool = ctx.on('tools/execute', async (exec, next) => {
      if (exec.parent !== undefined) return next()
      const startedAt = clock()
      const sessionId = exec.agent?.id ?? lastActive
      let failure
      let result
      try {
        result = await next()
      } catch (error) {
        failure = error
        throw error
      } finally {
        const ms = clock() - startedAt
        if (sessionId !== undefined) {
          const bucket = bucketFor(store, sessionId, lastTurn)
          bucket.toolMs += ms
          bucket.toolCalls += 1
          bucket.tools.push({ name: exec.name, ms, ok: failure === undefined })
          if (failure !== undefined) bucket.errors += 1
          const guard = guardFor(store, sessionId, lastTurn)
          if (failure !== undefined) guard.failures.set(exec.name, (guard.failures.get(exec.name) ?? 0) + 1)
          if (SHELL_TOOLS.test(exec.name) && ms >= config().slowLearnMs) {
            const command = commandOf(exec.arguments)
            if (command !== '') {
              const key = prefixOf(command)
              const entry = stateFor(store, sessionId)
              entry.slow.set(key, Math.max(entry.slow.get(key) ?? 0, ms))
            }
          }
        }
      }
      if (result?.isError === true && sessionId !== undefined) {
        const guard = guardFor(store, sessionId, lastTurn)
        guard.failures.set(exec.name, (guard.failures.get(exec.name) ?? 0) + 1)
      }
      return result
    })

    const offError = ctx.on('agent/request-error', (payload, next) => {
      bucketFor(store, payload.agent.id, payload.turn).errors += 1
      guardFor(store, payload.agent.id, payload.turn).failures.set('model', (guardFor(store, payload.agent.id, payload.turn).failures.get('model') ?? 0) + 1)
      return next()
    })

    const offTurnStop = ctx.on('agent/turn-stopping', (payload) => {
      const entries = store.get(payload.agent.id)
      if (entries === undefined) return
      const bucket = entries.turns.get(payload.turn)
      if (bucket === undefined) return
      const guard = entries.guards.get(payload.turn)
      const summary = summarize(bucket, clock())
      const advice = advise(summary)
      void appendLedger({
        at: new Date().toISOString(),
        session: payload.agent.id,
        turn: payload.turn,
        totalMs: summary.totalMs,
        modelMs: summary.modelMs,
        toolMs: summary.toolMs,
        otherMs: summary.otherMs,
        modelCalls: summary.modelCalls,
        toolCalls: summary.toolCalls,
        retries: summary.retries,
        errors: summary.errors,
        slowest: summary.slowest,
        blocked: guard?.blocked ?? 0,
        byStep: guard?.byStep ?? 0,
        byRetry: guard?.byRetry ?? 0,
        bySlow: guard?.bySlow ?? 0,
        suggestion: advice.text,
        adviceKind: advice.kind,
        gate: gateState.gate,
        gateSource: gateState.source,
        gateSamples: gateState.samples,
        gateP80: gateState.p80,
      })
      entries.turns.delete(payload.turn)
      entries.guards.delete(payload.turn)
      void refreshGate()
    })

    return () => {
      offPreStep()
      offSessionEvent()
      offStream()
      offPreExecute()
      offTool()
      offError()
      offTurnStop()
    }
  }, 'turnkeeper: meter + guardrails')

  ctx.effect(() => ctx.tools.register({
    name: 'turn_cost',
    description: 'Report real wall-clock cost of recent turns (model generation / tool execution / idle), the slowest calls, how many calls the guardrails denied, and one concrete next-turn lever. Call it before delivering a turn summary, then write exactly one self-assessment line from its numbers. Guardrails run by themselves via tools/pre-execute: they deny the 9th unanswered call in a turn, the third attempt at a failing tool, and re-running a known multi-minute foreground command.',
    parameters: {
      type: 'object',
      properties: {
        turns: { type: 'integer', minimum: 1, maximum: 10, description: 'How many recent turns to report (default 1). Ignored when days > 0.' },
        days: { type: 'integer', minimum: 0, maximum: 365, description: 'Aggregate the on-disk ledger over the last N days instead of reading live turns. Use 7 for a weekly view, 30 for monthly.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          line: { type: 'string' },
          detail: { type: 'string' },
          guard: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['line', 'detail', 'guard', 'suggestion'],
        additionalProperties: false,
      },
      render(_args, value) {
        const text = [value.line, value.detail, value.guard, `下次怎么压短：${value.suggestion}`].filter(Boolean).join('\n')
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const days = Math.min(Math.max(Number(args?.days ?? 0) || 0, 0), 365)
      if (days > 0) {
        const aggregate = aggregateDays(await readLedger(), days)
        return aggregate ?? { line: `最近 ${days} 天账本里没有记录。`, detail: '插件每轮结束写一条记录，安装后跑几轮才有数据。', guard: '护栏期间未拦截。', suggestion: '先正常干活几轮，再回来看汇总。' }
      }
      const sessionId = exec.agent?.id ?? lastActive
      const count = Math.min(Math.max(Number(args?.turns ?? 1) || 1, 1), 10)
      const entry = sessionId === undefined ? undefined : store.get(sessionId)
      if (entry === undefined || entry.order.length === 0) {
        return { line: '暂无已完成的轮次记录。', detail: '插件从本次启动后开始计量。', guard: guardLine(entry?.guards.get(lastTurn)), suggestion: '本轮结束后再调用一次即可看到拆分。' }
      }
      const done = entry.order.map(turn => entry.turns.get(turn)).filter(bucket => bucket !== undefined)
      const picked = done.slice(-count)
      const summaries = picked.map(bucket => summarize(bucket, clock()))
      const last = summaries[summaries.length - 1]
      const line = summaries.length === 1
        ? last.line
        : summaries.map(item => `第 ${item.turn} 轮 ${seconds(item.totalMs)}（模型 ${percent(item.modelMs, item.totalMs)}% / 工具 ${percent(item.toolMs, item.totalMs)}%）`).join('；')
      const detail = summaries.length === 1
        ? last.detail
        : `最近 ${summaries.length} 轮合计 ${seconds(summaries.reduce((sum, item) => sum + item.totalMs, 0))}；最慢一轮：${summaries.slice().sort((a, b) => b.totalMs - a.totalMs)[0].detail || '无工具调用'}`
      return { line, detail, guard: guardLine(entry.guards.get(last.turn) ?? entry.guards.get(lastTurn)), suggestion: advise(last).text }
    },
  }), 'turnkeeper: turn_cost tool')
}