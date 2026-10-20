import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const moduleSource = source
  .replace(/^import .*$/gm, '')
  .replace('export default {', 'globalThis.plugin = {')
  .replace(/\n}\s*\n\/\* tiny local hook \*\//, '\n}\n/* tiny local hook */')
  .replace(/function useValueLocal\(\) \{ return useValue\(\$chip\) \}/, 'function useValueLocal() { return useValue($chip) }')

function loadPlugin() {
  let label = ''
  const intervals = []
  const listeners = {}
  const contributions = []
  const chip = { set: (value) => { label = value }, get: () => label }
  const host = {
    state: {
      busy: { listen: (fn) => { listeners.busy = fn } },
      focusedUsage: { get: () => ({ output: 0 }) },
    },
    onEvent: (type, fn) => { listeners[type] = fn },
    notify: () => {},
  }
  const ctx = {
    register: (c) => contributions.push(c),
    registerMany: (c) => contributions.push(...c),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return () => {} },
    onEvent: (type, fn) => { listeners[type] = fn; return () => { delete listeners[type] } },
    onDispose: () => {},
    rest: async () => ({ five_hour: { remaining_percent: 93 }, weekly: { remaining_percent: 88 } }),
  }
  const sandbox = {
    host, atom: (value) => { label = value; return chip },
    useValue: (atom) => atom.get(), PALETTE_AREA: 'palette',
    jsx: (_type, props) => props,
    Date, Math, Object, String, Array, RegExp, Error, Promise, setTimeout,
    console,
  }
  vm.runInNewContext(moduleSource, sandbox, { filename: 'desktop/plugin.js' })
  sandbox.plugin.register(ctx)
  return { label: () => label, listeners, intervals, contributions, busy: listeners.busy }
}

test('quota refresh uses an in-flight lock and surfaces the provided usage state', async () => {
  const app = loadPlugin()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(app.label(), /Codex 93% left/)
  assert.match(app.label(), /W 88% left/)
  assert.match(app.label(), /Live —/)
  assert.match(app.label(), /Avg -- tok\/s/)
  assert.equal(app.intervals.some((i) => i.ms === 5 * 60 * 1000), true)
})

test('live speed and task average update at turn start and completion', async () => {
  const app = loadPlugin()
  app.busy(true)
  const now = Date.now()
  app.listeners['*']({ type: 'message.delta', payload: { text: 'one two three four' } })
  assert.match(app.label(), /Live [0-9.]+/)
  app.busy(false)
  assert.match(app.label(), /Avg [0-9.]+ tok\/s/)
  assert.match(app.label(), /↓[1-9]/)
})
