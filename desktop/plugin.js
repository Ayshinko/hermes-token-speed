// Hermes desktop plugin: hermes-token-speed  v1.2.0
// Live decode tokens/sec for the Hermes desktop status bar:
// 1-second sliding window, tool-time excluded, calibrated against
// authoritative usage at turn end. Ported from Ayshinko/pi-token-speed
// (SlidingWindow + TokenSpeedEngine) and pi-dsh-tps (task-level decode
// TPS excluding tool wall time). MIT licensed.
import { host, atom, useValue, PALETTE_AREA } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'

const WINDOW_MS = 1000        // pi-token-speed SLIDING_WINDOW_DEFAULT
const MIN_SPAN = 100          // MIN_SLIDING_WINDOW
const COMPACTION = 5000       // COMPACTION_THRESHOLD
const TOKEN_RE = /\w+|[^\s\w]/g
const THROTTLE_MS = 250

/* ---- SlidingWindow (ported 1:1) ---- */
class SlidingWindow {
  constructor(windowMs) {
    this.events = []
    this.startIdx = 0
    this.windowMs = windowMs
  }
  record(tokens) {
    this.events.push({ time: Date.now(), tokens })
    if (this.startIdx >= COMPACTION) {
      this.events.splice(0, this.startIdx)
      this.startIdx = 0
    }
  }
  getTps(now) {
    if (this.events.length === 0) return 0
    const windowStart = now - this.windowMs
    while (this.startIdx < this.events.length && this.events[this.startIdx].time < windowStart) this.startIdx++
    if (this.startIdx >= this.events.length) return 0
    let sum = 0
    for (let i = this.startIdx; i < this.events.length; i++) sum += this.events[i].tokens
    if (sum === 0) return 0
    let spanStart = this.events[this.startIdx].time
    const first = this.events[this.startIdx].time
    const last = this.events[this.events.length - 1].time
    // all-same-timestamp burst after a stall: extend span to previous event
    if (first === last && this.startIdx > 0) spanStart = this.events[this.startIdx - 1].time
    const span = Math.max(now - spanStart, MIN_SPAN)
    return (1000 * sum) / span
  }
  reset() { this.events.length = 0; this.startIdx = 0 }
}

/* ---- Engine (ported: TTFT, pause/resume, reconcile) ---- */
class Engine {
  constructor() { this.win = new SlidingWindow(WINDOW_MS); this.resetAll() }
  resetAll() {
    this.streaming = false; this.paused = false
    this.tokens = 0; this.tps = 0
    this.t0 = 0; this.t1 = 0; this.pauseT0 = 0; this.pausedMs = 0
    this.ttft0 = 0; this.ttft1 = 0
    this.win.reset()
  }
  start() { if (this.streaming) return; this.resetAll(); this.streaming = true; this.t0 = Date.now(); this.ttft0 = this.t0 }
  firstDelta() { if (this.ttft1 === 0) this.ttft1 = Date.now() }
  pause() { if (!this.paused) { this.paused = true; this.pauseT0 = Date.now() } }
  resume() { if (this.paused) { this.paused = false; this.pausedMs += Date.now() - this.pauseT0 } }
  record(tokens) {
    if (!this.streaming || tokens <= 0) return
    if (this.paused) this.resume()
    this.firstDelta()
    this.tokens += tokens
    this.win.record(tokens)
    this.tps = this.win.getTps(Date.now())
  }
  reconcile(n) { if (n > 0) this.tokens = n }   // authoritative provider usage
  stop() {
    if (!this.streaming) return
    if (this.paused) this.pausedMs += Date.now() - this.pauseT0
    this.paused = false
    this.streaming = false; this.t1 = Date.now()
  }
  decodeSec() { const end = this.streaming ? Date.now() : this.t1; const paused = this.pausedMs + (this.streaming && this.paused ? end - this.pauseT0 : 0); return Math.max((end - this.t0 - paused) / 1000, 0.001) }
  tpsAvg() { return this.tokens / this.decodeSec() }
  ttftMs() { return this.ttft1 > 0 ? this.ttft1 - this.ttft0 : 0 }
}

/* ---- token counting: estimate strategy (chunk-size independent) ---- */
function countTokens(text) {
  if (!text) return 0
  const m = text.match(TOKEN_RE)
  return m ? m.length : 0
}

/* ---- shared state for this plugin ---- */
const engine = new Engine()
const $chip = atom('\u26A1 t/s')       // status-bar label (idle default = visible)
const sessionTotals = { tokens: 0, decodeSec: 0, responses: 0, turns: 0 }
let usageAtTurnStart = 0
let lastLabelPush = 0
let watchBuf = null
let codexQuota = null
let codexQuotaError = false
let pluginCtx = null
let quotaInFlight = false

function compactCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 10000) return (n / 1000).toFixed(1) + 'k'
  return String(Math.round(n))
}
function renderStatus() {
  const q = codexQuota
  const q5 = q && q.five_hour ? Math.round(q.five_hour.remaining_percent) + '% left' : (codexQuotaError ? '!' : '—')
  const qw = q && q.weekly ? Math.round(q.weekly.remaining_percent) + '% left' : (codexQuotaError ? '!' : '—')
  const active = engine.streaming && !engine.paused
  const live = active ? engine.win.getTps(Date.now()) : 0
  const tokens = sessionTotals.tokens + (engine.streaming ? engine.tokens : 0)
  const seconds = sessionTotals.decodeSec + (engine.streaming ? engine.decodeSec() : 0)
  const avg = tokens > 0 && seconds > 0 ? (tokens / seconds).toFixed(1) : '--'
  const liveText = active && live > 0 ? live.toFixed(1) : '—'
  $chip.set('Codex ' + q5 + ' · W ' + qw + ' · ⚡ Live ' + liveText + ' · Avg ' + avg + ' tok/s · ↓' + compactCount(tokens))
}
async function refreshCodexQuota() {
  if (quotaInFlight || !pluginCtx || typeof pluginCtx.rest !== 'function') return
  quotaInFlight = true
  try {
    const q = await pluginCtx.rest('/quota', { timeoutMs: 12000 })
    if (!q || (!q.five_hour && !q.weekly)) throw new Error('invalid quota result')
    codexQuota = q
    codexQuotaError = false
  } catch (_) {
    codexQuotaError = true
  } finally {
    quotaInFlight = false
    renderStatus()
  }
}
function pushLive() {
  const now = Date.now()
  if (now - lastLabelPush < THROTTLE_MS) return
  lastLabelPush = now
  renderStatus()
}
function pushEnd() {
  sessionTotals.tokens += engine.tokens
  sessionTotals.decodeSec += engine.decodeSec()
  sessionTotals.responses += 1
  renderStatus()
}
function pushIdle() { renderStatus() }

function extractDeltaText(evt) {
  const p = (evt && evt.payload) || (evt && evt.params) || evt || {}
  for (const k of ['text', 'delta', 'content', 'chunk']) {
    const v = p[k]
    if (typeof v === 'string' && v.length > 0 && v.length < 2000) return v
  }
  return null
}
const IGNORE = /session\.usage|session\.info|status\.update|notification\.|review\.|error|\.complete|\.end|history/

export default {
  id: 'token-speed',
  name: 'Token Speed + Codex Quota',
  register(ctx) {
    pluginCtx = ctx
    // Codex usage is retrieved by the signed Hermes backend adapter; never read auth files here.
    void refreshCodexQuota()
    ctx.setInterval(() => { void refreshCodexQuota() }, 5 * 60 * 1000)
    const stopQuotaRefresh = ctx.onEvent('session.usage', () => { void refreshCodexQuota() })
    ctx.onDispose(stopQuotaRefresh)
    // Keep the sliding window honest during short pauses between stream events.
    ctx.setInterval(() => { if (engine.streaming) renderStatus() }, THROTTLE_MS)

    // turn boundaries via busy atom
    host.state.busy.listen((busy) => {
      if (busy) {
        usageAtTurnStart = (host.state.focusedUsage.get() || {}).output || 0
        engine.start()
        renderStatus()
      } else {
        if (engine.streaming) {
          engine.stop()
          const u = (host.state.focusedUsage.get() || {}).output || 0
          if (u > usageAtTurnStart) engine.reconcile(u - usageAtTurnStart)
          pushEnd()
        }
      }
    })

    // raw event tap — real gateway event names confirmed from desktop source
    // (use-message-stream/gateway-event/message-stream.ts + tools.ts):
    //   message.delta / reasoning.delta / thinking.delta / tool.start / tool.generating / tool.complete
    host.onEvent('*', (evt) => {
      const type = evt && (evt.type || evt.method) || ''
      if (watchBuf) watchBuf[type] = (watchBuf[type] || 0) + 1
      if (!engine.streaming || !type) return
      if (type === 'tool.start' || type === 'tool.generating') { engine.pause(); return }   // dsh: exclude tool time
      if (type === 'thinking.delta') return   // spinner/provider-wait rewrites, NOT model tokens
      if (type === 'message.delta' || type === 'reasoning.delta' || /\.delta$/.test(type)) {
        const text = extractDeltaText(evt)
        if (text) { engine.record(countTokens(text)); pushLive() }
      }
    })

    // status bar chip
    ctx.register({
      id: 'chip', area: 'statusBar.right', order: 121,
      render: () => {
        const label = useValueLocal()
        return label ? jsx('span', { className: 'px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)', children: label }) : null
      }
    })

    // palette commands
    ctx.registerMany([
      {
        id: 'report', area: PALETTE_AREA,
        data: {
          id: 'token-speed.report', label: 'Token Speed: turn report', keywords: ['tps', 'tokens', 'speed'],
          run: () => {
            const t = sessionTotals
            host.notify({
              kind: 'info', title: 'Token Speed (session)',
              message: 'task TPS: ' + (t.tokens / Math.max(t.decodeSec, 0.001)).toFixed(2) + ' tok/s \u00B7 ' + t.tokens + ' est tok \u00B7 ' + t.decodeSec.toFixed(1) + 's decode \u00B7 ' + t.responses + ' responses',
              detail: 'last stream: ' + engine.tpsAvg().toFixed(2) + ' avg t/s \u00B7 TTFT ' + engine.ttftMs() + 'ms (pi-dsh-tps style, tool time excluded)'
            })
          }
        }
      },
      {
        id: 'watch', area: PALETTE_AREA,
        data: {
          id: 'token-speed.watch', label: 'Token Speed: watch events (5s)', keywords: ['tps', 'debug', 'events'],          run: () => {
            watchBuf = {}
            host.notify({ kind: 'info', message: 'Token Speed: watching gateway events for 5s \u2014 send a message now to observe deltas.' })
            setTimeout(() => {
              const top = Object.entries(watchBuf || {}).sort((a, b) => b[1] - a[1]).slice(0, 8)
              watchBuf = null
              host.notify({ kind: 'info', title: 'gateway events seen', message: top.map(([t, c]) => t + ' \u00D7' + c).join('\n') || 'none' })
            }, 5000)
          }
        }
      },
      {
        id: 'reset', area: PALETTE_AREA,
        data: { id: 'token-speed.reset', label: 'Token Speed: reset session totals', keywords: ['tps', 'reset'], run: () => { sessionTotals.tokens = 0; sessionTotals.decodeSec = 0; sessionTotals.responses = 0; renderStatus() } }
      }
    ])

  }
}

// tiny local hook
function useValueLocal() { return useValue($chip) }
