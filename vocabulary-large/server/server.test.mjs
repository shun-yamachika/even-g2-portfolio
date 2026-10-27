import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVocabularyServer } from './index.mjs'

test('card service: timer, previous, serialized advances, persistence and CORS', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vocabulary-server-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cardsPath = join(root, 'cards.json'), statePath = join(root, 'state.json')
  await writeFile(cardsPath, JSON.stringify(['one', 'two', 'three'].map(word => ({ word, meaning: '意味', example: 'Example.' }))))
  let clock = 100_000, timerId = 0
  const timers = new Map()
  const options = { cardsPath, statePath, intervalMs: 5000, now: () => clock,
    setTimer: (cb, delay) => { timers.set(++timerId, { cb, delay }); return timerId },
    clearTimer: id => timers.delete(id),
  }
  let app = await createVocabularyServer(options)
  t.after(() => app.close())
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${app.server.address().port}`
  const current = () => fetch(`${url}/api/cards/current`).then(r => r.json())
  const move = path => fetch(`${url}/api/cards/${path}`, { method: 'POST' }).then(r => r.json())
  const first = await current()
  assert.equal(first.item.word, 'one')
  assert.equal(first.total, 3)
  assert.equal((await move('previous')).item.word, 'three')
  const updates = await Promise.all([move('advance'), move('advance')])
  assert.equal(new Set(updates.map(value => value.sequence)).size, 2)
  assert.equal((await current()).item.word, 'two')
  assert.equal(timers.size, 1)
  const [id, timer] = [...timers][0]
  timers.delete(id)
  clock += timer.delay
  await timer.cb()
  // closeは進行中の状態保存も待つ。
  await app.close()
  const saved = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(saved.item.word, 'three')
  const priorSession = saved.session
  app = await createVocabularyServer(options)
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const nextUrl = `http://127.0.0.1:${app.server.address().port}`
  const restarted = await fetch(`${nextUrl}/api/cards/current`).then(r => r.json())
  assert.equal(restarted.index, 2)
  assert.ok(restarted.sequence > saved.sequence)
  assert.notEqual(restarted.session, priorSession)
  const preflight = await fetch(`${nextUrl}/api/cards/advance`, { method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  assert.equal((await fetch(`${nextUrl}/health`).then(r => r.json())).cards, 3)
  assert.equal((await fetch(`${nextUrl}/missing`)).status, 404)
})

test('rejects invalid interval and invalid cards before starting', async t => {
  await assert.rejects(createVocabularyServer({ intervalMs: NaN }), /VOCABULARY_INTERVAL_MS/)
  const root = await mkdtemp(join(tmpdir(), 'vocabulary-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cardsPath = join(root, 'cards.json')
  await writeFile(cardsPath, JSON.stringify([{ word: 'missing fields' }]))
  await assert.rejects(createVocabularyServer({ cardsPath }), /meaning/)
})
