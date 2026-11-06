/**
 * Host half of the B站音频 plugin.
 *
 * The browser cannot call Bilibili's APIs directly (no CORS) and its audio CDN
 * rejects cross-origin media requests, so this half owns two small HTTP routes
 * on the local Harness server:
 *
 *   GET /bili-audio/api/resolve?raw=<BV号 | av号 | 视频链接>
 *       -> title / cover / owner / duration / a signed, proxy-backed stream URL
 *   GET /bili-audio/api/stream?u=<base64url of an upstream audio URL>
 *       -> byte-range aware audio proxy (Referer + UA are added here)
 *
 * Only whitelisted Bilibili-owned hosts may be proxied.
 */
import { Readable } from 'node:stream'

export const inject = ['webServer']

const PREFIX = '/bili-audio/api'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com'
const ALLOWED_SUFFIXES = [
  '.hdslb.com',
  '.bilivideo.com',
  '.bilivideo.cn',
  '.biliapi.net',
  '.akamaized.net',
  '.szbdyd.com',
]

const BILI_ERRORS = {
  '-404': '视频不存在或已被删除',
  '-403': '没有权限播放这个视频',
  '-352': '被 B站 风控拦截了，过一会儿再试',
  '-10403': '这个视频在当前地区无法播放',
  '-400': '请求参数不对',
  '62002': '视频不可见（可能是私密稿件）',
  '62004': '稿件还在审核中',
  '62012': '仅 UP 主自己可见',
}

function biliErrorText(code, fallback) {
  return BILI_ERRORS[String(code)] ?? fallback ?? `B站 返回错误（code ${code}）`
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function httpsify(url) {
  if (typeof url !== 'string' || url.length === 0) return ''
  return url.startsWith('//') ? `https:${url}` : url.replace(/^http:\/\//i, 'https://')
}

/**
 * Parses a single-range `bytes=` header. Returns null when the range is
 * malformed or completely outside the resource (-> 416).
 */
function parseRangeHeader(header, total) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (match === null) return null
  const [, startText, endText] = match
  if (startText === '' && endText === '') return null
  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    return { start: Math.max(0, total - suffix), end: total - 1 }
  }
  const start = Number(startText)
  if (!Number.isFinite(start) || start >= total) return null
  const end = endText === '' ? total - 1 : Math.min(Number(endText), total - 1)
  if (!Number.isFinite(end) || start > end) return null
  return { start, end }
}

/** Yields bytes [start, end] of a stream that begins at byte 0. */
async function* sliceBody(body, start, end) {
  const limit = end - start + 1
  let offset = 0
  let emitted = 0
  for await (const chunk of body) {
    if (emitted >= limit) return
    const begin = offset
    offset += chunk.length
    if (offset <= start) continue
    let data = begin < start ? chunk.subarray(start - begin) : chunk
    if (emitted + data.length > limit) data = data.subarray(0, limit - emitted)
    emitted += data.length
    if (data.length > 0) yield data
  }
}

function isAllowedHost(hostname) {
  return ALLOWED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
}

function parseTarget(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return null
  const bv = value.match(/BV[0-9A-Za-z]{10}/)
  if (bv !== null) return { bvid: bv[0] }
  const av = value.match(/av(\d+)/i)
  if (av !== null) return { aid: av[1] }
  return null
}

async function expandShortLink(raw) {
  const direct = parseTarget(raw)
  if (direct !== null) return direct
  const url = String(raw ?? '').match(/https?:\/\/[^\s"'<>]+/)
  if (url === null) return null
  const short = url[0]
  if (!/^https?:\/\/b23\.tv\//i.test(short)) return null
  const response = await fetch(short, {
    redirect: 'manual',
    headers: { 'user-agent': UA },
  })
  const location = response.headers.get('location')
  return location === null ? null : parseTarget(location)
}

async function biliJson(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': UA,
      referer: REFERER,
      accept: 'application/json, text/plain, */*',
    },
  })
  if (!response.ok) throw new Error(`B站 接口返回 HTTP ${response.status}`)
  return response.json()
}

async function handleResolve(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const raw = url.searchParams.get('raw') ?? ''
  const target = await expandShortLink(raw)
  if (target === null) {
    sendJson(res, 200, {
      ok: false,
      error: '没认出 BV 号，粘贴「BV1xx…」或视频链接试试',
    })
    return
  }

  const viewUrl =
    target.bvid !== undefined
      ? `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(target.bvid)}`
      : `https://api.bilibili.com/x/web-interface/view?aid=${encodeURIComponent(target.aid)}`
  const view = await biliJson(viewUrl)
  if (view.code !== 0) {
    sendJson(res, 200, { ok: false, error: biliErrorText(view.code, view.message) })
    return
  }
  const data = view.data
  const cid = data.cid ?? data.pages?.[0]?.cid
  if (cid === undefined) {
    sendJson(res, 200, { ok: false, error: '拿不到视频的分 P 信息' })
    return
  }

  const play = await biliJson(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(data.bvid)}&cid=${cid}&fnval=16&fnver=0&fourk=1`,
  )
  if (play.code !== 0) {
    sendJson(res, 200, { ok: false, error: biliErrorText(play.code, play.message) })
    return
  }
  const audios = play.data?.dash?.audio ?? []
  if (audios.length === 0) {
    sendJson(res, 200, { ok: false, error: '这个视频没有可用的音频流（可能需要登录或付费）' })
    return
  }
  const best = audios.reduce((a, b) => (a.bandwidth >= b.bandwidth ? a : b))
  const audioUrl = best.baseUrl ?? best.base_url
  if (typeof audioUrl !== 'string' || !/^https?:\/\//i.test(audioUrl)) {
    sendJson(res, 200, { ok: false, error: '音频地址异常' })
    return
  }

  const token = Buffer.from(audioUrl, 'utf8').toString('base64url')
  sendJson(res, 200, {
    ok: true,
    track: {
      bvid: data.bvid,
      aid: data.aid,
      cid,
      title: data.title ?? '',
      owner: data.owner?.name ?? '',
      cover: httpsify(data.pic ?? ''),
      duration: Number(data.duration) || 0,
      quality: best.id ?? 0,
      pageCount: Array.isArray(data.pages) ? data.pages.length : 1,
      // v=2 busts any cached 200 response from before the range fix.
      streamUrl: `${PREFIX}/stream?u=${token}&v=2`,
    },
  })
}

const SEARCH_TTL_MS = 60_000
/** keyword|page -> { at, payload }; a small guard against double-submit bursts. */
const searchCache = new Map()

function stripTags(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

/** Search results report "分:秒" or "时:分:秒", often without zero padding. */
function parseDuration(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const text = String(value ?? '').trim()
  if (text === '') return 0
  const parts = text.split(':').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part))) return 0
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return Number.isFinite(parts[0]) ? parts[0] : 0
}

async function handleSearch(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const keyword = String(url.searchParams.get('keyword') ?? '').trim()
  if (keyword === '') {
    sendJson(res, 200, { ok: false, error: '先输入要搜的标题关键词' })
    return
  }
  const page = Math.max(1, Math.min(5, Number(url.searchParams.get('page')) || 1))
  const cacheKey = `${keyword}|${page}`
  const cached = searchCache.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < SEARCH_TTL_MS) {
    sendJson(res, 200, cached.payload)
    return
  }

  const data = await biliJson(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=${page}`,
  )
  if (data.code !== 0) {
    sendJson(res, 200, { ok: false, error: biliErrorText(data.code, data.message) })
    return
  }

  const items = (data.data?.result ?? [])
    .filter((item) => item !== null && typeof item === 'object' && typeof item.bvid === 'string')
    .map((item) => ({
      bvid: item.bvid,
      title: stripTags(item.title),
      owner: typeof item.author === 'string' ? item.author : '',
      cover: httpsify(item.pic ?? ''),
      duration: parseDuration(item.duration),
      play: Number(item.play) || 0,
    }))

  const payload = { ok: true, items, page, total: Number(data.data?.numResults) || items.length }
  searchCache.set(cacheKey, { at: Date.now(), payload })
  if (searchCache.size > 40) {
    const oldest = [...searchCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest !== undefined) searchCache.delete(oldest[0])
  }
  sendJson(res, 200, payload)
}

async function handleStream(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const token = url.searchParams.get('u')
  if (token === null || token.length === 0) {
    sendJson(res, 400, { ok: false, error: 'missing source' })
    return
  }

  let target
  try {
    target = new URL(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad source' })
    return
  }
  if (target.protocol !== 'https:' || !isAllowedHost(target.hostname)) {
    sendJson(res, 403, { ok: false, error: 'host not allowed' })
    return
  }

  const controller = new AbortController()
  const onClose = () => controller.abort()
  res.on('close', onClose)

  try {
    const headers = { 'user-agent': UA, referer: REFERER }
    const range = typeof req.headers.range === 'string' ? req.headers.range.trim() : ''
    let upstreamRange = range
    const suffix = /^bytes=-(\d+)$/.exec(range)
    if (suffix !== null) {
      // The CDN rejects suffix ranges with a 416; resolve the size and ask for
      // the equivalent absolute window instead.
      const probe = await fetch(target, {
        method: 'HEAD',
        headers: { 'user-agent': UA, referer: REFERER },
        signal: controller.signal,
      })
      const size = Number(probe.headers.get('content-length'))
      if (Number.isFinite(size) && size > 0) {
        upstreamRange = `bytes=${Math.max(0, size - Number(suffix[1]))}-`
      }
    }
    if (upstreamRange.length > 0) headers.range = upstreamRange

    const upstream = await fetch(target, { headers, signal: controller.signal })
    if (!upstream.ok && upstream.status !== 206) {
      res.writeHead(upstream.status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`B站 音频源返回 ${upstream.status}`)
      return
    }

    const length = upstream.headers.get('content-length')
    const total = length === null ? 0 : Number(length)

    // The CDN answers `Range: bytes=0-` with 200 while still advertising a
    // Content-Range. A media element reads that as "this server has no range
    // support", leaves `seekable` empty, and snaps every seek back to 0 — so we
    // promote any 200 answer to a genuine 206 ourselves.
    if (upstream.status === 200 && range.length > 0 && total > 0) {
      const wanted = parseRangeHeader(range, total)
      if (wanted === null) {
        res.writeHead(416, { 'content-range': `bytes */${total}` })
        res.end()
        return
      }
      res.writeHead(206, {
        'content-type': 'audio/mp4',
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        'content-range': `bytes ${wanted.start}-${wanted.end}/${total}`,
        'content-length': String(wanted.end - wanted.start + 1),
      })
      if (req.method === 'HEAD' || upstream.body === null) {
        res.end()
        if (upstream.body !== null) await upstream.body.cancel().catch(() => {})
        return
      }
      try {
        Readable.from(sliceBody(Readable.fromWeb(upstream.body), wanted.start, wanted.end)).pipe(res)
      } catch {
        res.destroy()
      }
      return
    }

    const outHeaders = {
      // The CDN answers with octet-stream; browsers only play a media element
      // whose response looks like audio, so present it as MP4/AAC.
      'content-type': 'audio/mp4',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    }
    if (length !== null) outHeaders['content-length'] = length
    const contentRange = upstream.headers.get('content-range')
    if (contentRange !== null) outHeaders['content-range'] = contentRange

    res.writeHead(upstream.status, outHeaders)
    if (req.method === 'HEAD' || upstream.body === null) {
      res.end()
      return
    }
    Readable.fromWeb(upstream.body).pipe(res)
  } catch (error) {
    if (controller.signal.aborted) return
    if (!res.headersSent) {
      sendJson(res, 502, { ok: false, error: `音频代理失败：${error instanceof Error ? error.message : String(error)}` })
    } else {
      res.destroy()
    }
  } finally {
    res.off('close', onClose)
  }
}

async function route(req, res, handler) {
  try {
    await handler(req, res)
  } catch (error) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const disposeResolve = ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/resolve`,
      handler: (req, res) => route(req, res, handleResolve),
    })
    const disposeSearch = ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/search`,
      handler: (req, res) => route(req, res, handleSearch),
    })
    const disposeStream = ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/stream`,
      handler: (req, res) => route(req, res, handleStream),
    })
    return () => {
      disposeResolve()
      disposeSearch()
      disposeStream()
    }
  }, 'bilibili-audio: resolve, search and stream routes')
}
