import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function createVocabularyServer({
  cardsPath = resolve(root, 'data/cards.json'),
  statePath = resolve(root, 'var/vocabulary-state.json'),
  intervalMs = Number(process.env.VOCABULARY_INTERVAL_MS ?? 10_000),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 5_000 || intervalMs > 2_147_483_647) {
    throw new Error('VOCABULARY_INTERVAL_MSは5000〜2147483647の数値にしてください')
  }
  const parsed = JSON.parse(await readFile(cardsPath, 'utf8'))
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('単語カードが必要です')
  const cards = parsed.map((card, index) => {
    if (!card || ['word', 'meaning', 'example'].some(key => typeof card[key] !== 'string' || !card[key].trim())) {
      throw new Error(`${index + 1}枚目のword・meaning・exampleを確認してください`)
    }
    return { word: card.word.trim(), meaning: card.meaning.trim(), example: card.example.trim() }
  })
  let saved = {}
  try { saved = JSON.parse(await readFile(statePath, 'utf8')) ?? {} } catch (error) {
    if (error.code !== 'ENOENT') console.error('保存状態を読めないため先頭から開始します:', error.message)
  }
  let state = {
    index: Number.isInteger(saved.index) && saved.index >= 0 && saved.index < cards.length ? saved.index : 0,
    sequence: Number.isSafeInteger(saved.sequence) && saved.sequence >= 0 ? saved.sequence : 0,
  }
  const session = `${now()}-${Math.random().toString(36).slice(2)}`
  let timer, closed = false, generation = 0
  let queue = Promise.resolve()
  function enqueue(operation) {
    const result = queue.then(operation)
    queue = result.catch(() => {})
    return result
  }
  async function publish(index) {
    const safeIndex = ((index % cards.length) + cards.length) % cards.length
    const next = {
      item: cards[safeIndex], index: safeIndex, total: cards.length,
      sequence: state.sequence + 1, session,
      intervalMs, nextUpdateAt: new Date(now() + intervalMs).toISOString(),
    }
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(`${statePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`)
    await rename(`${statePath}.tmp`, statePath)
    state = next
    console.log(`[Vocabulary ${state.index + 1}/${cards.length}] ${state.item.word}`)
    return state
  }
  function schedule() {
    if (timer !== undefined) clearTimer(timer)
    const scheduledGeneration = ++generation
    if (closed) return
    timer = setTimer(() => {
      return enqueue(async () => {
        if (closed || scheduledGeneration !== generation) return
        try { await publish(state.index + 1) }
        catch (error) { console.error('単語の自動更新に失敗しました:', error) }
        finally { schedule() }
      })
    }, Math.max(500, new Date(state.nextUpdateAt).getTime() - now()))
  }
  await publish(state.index)
  function respond(response, status, body) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    })
    response.end(status === 204 ? undefined : JSON.stringify(body))
  }
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') return respond(response, 204)
      if (request.method === 'GET' && request.url === '/health') {
        return respond(response, 200, { ok: true, cards: cards.length, intervalMs, index: state.index })
      }
      if (request.method === 'GET' && request.url === '/api/cards/current') {
        return respond(response, 200, state)
      }
      if (request.method === 'POST' && ['/api/cards/advance', '/api/cards/previous'].includes(request.url)) {
        const offset = request.url.endsWith('/previous') ? -1 : 1
        const next = await enqueue(async () => {
          if (closed) throw new Error('サーバー停止中です')
          const result = await publish(state.index + offset)
          schedule()
          return result
        })
        return respond(response, 200, next)
      }
      respond(response, 404, { error: 'Not found' })
    } catch (error) {
      console.error(error)
      respond(response, 500, { error: 'カードを更新できませんでした' })
    }
  })
  schedule()
  return {
    server,
    async close() {
      closed = true
      generation++
      if (timer !== undefined) clearTimer(timer)
      await queue
      if (server.listening) await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.VOCABULARY_PORT ?? 8790)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('VOCABULARY_PORTが不正です')
  const host = process.env.VOCABULARY_HOST ?? '127.0.0.1'
  const app = await createVocabularyServer()
  app.server.on('error', error => { console.error(error); process.exit(1) })
  app.server.listen(port, host, () => console.log(`Vocabulary server: http://${host}:${port}`))
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    void app.close().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
  })
}
