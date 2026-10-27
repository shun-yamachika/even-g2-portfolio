import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const statePath = resolve(rootDir, 'var/news-state.json')
const port = Number(process.env.NEWS_PORT ?? 8787)
const host = process.env.NEWS_HOST ?? '127.0.0.1'
const intervalMs = Math.max(10_000, Number(process.env.NEWS_INTERVAL_MS ?? 30_000))
const provider = process.env.NEWS_PROVIDER ?? 'mock'
const openAiModel = process.env.OPENAI_MODEL ?? 'gpt-5.6-luna'
const rssRefreshMs = Math.max(60_000, Number(process.env.RSS_REFRESH_MS ?? 600_000))
const rssFilter = process.env.RSS_FILTER ?? 'all'
const articleBodyMaxChars = Math.max(200, Number(process.env.ARTICLE_BODY_MAX_CHARS ?? 2_000))
const defaultRssFeedUrls = [
  'https://www.fnn.jp/list/feed/rss',
  'https://mainichi.jp/rss/etc/mainichi-flash.rss',
  'https://www.asahi.com/rss/asahi/newsheadlines.rdf',
]
const rssFeedUrls = (process.env.RSS_FEED_URLS ?? defaultRssFeedUrls.join(','))
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean)

const mockItems = [
  {
    headline: 'スマートグラス向けニュース表示を試験中',
    summary: 'これは表示確認用のデモ記事です。サーバーが記事を更新すると、G2側が自動検知して新しい内容へ切り替えます。',
    category: 'テクノロジー',
    sourceName: 'News Flow Demo',
    sourceUrl: 'https://example.com/demo/1',
  },
  {
    headline: 'クリック操作で次の記事を即時取得',
    summary: '通常は設定した間隔で自動更新します。待たずに読み進めたいときは、G2を一度クリックすると次の記事を取得します。',
    category: '使い方',
    sourceName: 'News Flow Demo',
    sourceUrl: 'https://example.com/demo/2',
  },
  {
    headline: 'OpenAI連携はサーバー側で安全に実行',
    summary: 'APIキーをG2アプリへ埋め込まず、ニュース検索と要約をサーバー側で実行する構成です。キー漏えいの危険を抑えます。',
    category: '設計',
    sourceName: 'News Flow Demo',
    sourceUrl: 'https://example.com/demo/3',
  },
]

let state = {
  item: null,
  sequence: 0,
  nextUpdateAt: null,
  provider,
  seen: [],
}
let updatePromise = null
let rssRefreshPromise = null
let rssItems = []
let rssLastRefreshAt = 0
const articleCache = new Map()

function jsonResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  })
  response.end(statusCode === 204 ? undefined : JSON.stringify(body))
}

function publicState() {
  const { seen: _seen, ...visible } = state
  return visible
}

function limitCharacters(text, maximum) {
  const characters = Array.from(String(text).trim())
  return characters.length <= maximum
    ? characters.join('')
    : `${characters.slice(0, maximum - 1).join('')}…`
}

function decodeEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  }
  return String(value)
    .replace(/&#(x?[0-9a-f]+);/gi, (_match, code) => {
      const base = code.toLowerCase().startsWith('x') ? 16 : 10
      const number = Number.parseInt(base === 16 ? code.slice(1) : code, base)
      return Number.isFinite(number) ? String.fromCodePoint(number) : ''
    })
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match)
}

function cleanXmlText(value) {
  const withoutCdata = String(value ?? '').replace(/<!\[CDATA\[|\]\]>/g, '')
  const decoded = decodeEntities(withoutCdata)
  return decodeEntities(decoded.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tagValue(xml, names) {
  for (const name of names) {
    const escaped = escapeRegExp(name)
    const match = xml.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'))
    if (match) return cleanXmlText(match[1])
  }
  return ''
}

function parseRss(xml, feedUrl) {
  const channel = xml.match(/<channel(?:\s[^>]*)?>([\s\S]*?)<\/channel>/i)?.[1] ?? xml
  const sourceName = tagValue(channel, ['title']) || new URL(feedUrl).hostname
  const blocks = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)]

  return blocks
    .map((match) => {
      const item = match[1]
      const rawHeadline = tagValue(item, ['title'])
      const sourceUrl = tagValue(item, ['link'])
      const description = tagValue(item, ['description', 'content:encoded'])
      const published = tagValue(item, ['pubDate', 'dc:date', 'updated'])
      const publishedDate = new Date(published)
      const itemSource = tagValue(item, ['source'])
      const isGoogleBusiness = feedUrl.includes('/topic/BUSINESS')
      const headline = itemSource
        ? rawHeadline.replace(new RegExp(`\\s+-\\s+${escapeRegExp(itemSource)}$`), '')
        : rawHeadline
      return {
        id: tagValue(item, ['guid']) || sourceUrl,
        headline,
        summary: isGoogleBusiness ? headline : (description && description !== headline ? description : headline),
        category: tagValue(item, ['category', 'dc:subject']) || (isGoogleBusiness ? '経済・企業' : '主要'),
        sourceName: itemSource || sourceName,
        sourceUrl,
        publishedAt: Number.isNaN(publishedDate.getTime()) ? new Date().toISOString() : publishedDate.toISOString(),
        feedUrl,
      }
    })
    .filter((item) => item.headline && item.sourceUrl)
}

function isBusinessNews(item) {
  if (item.feedUrl.includes('/topic/BUSINESS')) return true
  if (item.sourceUrl.includes('/00m/020/')) return true

  const text = `${item.headline} ${item.summary}`
  if (/(企業|会社|決算|業績|売上高|営業利益|純利益|増益|減益|赤字決算|黒字転換|株価|株式|株主|東証|日経平均|TOPIX|NYダウ|ダウ平均|ナスダック|為替|円相場|日銀|買収|合併|経営統合|上場|社長|会長|CEO|破産|倒産|事業再編|設備投資|資本提携|リコール|新製品|値上げ|値下げ|半導体|スタートアップ)/i.test(text)) return true

  if (/(ライフ|エンタメ|グルメ|文化|スポーツ)/.test(item.category)) return false
  return /(経済|企業|会社|産業|ビジネス|金融|マネー)/.test(item.category)
}

function isSportsNews(item) {
  const text = `${item.category} ${item.headline} ${item.summary}`
  return /(スポーツ|野球|サッカー|フットボール|大リーグ|メジャーリーグ|MLB|プロ野球|高校野球|WBC|Jリーグ|バスケットボール|バスケ|バレーボール|ラグビー|テニス|ゴルフ|相撲|フィギュアスケート|陸上|競泳|オリンピック|パラリンピック|五輪|F1)/i.test(text)
}

function isItOrFinanceNews(item) {
  const text = `${item.category} ${item.headline} ${item.summary}`
  return /(IT|情報技術|テクノロジー|デジタル|生成AI|人工知能|AI|ソフトウェア|クラウド|データセンター|サイバー|セキュリティ|スマートフォン|パソコン|金融|銀行|証券|保険|融資|金利|住宅ローン|仮想通貨|暗号資産|ビットコイン|フィンテック)/i.test(text)
}

function isPriorityNews(item) {
  return isBusinessNews(item) || isSportsNews(item) || isItOrFinanceNews(item)
}

function matchesRssFilter(item) {
  if (rssFilter === 'all') return true
  if (rssFilter === 'business') return isBusinessNews(item)
  throw new Error(`未対応のRSS_FILTERです: ${rssFilter}`)
}

function htmlAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return cleanXmlText(match?.[1] ?? match?.[2] ?? match?.[3] ?? '')
}

function extractMetaDescription(html) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0]
    const key = (htmlAttribute(tag, 'property') || htmlAttribute(tag, 'name')).toLowerCase()
    if (key === 'og:description' || key === 'description') {
      const content = htmlAttribute(tag, 'content')
      if (content) return content
    }
  }
  return ''
}

function findArticleBody(value) {
  if (!value || typeof value !== 'object') return ''
  if (typeof value.articleBody === 'string') return cleanXmlText(value.articleBody)
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findArticleBody(child)
    if (found) return found
  }
  return ''
}

function extractJsonLdBody(html) {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const body = findArticleBody(JSON.parse(match[1].trim()))
      if (body) return body
    } catch {
      // Broken third-party JSON-LD should not prevent the article fallback.
    }
  }
  return ''
}

function extractParagraphBody(html) {
  const withoutNoise = html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
  const articleFragments = [...withoutNoise.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)]
    .map((match) => match[1])
  const fragments = articleFragments.length > 0 ? articleFragments : [withoutNoise]
  const paragraphs = []
  const seenParagraphs = new Set()

  for (const fragment of fragments) {
    for (const match of fragment.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
      const text = cleanXmlText(match[1])
      if (text.length < 20) continue
      if (/(関連記事|あわせて読みたい|ログイン|会員登録|利用規約|プライバシー|Copyright|無断転載|JavaScript)/i.test(text)) continue
      if (seenParagraphs.has(text)) continue
      seenParagraphs.add(text)
      paragraphs.push(text)
      if (paragraphs.join('\n').length >= articleBodyMaxChars) break
    }
    if (paragraphs.join('\n').length >= articleBodyMaxChars) break
  }
  return paragraphs.join('\n')
}

async function addArticleBody(item) {
  if (articleCache.has(item.sourceUrl)) return articleCache.get(item.sourceUrl)

  const loading = (async () => {
    try {
      const response = await fetch(item.sourceUrl, {
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'user-agent': 'Even-G2-News-Flow/0.1 (personal RSS reader)',
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const html = await response.text()
      const description = extractMetaDescription(html)
      const body = extractJsonLdBody(html) || extractParagraphBody(html) || description || item.summary
      return {
        ...item,
        summary: description || item.summary,
        body,
      }
    } catch (error) {
      console.error(`記事本文の取得に失敗しました (${item.sourceUrl}):`, error)
      return { ...item, body: item.summary }
    }
  })()

  articleCache.set(item.sourceUrl, loading)
  return loading
}

async function fetchRssFeed(feedUrl) {
  const response = await fetch(feedUrl, {
    headers: {
      accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
      'user-agent': 'Even-G2-News-Flow/0.1 (personal RSS reader)',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseRss(await response.text(), feedUrl)
}

async function refreshRssFeeds(force = false) {
  if (!force && rssItems.length > 0 && Date.now() - rssLastRefreshAt < rssRefreshMs) return rssItems
  if (rssRefreshPromise) return rssRefreshPromise

  rssRefreshPromise = (async () => {
    const results = await Promise.allSettled(rssFeedUrls.map(fetchRssFeed))
    const collected = []
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        collected.push(...result.value)
      } else {
        console.error(`RSS取得に失敗しました (${rssFeedUrls[index]}):`, result.reason)
      }
    })

    if (collected.length === 0) {
      if (rssItems.length > 0) return rssItems
      throw new Error('利用可能なRSS記事がありません')
    }

    rssItems = [...new Map(collected.filter(matchesRssFilter).map((item) => [item.sourceUrl, item])).values()]
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    rssLastRefreshAt = Date.now()
    const priorityCount = rssItems.filter(isPriorityNews).length
    console.log(`RSS更新: ${rssItems.length}件、優先対象${priorityCount}件 (${results.filter((result) => result.status === 'fulfilled').length}/${rssFeedUrls.length}媒体)`)
    return rssItems
  })().finally(() => {
    rssRefreshPromise = null
  })

  return rssRefreshPromise
}

function wasSeen(sourceUrl) {
  return state.seen.some((entry) => entry === sourceUrl || entry.endsWith(` ${sourceUrl}`))
}

async function fetchRssNews() {
  await refreshRssFeeds()
  let candidates = rssItems.filter((item) => !wasSeen(item.sourceUrl))

  if (candidates.length === 0) {
    const currentFeedUrls = new Set(rssItems.map((item) => item.sourceUrl))
    state.seen = state.seen.filter((entry) => {
      for (const sourceUrl of currentFeedUrls) {
        if (entry === sourceUrl || entry.endsWith(` ${sourceUrl}`)) return false
      }
      return true
    })
    candidates = rssItems.filter((item) => item.sourceUrl !== state.item?.sourceUrl)
  }

  const unseen = candidates.find(isPriorityNews) ?? candidates[0]
  if (unseen) return addArticleBody(unseen)

  const currentUrl = state.item?.sourceUrl
  const reusable = rssItems.find((item) => isPriorityNews(item) && item.sourceUrl !== currentUrl)
    ?? rssItems.find((item) => item.sourceUrl !== currentUrl)
    ?? rssItems[0]
  if (!reusable) throw new Error('表示できるRSS記事がありません')
  return addArticleBody(reusable)
}

function normalizeItem(candidate) {
  const now = new Date().toISOString()
  return {
    id: String(candidate.id ?? `${Date.now()}-${state.sequence + 1}`),
    headline: limitCharacters(candidate.headline, 42),
    summary: limitCharacters(candidate.summary, 100),
    body: limitCharacters(candidate.body || candidate.summary, articleBodyMaxChars),
    category: limitCharacters(candidate.category || '主要', 12),
    sourceName: limitCharacters(candidate.sourceName || '出典不明', 30),
    sourceUrl: String(candidate.sourceUrl || ''),
    publishedAt: candidate.publishedAt || now,
    generatedAt: now,
  }
}

async function loadState() {
  try {
    const saved = JSON.parse(await readFile(statePath, 'utf8'))
    state = { ...state, ...saved, provider }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('状態ファイルを読めませんでした:', error)
  }
}

async function saveState() {
  await mkdir(dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, statePath)
}

function findOutputText(response) {
  for (const output of response.output ?? []) {
    if (output.type !== 'message') continue
    for (const content of output.content ?? []) {
      if (content.type === 'output_text') return content.text
    }
  }
  throw new Error('OpenAI response did not contain output_text')
}

async function fetchOpenAiNews() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('NEWS_PROVIDER=openai には OPENAI_API_KEY が必要です')
  }

  const recent = state.seen.slice(-20).join('\n') || 'なし'
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: openAiModel,
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
      input: [
        {
          role: 'developer',
          content: 'あなたは日本語のニュース編集者です。信頼できる報道機関の最新記事を選び、事実だけを簡潔にまとめてください。',
        },
        {
          role: 'user',
          content: `日本で今読む価値のある最新ニュースを1件検索してください。要約は日本語100字以内。過去に表示した次の記事と重複させないでください。\n${recent}`,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'news_item',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              headline: { type: 'string' },
              summary: { type: 'string' },
              category: { type: 'string' },
              sourceName: { type: 'string' },
              sourceUrl: { type: 'string' },
              publishedAt: { type: 'string' },
            },
            required: ['headline', 'summary', 'category', 'sourceName', 'sourceUrl', 'publishedAt'],
          },
        },
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`OpenAI API ${response.status}: ${await response.text()}`)
  }
  return JSON.parse(findOutputText(await response.json()))
}

async function nextCandidate() {
  if (provider === 'rss') return fetchRssNews()
  if (provider === 'openai') return fetchOpenAiNews()
  if (provider !== 'mock') throw new Error(`未対応のNEWS_PROVIDERです: ${provider}`)
  return mockItems[state.sequence % mockItems.length]
}

async function updateNews() {
  if (updatePromise) return updatePromise
  updatePromise = (async () => {
    const item = normalizeItem(await nextCandidate())
    state = {
      item,
      sequence: state.sequence + 1,
      nextUpdateAt: new Date(Date.now() + intervalMs).toISOString(),
      provider,
      seen: [...state.seen, item.sourceUrl].slice(-500),
    }
    await saveState()
    console.log(`[${state.sequence}] ${item.headline}`)
    return publicState()
  })().finally(() => {
    updatePromise = null
  })
  return updatePromise
}

await loadState()
await updateNews().catch((error) => console.error('初回ニュース取得に失敗しました:', error))

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return jsonResponse(response, 204, {})
  if (request.method === 'GET' && request.url === '/health') {
    return jsonResponse(response, 200, {
      ok: true,
      provider,
      rssItems: provider === 'rss' ? rssItems.length : undefined,
      rssFilter: provider === 'rss' ? rssFilter : undefined,
      rssLastRefreshAt: provider === 'rss' && rssLastRefreshAt ? new Date(rssLastRefreshAt).toISOString() : undefined,
    })
  }
  if (request.method === 'GET' && request.url === '/api/news/current') {
    return jsonResponse(response, 200, publicState())
  }
  if (request.method === 'POST' && request.url === '/api/news/advance') {
    try {
      return jsonResponse(response, 200, await updateNews())
    } catch (error) {
      console.error('ニュース更新に失敗しました:', error)
      return jsonResponse(response, 502, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  return jsonResponse(response, 404, { error: 'Not found' })
})

server.listen(port, host, () => {
  console.log(`News server: http://${host}:${port} (${provider}, ${intervalMs}ms)`)
})

const timer = setInterval(() => {
  void updateNews().catch((error) => console.error('自動更新に失敗しました:', error))
}, intervalMs)

function shutdown() {
  clearInterval(timer)
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
