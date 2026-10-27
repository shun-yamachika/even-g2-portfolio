import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// このファイルは自宅PCで動く配信サーバー。
// カードの選択・時刻管理・状態保存を担当し、スマホへHTTP APIで現在の1枚を渡す。
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const statePath = resolve(rootDir, 'var/study-state.json')

// package.json の --env-file-if-exists=.env により、.envの値が環境変数へ読み込まれる。
const port = Number(process.env.STUDY_PORT ?? 8788)
const host = process.env.STUDY_HOST ?? '127.0.0.1'
const intervalMs = Math.max(3_000, Number(process.env.STUDY_INTERVAL_MS ?? 16_000))
const setIntervalMs = Math.max(60_000, Number(process.env.STUDY_SET_INTERVAL_MS ?? 3_600_000))

// ここへ追加すれば、3種類以上のカードセットも同じ仕組みで順番に切り替えられる。
const cardSetSources = [
  { id: 'linux', name: 'Linux Docs', path: resolve(rootDir, 'data/cards.json') },
  { id: 'travel', name: 'Travel English', path: resolve(rootDir, 'data/travel-cards.json') },
]

let cardSets = []
let state = {
  item: null,
  index: 0,
  sequence: 0,
  nextUpdateAt: null,
  total: 0,
  setId: '',
  setName: '',
  setIndex: 0,
  setTotal: 0,
  nextSetUpdateAt: null,
}
let mutationQueue = Promise.resolve()
let cardTimer
let setTimer

function jsonResponse(response, statusCode, body) {
  // スマホのWebViewと配信サーバーは別オリジンなので、CORSを許可する。
  // no-store により、古いカードがブラウザキャッシュから返ることも防ぐ。
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  })
  response.end(statusCode === 204 ? undefined : JSON.stringify(body))
}

function normalizeCards(parsed, source) {
  // 起動時に全カードを検査し、実行中に空の項目が表示されるのを防ぐ。
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${source.path}には1枚以上のカードが必要です`)
  }

  return parsed.map((card, index) => {
    const normalized = {
      id: String(card.id ?? `${source.id}-${index + 1}`).trim(),
      english: String(card.english ?? '').trim(),
      japanese: String(card.japanese ?? '').trim(),
      explanation: String(card.explanation ?? '').trim(),
    }
    if (!normalized.english || !normalized.japanese || !normalized.explanation) {
      throw new Error(`${source.path}の${index + 1}枚目に未入力項目があります`)
    }
    return normalized
  })
}

async function loadCardSets() {
  // JSONは起動時に一度だけ読む。教材を編集した場合はサーバーを再起動する。
  cardSets = await Promise.all(cardSetSources.map(async (source) => ({
    id: source.id,
    name: source.name,
    cards: normalizeCards(JSON.parse(await readFile(source.path, 'utf8')), source),
  })))
}

function activeSetIndex(now = Date.now()) {
  // Unix時刻を1時間単位に区切り、その番号でセットを循環させる。
  // 再起動しても、同じ時間帯なら同じセットが選ばれる。
  return Math.floor(now / setIntervalMs) % cardSets.length
}

function nextSetBoundary(now = Date.now()) {
  // 次にカードセットを切り替える絶対時刻を求める。
  return (Math.floor(now / setIntervalMs) + 1) * setIntervalMs
}

async function loadState() {
  // 前回終了時の位置を復元する。初回起動やファイル破損時は初期値を使う。
  try {
    const saved = JSON.parse(await readFile(statePath, 'utf8'))
    state.index = Number.isInteger(saved.index) ? saved.index : 0
    state.sequence = Number.isInteger(saved.sequence) ? saved.sequence : 0
    state.setId = typeof saved.setId === 'string' ? saved.setId : ''
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('状態ファイルを読めませんでした:', error)
  }

  const setIndex = activeSetIndex()
  const activeSet = cardSets[setIndex]
  if (state.setId !== activeSet.id || state.index < 0 || state.index >= activeSet.cards.length) {
    state.index = 0
  }
  state.setIndex = setIndex
}

async function saveState() {
  // 一時ファイルを書いてからrenameし、書き込み途中のJSONが残りにくくする。
  await mkdir(dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, statePath)
}

async function publish(setIndex, index, incrementSequence = true) {
  // state がAPIの「現在値」。タイマー更新とクリック更新は最後にここへ集約される。
  const activeSet = cardSets[setIndex]
  const safeIndex = ((index % activeSet.cards.length) + activeSet.cards.length) % activeSet.cards.length
  state = {
    item: activeSet.cards[safeIndex],
    index: safeIndex,
    sequence: state.sequence + (incrementSequence ? 1 : 0),
    nextUpdateAt: new Date(Date.now() + intervalMs).toISOString(),
    total: activeSet.cards.length,
    setId: activeSet.id,
    setName: activeSet.name,
    setIndex,
    setTotal: cardSets.length,
    nextSetUpdateAt: new Date(nextSetBoundary()).toISOString(),
  }
  await saveState()
  console.log(`[${state.setName} ${state.index + 1}/${state.total}] ${state.item.english}`)
  return state
}

function enqueueMutation(operation) {
  // タイマーとクリックが同時に来ても更新を直列化し、index/sequenceの競合を防ぐ。
  const result = mutationQueue.then(operation)
  mutationQueue = result.catch(() => undefined)
  return result
}

function advanceCard() {
  // 同じセットなら次の番号へ進み、時間境界を越えていれば新セットの先頭へ移る。
  return enqueueMutation(() => {
    const setIndex = activeSetIndex()
    const nextIndex = setIndex === state.setIndex ? state.index + 1 : 0
    return publish(setIndex, nextIndex)
  })
}

function syncCardSet() {
  // PCのスリープなどでタイマーを逃しても、現在時刻に合うセットへ同期する。
  return enqueueMutation(() => {
    const setIndex = activeSetIndex()
    if (setIndex === state.setIndex) return state
    return publish(setIndex, 0)
  })
}

function scheduleCardUpdate() {
  // 手動クリック後に待ち時間をリセットできるよう、setIntervalではなくsetTimeoutを使う。
  if (cardTimer) clearTimeout(cardTimer)
  const scheduledAt = new Date(state.nextUpdateAt).getTime()
  const delay = Number.isFinite(scheduledAt) ? Math.max(250, scheduledAt - Date.now()) : intervalMs
  cardTimer = setTimeout(async () => {
    try {
      await advanceCard()
    } catch (error) {
      console.error('カードの自動更新に失敗しました:', error)
    } finally {
      scheduleCardUpdate()
    }
  }, delay)
}

function scheduleSetUpdate() {
  // 次の時計上の境界でカードセットを切り替える。
  if (setTimer) clearTimeout(setTimer)
  setTimer = setTimeout(async () => {
    const previousSetIndex = state.setIndex
    try {
      await syncCardSet()
      if (previousSetIndex !== state.setIndex) scheduleCardUpdate()
    } catch (error) {
      console.error('カードセットの自動更新に失敗しました:', error)
    } finally {
      scheduleSetUpdate()
    }
  }, Math.max(250, nextSetBoundary() - Date.now() + 100))
}

// top-level awaitで、教材と保存状態を読み終えてからHTTP受付を始める。
await loadCardSets()
await loadState()
await publish(state.setIndex, state.index, false)

const server = createServer(async (request, response) => {
  // ブラウザが本通信の前に送るCORS確認へ応答する。
  if (request.method === 'OPTIONS') return jsonResponse(response, 204, {})
  if (request.method === 'GET' && request.url === '/health') {
    // 運用確認用。カード数、更新間隔、現在のセットを返す。
    await syncCardSet()
    return jsonResponse(response, 200, {
      ok: true,
      cards: cardSets.reduce((sum, set) => sum + set.cards.length, 0),
      intervalMs,
      setIntervalMs,
      activeSet: state.setId,
      sets: cardSets.map((set) => ({ id: set.id, name: set.name, cards: set.cards.length })),
      nextSetUpdateAt: state.nextSetUpdateAt,
    })
  }
  if (request.method === 'GET' && request.url === '/api/cards/current') {
    // スマホが定期取得する中心API。
    await syncCardSet()
    return jsonResponse(response, 200, state)
  }
  if (request.method === 'POST' && request.url === '/api/cards/advance') {
    // グラスのクリックから呼ばれ、待ち時間に関係なく次のカードへ進める。
    try {
      const nextState = await advanceCard()
      scheduleCardUpdate()
      return jsonResponse(response, 200, nextState)
    } catch (error) {
      console.error('カード更新に失敗しました:', error)
      return jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  return jsonResponse(response, 404, { error: 'Not found' })
})

server.listen(port, host, () => {
  // 127.0.0.1で待ち受け、Tailscale Serveが外向けHTTPSの入口になる構成。
  const totalCards = cardSets.reduce((sum, set) => sum + set.cards.length, 0)
  console.log(`Study server: http://${host}:${port} (${cardSets.length} sets, ${totalCards} cards, ${intervalMs}ms/card, ${setIntervalMs}ms/set)`)
})

scheduleCardUpdate()
scheduleSetUpdate()

function shutdown() {
  // systemd停止時にはタイマーを止め、HTTP受付を閉じてから終了する。
  if (cardTimer) clearTimeout(cardTimer)
  if (setTimer) clearTimeout(setTimer)
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
