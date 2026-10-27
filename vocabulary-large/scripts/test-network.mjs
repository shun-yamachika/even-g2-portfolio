import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../', import.meta.url)
const types = readFileSync(new URL('node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts', root), 'utf8')
const declaration = types.match(/declare enum OsEventTypeList \{[^}]+\}/)[0].replace('declare enum', 'export enum')
const exported = {}
vm.runInNewContext(`(function(exports){${ts.transpileModule(declaration, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText}})`)(exported)
const events = exported.OsEventTypeList
const source = readFileSync(new URL('src/main.ts', root), 'utf8')
  .replaceAll('import.meta.env.DEV', 'false')
  .replaceAll('import.meta.env.VITE_VOCABULARY_API_URL', "'http://test'")
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

async function start() {
  let now = 100_000, id = 0, handler, sends = 0, failed = false, shutdownMode
  const listeners = new Map(), timers = new Map(), requests = [], rendered = [], status = { textContent: '' }
  let state = { item: { word: 'one', meaning: '意味', example: 'Example.' }, index: 0, total: 3,
    sequence: 1, session: 'a', intervalMs: 10_000, nextUpdateAt: new Date(now + 10_000).toISOString() }
  const document = { hidden: false, querySelector: () => status, addEventListener: (type, cb) => listeners.set(type, cb) }
  const window = { addEventListener() {}, setTimeout: (cb, delay) => { timers.set(++id, { cb, due: now + delay }); return id }, clearTimeout: id => timers.delete(id) }
  class Property { constructor(value) { Object.assign(this, value) } }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
  const bridge = {
    createStartUpPageContainer: async () => 0,
    textContainerUpgrade: async () => true,
    updateImageRawData: async () => { sends++; return 'success' },
    onEvenHubEvent: cb => { handler = cb },
    shutDownPageContainer: async mode => { shutdownMode = mode; return true },
  }
  const sdk = { OsEventTypeList: events, waitForEvenAppBridge: async () => bridge }
  for (const name of ['CreateStartUpPageContainer', 'ImageContainerProperty', 'ImageRawDataUpdate', 'TextContainerProperty', 'TextContainerUpgrade']) sdk[name] = Property
  const context = vm.createContext({ window, document, console, Date: Clock, AbortController,
    fetch: async (url, options) => {
      requests.push({ url, method: options.method })
      if (failed) throw new Error('offline')
      if (url.endsWith('/advance') || url.endsWith('/previous')) {
        state = { ...state, index: (state.index + (url.endsWith('/advance') ? 1 : 2)) % 3, sequence: state.sequence + 1,
          nextUpdateAt: new Date(now + 10_000).toISOString() }
      }
      return { ok: true, json: async () => structuredClone(state) }
    },
  })
  const requireMock = name => name.includes('sdk') ? sdk : name === './renderCard' ? {
    cardTileSize: { width: 200, height: 100 }, renderCardTiles: async (_card, index) => { rendered.push(index); return [[], [], [], []] },
  } : (() => { throw new Error(`Unexpected import ${name}`) })()
  await vm.runInContext(`(async function(require,exports){${code}})`, context)(requireMock, {})
  const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
  await flush()
  const advance = async delay => {
    const end = now + delay
    while (true) {
      const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0]
      if (!next || next[1].due > end) break
      now = next[1].due; timers.delete(next[0]); next[1].cb(); await flush()
    }
    now = end
  }
  return { document, listeners, requests, rendered, status, advance, flush, timers,
    event: type => handler({ sysEvent: { eventType: type } }),
    setState: value => { state = { ...state, ...value } }, fail: value => { failed = value },
    get sends() { return sends }, get shutdownMode() { return shutdownMode },
  }
}

test('polls PC while hidden; redraws only a new sequence and resyncs on resume', async () => {
  const app = await start()
  assert.equal(app.sends, 4)
  app.document.hidden = true
  app.listeners.get('visibilitychange')()
  await app.advance(11_000)
  assert.ok(app.requests.length > 1)
  assert.equal(app.sends, 4, 'same server card is not resent')
  app.setState({ index: 2, sequence: 10 })
  app.document.hidden = false
  app.listeners.get('visibilitychange')()
  app.event(events.FOREGROUND_ENTER_EVENT)
  await app.flush()
  assert.equal(app.sends, 8)
  assert.equal(app.rendered.at(-1), 2, 'server position wins over local time')
  app.setState({ session: 'restarted' })
  app.event(events.FOREGROUND_ENTER_EVENT)
  await app.flush()
  assert.equal(app.sends, 12, 'server restart also forces resync')
})

test('manual moves use POST, recover after offline, confirm exit and stop on host exit', async () => {
  const app = await start()
  app.event(events.CLICK_EVENT)
  await app.flush()
  assert.equal(app.requests.at(-1).method, 'POST')
  assert.ok(app.requests.at(-1).url.endsWith('/advance'))
  await app.advance(2_100)
  app.event(events.SCROLL_TOP_EVENT)
  await app.flush()
  assert.ok(app.requests.at(-1).url.endsWith('/previous'))
  app.fail(true)
  app.event(events.FOREGROUND_ENTER_EVENT)
  await app.flush()
  assert.match(app.status.textContent, /offline/)
  app.fail(false)
  await app.advance(2_000)
  assert.match(app.status.textContent, /動作中/)
  app.event(events.DOUBLE_CLICK_EVENT)
  assert.equal(app.shutdownMode, 1)
  app.event(events.SYSTEM_EXIT_EVENT)
  const previousRequests = app.requests.length
  app.event(events.FOREGROUND_ENTER_EVENT)
  await app.advance(60_000)
  assert.equal(app.requests.length, previousRequests)
  assert.equal(app.timers.size, 0)
})
