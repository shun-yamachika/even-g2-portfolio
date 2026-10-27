import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const project = new URL('../', import.meta.url)
// SDK本体はグローバルタイマーを書き換えるため、公開型定義から実際のイベント値を読む。
const sdkTypes = readFileSync(new URL('node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts', project), 'utf8')
const enumSource = sdkTypes.match(/declare enum OsEventTypeList \{[^}]+\}/)?.[0]
assert.ok(enumSource)
const enumCode = ts.transpileModule(enumSource.replace('declare enum', 'export enum'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText
const enumExports = {}
vm.runInNewContext(`(function(exports) {${enumCode}\n})`)(enumExports)
const { OsEventTypeList } = enumExports
const compiled = new Map()
for (const name of ['main', 'diagnostics', 'mainText']) {
  const source = readFileSync(new URL(`src/${name === 'main' ? 'mainOffline' : name}.ts`, project), 'utf8')
    .replaceAll('import.meta.env.VITE_CARD_INTERVAL_MS', '10000')
  compiled.set(name, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)
}

async function start({ storage = new Map(), failStorage = false, hangRender = false, entry = 'main' } = {}) {
  let now = 100_000, timerId = 0, handler, sends = 0, textWrites = 0, page
  const timers = new Map(), listeners = new Map(), rendered = []
  const nodes = new Map()
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { style: {}, value: '', addEventListener() {} })
    return nodes.get(selector)
  }
  const document = { hidden: false, querySelector: node, addEventListener: (type, cb) => listeners.set(type, cb) }
  const addTimer = (cb, delay, repeat = false) => {
    const id = ++timerId
    timers.set(id, { cb, delay, repeat, due: now + delay })
    return id
  }
  const window = {
    addEventListener: (type, cb) => listeners.set(type, cb),
    setTimeout: addTimer, clearTimeout: id => timers.delete(id),
    setInterval: (cb, delay) => addTimer(cb, delay, true), clearInterval: id => timers.delete(id),
  }
  class Property { constructor(value) { Object.assign(this, value) } }
  const bridge = {
    onLaunchSource: cb => cb('appMenu'),
    createStartUpPageContainer: async value => { page = value; return 0 },
    updateImageRawData: async () => { sends++; return 'success' },
    textContainerUpgrade: async () => { textWrites++; return true },
    onEvenHubEvent: cb => { handler = cb }, shutDownPageContainer: async () => true,
  }
  const sdk = { OsEventTypeList, waitForEvenAppBridge: async () => bridge }
  for (const key of ['CreateStartUpPageContainer', 'ImageContainerProperty', 'ImageRawDataUpdate', 'TextContainerProperty', 'TextContainerUpgrade']) sdk[key] = Property
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
  const context = vm.createContext({
    window, document, navigator: { userAgent: 'test' }, Date: Clock,
    console: { info() {}, error() {} },
    localStorage: {
      getItem: key => { if (failStorage) throw new Error('unavailable'); return storage.get(key) ?? null },
      setItem: (key, value) => { if (failStorage) throw new Error('unavailable'); storage.set(key, value) },
    },
  })
  const load = name => {
    const exports = {}
    vm.runInContext(`(function(require, exports) {${compiled.get(name)}\n})`, context)(requireMock, exports)
    return exports
  }
  let diagnostics
  function requireMock(name) {
    if (name === '@evenrealities/even_hub_sdk') return sdk
    if (name === './diagnostics') return diagnostics ??= load('diagnostics')
    if (name === './cards') return { cards: Array.from({ length: 4 }, (_, i) => ({ word: `word${i}`, meaning: '意味', example: 'Example.' })) }
    if (name === './renderCard') return {
      cardTileSize: { width: 200, height: 100 },
      renderCardTiles: async (_card, index) => {
        rendered.push(index)
        if (hangRender) return new Promise(() => {})
        return [[], [], [], []]
      },
    }
    throw new Error(`Unexpected import: ${name}`)
  }
  const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }
  const ready = vm.runInContext(`(async function(require, exports) {${compiled.get(entry)}\n})`, context)(requireMock, {})
  if (!hangRender) await ready
  await flush()
  const advance = async duration => {
    const end = now + duration
    while (true) {
      const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0]
      if (!next || next[1].due > end) break
      const [id, timer] = next
      now = timer.due
      if (timer.repeat) timer.due += timer.delay
      else timers.delete(id)
      timer.cb()
      await flush()
    }
    now = end
  }
  return { document, listeners, storage, rendered, timers, advance, flush,
    diagnostics, page, get textWrites() { return textWrites }, get sends() { return sends }, event: event => handler(event) }
}

test('keeps advancing for 6 hidden minutes and preserves the countdown on resume', async () => {
  const app = await start()
  app.document.hidden = true
  app.listeners.get('visibilitychange')()
  await app.advance(360_000)
  assert.equal(app.rendered.length, 37)
  assert.equal(app.sends, 37 * 4)
  await app.advance(9_000)
  app.document.hidden = false
  app.listeners.get('visibilitychange')()
  app.event({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } })
  await app.advance(1_000)
  assert.equal(app.rendered.length, 38)
})

test('host exit is recorded and stops both clocks and image writes', async () => {
  const app = await start()
  app.event({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT, systemExitReasonCode: 1 } })
  await app.advance(360_000)
  assert.equal(app.sends, 4)
  assert.equal(app.timers.size, 0)
  const logs = app.diagnostics.diagnosticReport()
  assert.match(logs, /systemExitReasonCode/)
  assert.match(logs, /host-exit/)
})

test('heartbeat identifies a pending render without starting competing transfers', async () => {
  const app = await start({ hangRender: true })
  await app.advance(60_000)
  const logs = app.diagnostics.diagnosticReport().split('\n').map(JSON.parse)
  const heartbeats = logs.filter(log => log.event === 'heartbeat')
  assert.equal(heartbeats.length, 4)
  assert.ok(heartbeats.every(log => log.stage === 'rendering'))
  assert.equal(app.sends, 0)
})

test('relaunch restores the last completed card and retains the prior log', async () => {
  const app = await start()
  await app.advance(20_000)
  const prior = app.diagnostics.diagnosticReport().split('\n')[0]
  const restarted = await start({ storage: app.storage })
  assert.equal(restarted.rendered[0], 2)
  assert.ok(restarted.diagnostics.diagnosticReport().includes(prior))
})

test('bad or unavailable storage does not block startup; log stays bounded', async () => {
  const app = await start({ failStorage: true })
  assert.equal(app.sends, 4)
  for (let i = 0; i < 450; i++) app.diagnostics.recordDiagnostic('test')
  assert.equal(app.diagnostics.diagnosticReport().split('\n').length, 400)
  const badStorage = new Map([
    ['vocabulary-large.diagnostics.v1', 'broken JSON'],
    ['vocabulary-large.position.v1', '-1'],
  ])
  const recovered = await start({ storage: badStorage })
  assert.equal(recovered.rendered[0], 0)
})

test('text comparison runs for 10 hidden minutes with no images, canvas or network', async () => {
  // この環境にはfetch・Canvasを用意していない。利用すれば動作確認が失敗する。
  const app = await start({ entry: 'mainText' })
  assert.equal(app.page.containerTotalNum, 1)
  assert.equal(app.page.imageObject, undefined)
  app.document.hidden = true
  app.listeners.get('visibilitychange')()
  await app.advance(600_000)
  assert.equal(app.textWrites, 60)
  assert.equal(app.sends, 0)
  assert.equal(app.rendered.length, 0)
  assert.equal(app.storage.size, 0, 'comparison avoids diagnostic storage writes')
  app.event({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } })
  await app.flush()
  assert.equal(app.textWrites, 61)
  app.event({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } })
  await app.advance(60_000)
  assert.equal(app.textWrites, 61)
})
