/**
 * dsh-turnkeeper — client half.
 *
 * Two surfaces on the theme's paper/ink tokens:
 *  1. a per-turn assessment card at each completed turn's tail;
 *  2. a "轮次" Conversation View (after 画廊 and 上下文): day-grouped ledger, each
 *     turn rendered in the same card language as the chat card.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-turnkeeper',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const FONT = '"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","PingFang SC",system-ui,sans-serif'

    const C = {
      panel: 'var(--dsw-alias-bg-layer-1)',
      sunken: 'var(--dsw-alias-bg-layer-2)',
      line1: 'var(--dsw-alias-border-l1)',
      line2: 'var(--dsw-alias-border-l2)',
      ink: 'var(--dsw-alias-label-primary)',
      ink2: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      good: 'var(--dsw-alias-state-success-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const TONE = { warn: C.warn, error: C.error, good: C.good, info: C.idle }
    const STATUS = { warn: '需留意', error: '有报错', good: '健康', info: '正常' }

    const KIND = {
      model: '上下文偏重',
      tool: '工具偏重',
      retry: '有失败',
      idle: '空转偏多',
      balanced: '节奏均衡',
      empty: '无耗时',
      other: '一般',
    }

    const LABEL = {
      model: '模型生成',
      tool: '工具执行',
      blocked: '护栏拦截',
      gate: '步数闸门',
      advice: '建议',
      accept: '采纳',
      reject: '驳回',
      note: '补充意见',
      notePlaceholder: '哪里判断错了，或者想怎么调……',
      accepted: '已采纳',
      rejected: '已驳回',
      cancel: '收起补充',
      slowest: '最慢工具',
      calls: '调用',
      retries: '重试',
      errors: '报错',
      ledger: '轮次账本',
      mine: '本会话',
      all: '全部会话',
      anytime: '全部',
      day1: '1 天',
      day7: '7 天',
      refresh: '刷新',
      turns: '轮数',
      total: '合计',
      decision: '决策',
      undecided: '未定',
      empty: '还没有记录。完成一轮对话后就会出现在这里。',
      loading: '读取账本…',
      muted: '这类建议已按你的决定静音',
      repeat: '同类建议，已折叠',
      sameAs: '同',
    }

    const NUM = { fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum"' }

    function seconds(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value <= 0) return '0.0s'
      if (value < 1000) return `${Math.round(value)}ms`
      if (value < 60_000) return `${(value / 1000).toFixed(1)}s`
      return `${Math.floor(value / 60_000)}m${String(Math.round((value % 60_000) / 1000)).padStart(2, '0')}s`
    }

    function percent(part, total) {
      return total > 0 ? Math.max(0, Math.min(100, Math.round((Number(part) / total) * 100))) : 0
    }

    function slowestText(value) {
      if (Array.isArray(value)) return value.filter(Boolean).map(String).join(' · ')
      if (typeof value === 'string') return value
      return ''
    }

    function clock(iso) {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = value => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function dayKey(iso) {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = value => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    function dayLabel(key) {
      const today = dayKey(new Date().toISOString())
      const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString())
      if (key === today) return '今天'
      if (key === yesterday) return '昨天'
      return key.slice(5)
    }

    function chip(text, color) {
      return h('span', {
        key: text,
        style: {
          fontSize: 10.5, lineHeight: '17px', padding: '0 6px', borderRadius: 999,
          letterSpacing: '0.04em', color, border: `1px solid ${color}`, whiteSpace: 'nowrap',
        },
      }, text)
    }

    function stat(label, value) {
      return h('div', {
        key: label,
        style: { display: 'flex', alignItems: 'baseline', gap: 6, whiteSpace: 'nowrap' },
      }, [
        h('span', { key: 'k', style: { fontSize: 11, color: C.ink2, letterSpacing: '0.04em' } }, label),
        h('span', { key: 'v', style: { ...NUM, fontSize: 13, fontWeight: 600, color: C.ink, letterSpacing: '0.02em' } }, value),
      ])
    }

    function divider() {
      return h('span', { key: `d${Math.random()}`, style: { width: 1, height: 11, background: C.line2, display: 'inline-block' } })
    }

    function tile(label, value, note) {
      return h('div', {
        key: label,
        style: { flex: '1 1 0', minWidth: 92, padding: '6px 9px', borderRadius: 9, background: C.sunken },
      }, [
        h('div', { key: 'k', style: { fontSize: 11, color: C.ink2, lineHeight: '16px', letterSpacing: '0.04em', whiteSpace: 'nowrap' } }, label),
        h('div', {
          key: 'v',
          style: { ...NUM, fontSize: 15, fontWeight: 600, color: C.ink, lineHeight: '20px', letterSpacing: '0.02em', whiteSpace: 'nowrap' },
        }, value),
        note === undefined || note === ''
          ? null
          : h('div', { key: 'n', style: { ...NUM, fontSize: 11, color: C.ink2, lineHeight: '16px', letterSpacing: '0.04em', whiteSpace: 'nowrap' } }, note),
      ])
    }

    function ghostButton(text, onClick, active) {
      return h('button', {
        key: text,
        type: 'button',
        onClick,
        style: {
          fontFamily: FONT, fontSize: 11.5, letterSpacing: '0.04em', lineHeight: '24px',
          padding: '0 9px', cursor: 'pointer', borderRadius: 7,
          color: active ? C.ink : C.ink2,
          background: active ? C.sunken : 'transparent',
          border: `1px solid ${active ? C.line2 : 'transparent'}`,
        },
      }, text)
    }

    function solidButton(text, onClick) {
      return h('button', {
        key: text,
        type: 'button',
        onClick,
        style: {
          fontFamily: FONT, fontSize: 12, letterSpacing: '0.04em', lineHeight: '26px',
          padding: '0 12px', cursor: 'pointer', borderRadius: 8,
          color: C.panel, background: C.accent, border: `1px solid ${C.accent}`,
        },
      }, text)
    }

    const postDecision = (body) => fetch('/turnkeeper/decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    function useSummary(sessionId, turnNo) {
      const [state, setState] = React.useState({ entries: null, gate: 0 })
      React.useEffect(() => {
        if (sessionId === undefined || sessionId === null) return undefined
        let alive = true
        fetch(`/turnkeeper/summary?session=${encodeURIComponent(String(sessionId))}`)
          .then(response => (response.ok ? response.json() : null))
          .then((value) => {
            if (!alive || value === null) return
            setState({ entries: Array.isArray(value.turns) ? value.turns : [], gate: Number(value.gate) || 0 })
          })
          .catch(() => {})
        return () => { alive = false }
      }, [sessionId, turnNo])
      return state
    }

    /* ---------------------------------------------------------------- card */

    function Card(props) {
      const sessionId = props.sessionId
      const turnNo = Number(props.turn?.turn ?? props.turn?.number ?? props.seq ?? 0)
      const { entries, gate } = useSummary(sessionId, turnNo)
      const [note, setNote] = React.useState('')
      const [open, setOpen] = React.useState(false)
      const [sent, setSent] = React.useState('')

      const entry = React.useMemo(() => {
        if (!Array.isArray(entries) || entries.length === 0) return undefined
        const exact = entries.find(item => Number(item?.turn) === turnNo)
        return exact ?? (turnNo === 0 ? entries[entries.length - 1] : undefined)
      }, [entries, turnNo])

      if (entry === undefined || entry === null) return null

      const total = Number(entry.totalMs) || 0
      const modelMs = Number(entry.modelMs) || 0
      const toolMs = Number(entry.toolMs) || 0
      const retries = Number(entry.retries) || 0
      const errors = Number(entry.errors) || 0
      const blocked = Number(entry.blocked) || 0
      const accent = TONE[entry.tone] ?? C.idle
      const slowest = slowestText(entry.slowest)

      const decide = (decision) => {
        postDecision({ session: String(sessionId ?? ''), turn: Number(entry.turn) || 0, kind: entry.kind ?? '', decision, note })
          .then(response => (response.ok ? response.json() : null))
          .then(() => { setSent(decision); setOpen(false) })
          .catch(() => {})
      }

      const action = (text, onClick, primary) => h('button', {
        key: text,
        type: 'button',
        onClick,
        style: {
          flex: '1 1 0', minWidth: 84, fontFamily: FONT, fontSize: 12.5, letterSpacing: '0.04em',
          lineHeight: '26px', padding: '0 10px', cursor: 'pointer', borderRadius: 9,
          color: primary ? C.panel : C.ink,
          background: primary ? C.accent : C.panel,
          border: `1px solid ${primary ? C.accent : C.line2}`,
        },
      }, text)

      const advice = (() => {
        if (entry.muted) {
          return h('div', {
            key: 'advice',
            style: { marginTop: 8, fontSize: 11.5, color: C.ink2, letterSpacing: '0.04em' },
          }, `${LABEL.muted}（${KIND[entry.kind] ?? ''}）`)
        }
        if (!entry.suggestion) return null
        if (Number(entry.repeatOf) > 0) {
          return h('div', {
            key: 'advice',
            style: { marginTop: 8, fontSize: 11.5, color: C.ink2, letterSpacing: '0.04em' },
          }, `${LABEL.repeat}：与第 ${entry.repeatOf} 轮同类（${KIND[entry.kind] ?? ''}）`)
        }
        return h('div', {
          key: 'advice',
          style: {
            marginTop: 8, padding: '7px 10px', borderRadius: 9, background: C.sunken,
            fontSize: 12.5, lineHeight: 1.7, letterSpacing: '0.04em', color: C.ink,
          },
        }, [
          h('span', { key: 'k', style: { fontSize: 11, color: C.ink2, marginRight: 6, letterSpacing: '0.06em' } }, `${LABEL.advice} ·`),
          h('span', { key: 'v' }, entry.suggestion),
        ])
      })()

      const children = [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
          h('span', { key: 'tag', style: { fontSize: 11.5, color: C.ink2, letterSpacing: '0.06em' } }, '本轮'),
          h('span', {
            key: 'no',
            style: { ...NUM, fontSize: 16, fontWeight: 700, color: C.ink, lineHeight: '22px', letterSpacing: '0.04em' },
          }, String(entry.turn ?? '—')),
          h('span', {
            key: 'status',
            style: {
              fontSize: 11, lineHeight: '18px', padding: '0 8px', borderRadius: 999, letterSpacing: '0.06em',
              color: accent, background: C.sunken, border: `1px solid ${accent}`, whiteSpace: 'nowrap',
            },
          }, STATUS[entry.tone] ?? STATUS.info),
          h('span', { key: 'spacer', style: { flex: 1 } }),
          h('span', {
            key: 'total',
            style: { ...NUM, fontSize: 17, fontWeight: 600, color: C.ink, lineHeight: '22px', letterSpacing: '0.04em' },
          }, seconds(total)),
        ]),

        h('div', { key: 'tiles', style: { display: 'flex', gap: 7, marginTop: 8, flexWrap: 'wrap' } }, [
          tile(LABEL.model, seconds(modelMs), `${percent(modelMs, total)}% · ${entry.modelCalls ?? 0} 次`),
          tile(LABEL.tool, seconds(toolMs), `${percent(toolMs, total)}% · ${entry.toolCalls ?? 0} 次`),
          tile(LABEL.blocked, String(blocked), retries > 0 ? `${LABEL.retries} ${retries} 次` : '本轮无重试'),
          tile(LABEL.gate, gate > 0 ? String(gate) : '—', '当前上限'),
        ]),

        h('div', {
          key: 'detail',
          style: {
            marginTop: 8, paddingTop: 7, borderTop: `1px solid ${C.line1}`,
            display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11.5, letterSpacing: '0.04em', color: C.ink2,
          },
        }, [
          h('span', { key: 'calls' }, `${LABEL.calls} ${entry.modelCalls ?? 0} / ${entry.toolCalls ?? 0}`),
          h('span', { key: 'retry' }, `${LABEL.retries} ${retries}`),
          h('span', { key: 'err' }, `${LABEL.errors} ${errors}`),
          slowest === ''
            ? null
            : h('span', { key: 'slow', style: { flex: '1 1 100%', color: C.ink, overflowWrap: 'anywhere' } }, `${LABEL.slowest}：${slowest}`),
        ]),

        advice,

        h('div', { key: 'actions', style: { marginTop: 9, display: 'flex', gap: 8 } },
          sent !== ''
            ? [h('span', {
              key: 'ok',
              style: { fontSize: 12.5, color: sent === 'accept' ? C.good : C.ink2, letterSpacing: '0.04em' },
            }, sent === 'accept' ? `${LABEL.accepted}，同类建议静音 7 天` : `${LABEL.rejected}，同类建议静音 7 天`)]
            : [
              action(open ? LABEL.cancel : LABEL.note, () => setOpen(!open), false),
              action(LABEL.reject, () => decide('reject'), false),
              action(LABEL.accept, () => decide('accept'), true),
            ]),
      ]

      if (open && sent === '') {
        children.push(h('div', { key: 'note', style: { marginTop: 9 } }, [
          h('textarea', {
            key: 'input',
            value: note,
            onChange: event => setNote(event.target.value),
            placeholder: LABEL.notePlaceholder,
            rows: 2,
            style: {
              width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: FONT,
              fontSize: 12.5, letterSpacing: '0.04em', lineHeight: 1.65, padding: '8px 10px',
              color: C.ink, background: C.sunken, border: `1px solid ${C.line2}`, borderRadius: 9, outline: 'none',
            },
          }),
        ]))
      }

      return h('div', {
        style: {
          margin: '8px 0',
          padding: '10px 14px 11px',
          background: C.panel,
          border: `1px solid ${C.line1}`,
          borderRadius: 14,
          color: C.ink,
          fontFamily: FONT,
          letterSpacing: '0.01em',
        },
      }, children)
    }

    /* -------------------------------------------------------------- ledger */

    function adviceLine(item) {
      if (item.muted) {
        return h('div', {
          key: 'advice',
          style: { marginTop: 7, fontSize: 11.5, color: C.ink2, letterSpacing: '0.04em', opacity: 0.75 },
        }, `${LABEL.muted}（${KIND[item.kind] ?? ''}）`)
      }
      if (!item.suggestion) return null
      if (Number(item.repeatOf) > 0) {
        return h('div', {
          key: 'advice',
          style: { marginTop: 7, fontSize: 11.5, color: C.ink2, letterSpacing: '0.04em', opacity: 0.8 },
        }, `${LABEL.repeat}：与第 ${item.repeatOf} 轮同类（${KIND[item.kind] ?? ''}）`)
      }
      return h('div', {
        key: 'advice',
        style: {
          marginTop: 7, padding: '6px 10px', borderRadius: 8, background: C.sunken,
          fontSize: 12, lineHeight: 1.7, letterSpacing: '0.04em', color: C.ink,
        },
      }, [
        h('span', { key: 'k', style: { fontSize: 10.5, color: C.ink2, marginRight: 6, letterSpacing: '0.06em' } }, `${LABEL.advice} ·`),
        h('span', { key: 'v' }, item.suggestion),
      ])
    }

    function HistoryView(props) {
      const sessionId = String(props.sessionId ?? '')
      const [scope, setScope] = React.useState('session')
      const [days, setDays] = React.useState(0)
      const [data, setData] = React.useState(null)
      const [expanded, setExpanded] = React.useState('')
      const [hover, setHover] = React.useState('')
      const [note, setNote] = React.useState('')
      const [tick, setTick] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        setData(null)
        fetch(`/turnkeeper/history?scope=${scope}&days=${days}&limit=300&session=${encodeURIComponent(sessionId)}`)
          .then(response => (response.ok ? response.json() : null))
          .then((value) => { if (alive) setData(value) })
          .catch(() => { if (alive) setData({ turns: [], totals: {}, gate: 0 }) })
        return () => { alive = false }
      }, [scope, days, sessionId, tick])

      const decide = (item, decision) => {
        postDecision({ session: item.sessionId, turn: item.turn, kind: item.kind ?? '', decision, note })
          .then(response => (response.ok ? response.json() : null))
          .then(() => { setNote(''); setExpanded(''); setTick(value => value + 1) })
          .catch(() => {})
      }

      const totals = data?.totals ?? {}
      const turns = Array.isArray(data?.turns) ? data.turns : []
      const grand = Number(totals.totalMs) || 0

      const header = h('div', {
        key: 'header',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          paddingBottom: 9, borderBottom: `1px solid ${C.line1}`,
        },
      }, [
        h('span', { key: 'title', style: { fontSize: 13.5, fontWeight: 600, color: C.ink, letterSpacing: '0.06em' } }, LABEL.ledger),
        h('span', { key: 'spacer', style: { flex: 1 } }),
        ghostButton(LABEL.mine, () => setScope('session'), scope === 'session'),
        ghostButton(LABEL.all, () => setScope('all'), scope === 'all'),
        h('span', { key: 'gap1', style: { width: 5 } }),
        ghostButton(LABEL.anytime, () => setDays(0), days === 0),
        ghostButton(LABEL.day1, () => setDays(1), days === 1),
        ghostButton(LABEL.day7, () => setDays(7), days === 7),
        h('span', { key: 'gap2', style: { width: 5 } }),
        ghostButton(LABEL.refresh, () => setTick(value => value + 1), false),
      ])

      const strip = h('div', {
        key: 'strip',
        style: {
          display: 'flex', alignItems: 'center', gap: 13, flexWrap: 'wrap',
          marginTop: 9, fontSize: 11.5, color: C.ink2,
        },
      }, [
        stat(LABEL.turns, String(totals.turns ?? 0)),
        divider(),
        stat(LABEL.total, seconds(grand)),
        divider(),
        stat(LABEL.model, `${seconds(totals.modelMs)} · ${percent(totals.modelMs, grand)}%`),
        divider(),
        stat(LABEL.tool, `${seconds(totals.toolMs)} · ${percent(totals.toolMs, grand)}%`),
        divider(),
        stat(LABEL.blocked, String(totals.blocked ?? 0)),
        divider(),
        stat('阀门', data?.gate > 0 ? String(data.gate) : '—'),
      ])

      const groups = []
      const seenDay = new Map()
      for (const item of turns) {
        const key = dayKey(item.at)
        if (!seenDay.has(key)) {
          const entry = { key, items: [], ms: 0 }
          seenDay.set(key, entry)
          groups.push(entry)
        }
        const target = seenDay.get(key)
        target.items.push(item)
        target.ms += Number(item.totalMs) || 0
      }

      const rows = []
      for (const group of groups) {
        rows.push(h('div', {
          key: `day-${group.key}`,
          style: {
            display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 14, marginBottom: 6,
            fontSize: 11, color: C.ink2, letterSpacing: '0.08em',
          },
        }, [
          h('span', { key: 'd', style: { fontWeight: 600, color: C.ink } }, dayLabel(group.key)),
          h('span', { key: 'c' }, `${group.items.length} 轮`),
          h('span', { key: 'ms', style: NUM }, seconds(group.ms)),
        ]))

        for (const item of group.items) {
          const total = Number(item.totalMs) || 0
          const isOpen = expanded === item.key
          const isHover = hover === item.key
          const tone = TONE[item.tone] ?? C.idle

          const card = [
            h('div', { key: 'l1', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
              h('span', { key: 'dot', style: { width: 6, height: 6, borderRadius: 999, flex: '0 0 auto', background: tone } }),
              h('span', { key: 'no', style: { ...NUM, fontSize: 14, fontWeight: 700, letterSpacing: '0.03em', color: C.ink } }, `#${item.turn}`),
              h('span', { key: 'at', style: { ...NUM, fontSize: 11, color: C.ink2, letterSpacing: '0.04em' } }, clock(item.at)),
              scope === 'all'
                ? h('span', { key: 'src', style: { ...NUM, fontSize: 10, color: C.ink2, opacity: 0.6 } }, item.session)
                : null,
              item.decision === 'accept' || item.decision === 'reject'
                ? chip(item.decision === 'accept' ? LABEL.accepted : LABEL.rejected, item.decision === 'accept' ? C.good : C.ink2)
                : null,
              h('span', { key: 'sp', style: { flex: 1 } }),
              h('span', { key: 'total', style: { ...NUM, fontSize: 14, fontWeight: 600, letterSpacing: '0.03em', color: C.ink } }, seconds(total)),
            ]),

            h('div', {
              key: 'l2',
              style: { display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 5, fontSize: 11.5, color: C.ink2, letterSpacing: '0.04em' },
            }, [
              h('span', { key: 'm', style: NUM }, `${LABEL.model} ${seconds(item.modelMs)} · ${percent(item.modelMs, total)}%`),
              h('span', { key: 't', style: NUM }, `${LABEL.tool} ${seconds(item.toolMs)} · ${percent(item.toolMs, total)}%`),
              h('span', { key: 'c', style: NUM }, `${LABEL.calls} ${item.modelCalls ?? 0}/${item.toolCalls ?? 0}`),
              Number(item.blocked) > 0
                ? h('span', { key: 'b', style: { ...NUM, color: C.warn } }, `${LABEL.blocked} ${item.blocked}`)
                : null,
              Number(item.retries) > 0
                ? h('span', { key: 'r', style: { ...NUM, color: C.warn } }, `${LABEL.retries} ${item.retries}`)
                : null,
              Number(item.errors) > 0
                ? h('span', { key: 'e', style: { ...NUM, color: C.error } }, `${LABEL.errors} ${item.errors}`)
                : null,
            ]),

            adviceLine(item),
          ]

          if (isOpen) {
            card.push(h('div', {
              key: 'body',
              style: {
                marginTop: 9, paddingTop: 8, borderTop: `1px solid ${C.line1}`,
                fontSize: 12, lineHeight: 1.75, letterSpacing: '0.04em',
              },
            }, [
              h('div', {
                key: 'meta',
                style: { ...NUM, fontSize: 10.5, color: C.ink2, marginBottom: 7, display: 'flex', gap: 12, flexWrap: 'wrap' },
              }, [
                h('span', { key: 'kind' }, KIND[item.kind] ?? '一般'),
                h('span', { key: 'gate' }, `${LABEL.gate} ${item.gate > 0 ? item.gate : '—'}`),
                item.slowest ? h('span', { key: 'slow' }, `${LABEL.slowest} ${slowestText(item.slowest)}`) : null,
              ]),
              item.note
                ? h('div', { key: 'note', style: { marginBottom: 6, color: C.ink2 } }, `${LABEL.note}：${item.note}`)
                : null,
              h('div', { key: 'row', style: { display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' } }, [
                h('textarea', {
                  key: 'input',
                  value: note,
                  onChange: event => setNote(event.target.value),
                  placeholder: LABEL.notePlaceholder,
                  rows: 1,
                  style: {
                    flex: '1 1 240px', boxSizing: 'border-box', resize: 'vertical', fontFamily: FONT,
                    fontSize: 12, letterSpacing: '0.04em', lineHeight: 1.6, padding: '6px 9px',
                    color: C.ink, background: C.panel, border: `1px solid ${C.line2}`, borderRadius: 8, outline: 'none',
                  },
                }),
                ghostButton(LABEL.reject, () => decide(item, 'reject'), false),
                solidButton(LABEL.accept, () => decide(item, 'accept')),
              ]),
            ]))
          }

          rows.push(h('div', {
            key: `${item.key}-card`,
            onClick: () => { setExpanded(isOpen ? '' : item.key); setNote('') },
            onMouseEnter: () => setHover(item.key),
            onMouseLeave: () => setHover(''),
            style: {
              marginBottom: 7, padding: '9px 12px 10px', borderRadius: 12,
              background: isHover || isOpen ? C.sunken : C.panel,
              border: `1px solid ${isHover || isOpen ? C.line2 : C.line1}`,
              color: C.ink, cursor: 'pointer',
            },
          }, card))
        }
      }

      const empty = turns.length === 0
        ? h('div', {
          key: 'empty',
          style: { marginTop: 18, fontSize: 12.5, color: C.ink2, letterSpacing: '0.04em' },
        }, data === null ? LABEL.loading : LABEL.empty)
        : null

      return h('div', {
        style: {
          height: '100%', boxSizing: 'border-box', overflowY: 'auto',
          padding: '14px 18px 24px', color: C.ink, fontFamily: FONT, letterSpacing: '0.01em',
        },
      }, [header, strip, ...rows, empty])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'turnkeeper-card',
          order: 30,
          label: 'Turn cost',
        }, Card))

        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'turnkeeper-ledger',
          order: 40,
          label: '轮次',
        }, HistoryView))
      },
    }
  },
})