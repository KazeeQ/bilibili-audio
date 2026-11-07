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
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const inject = ['webServer']

const PREFIX = '/bili-audio/api'
const REPORT_FILE = join(tmpdir(), 'bili-audio-seek.log')
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
      // v=2 busts any cached 200 response from before the range fix. Kept
      // relative: the client fetches these bytes and plays them from a blob: URL.
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

// ── 断流续传 ─────────────────────────────────────────────────────────────
// B 站的音频 CDN 会莫名其妙地在传输中途断开（长连接回收 / Range 被拒 / 风控）。
// 浏览器那边只会看到「播放停了」，而 host 进程这边如果没人处理流错误，就是
// uncaughtException → 整个应用退出。所以这里做两件事：
//   1) 接住流错误（不再升级为进程级异常）
//   2) 用 Range 从断点续传，播放器无感
const MAX_STREAM_RETRIES = 3
const STREAM_RETRY_BASE_DELAY_MS = 250

function contentRangeStart(header) {
  if (typeof header !== 'string') return null
  const match = /^bytes\s+(\d+)-/i.exec(header.trim())
  return match === null ? null : Number(match[1])
}

// 写入一块数据；返回 false 表示对端已断开，没必要再拉了。
function writeChunk(res, chunk) {
  return new Promise((resolve) => {
    if (res.destroyed || res.writableEnded) {
      resolve(false)
      return
    }
    if (res.write(chunk)) {
      resolve(true)
      return
    }
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve(!res.destroyed && !res.writableEnded)
    }
    res.on('drain', done)
    res.on('close', done)
  })
}

async function pumpBody(upstream, res, progress) {
  if (upstream.body === null || upstream.body === undefined) return
  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value === undefined || value.byteLength === 0) continue
      progress.bytes += value.byteLength
      const alive = await writeChunk(res, Buffer.from(value.buffer, value.byteOffset, value.byteLength))
      if (!alive) return
    }
  } finally {
    try {
      await reader.cancel()
    } catch {}
  }
}

/**
 * 把上游 body 搬到 res 上；中途断流就从断点用 Range 续传。
 * 返回 true 表示 body 已经完整写完，调用方负责 res.end()。
 */
async function pumpWithRetry({ first, target, reqHeaders, res, signal, startOffset }) {
  let upstream = first
  let offset = startOffset
  let attempt = 0
  const progress = { bytes: 0 }

  for (;;) {
    try {
      await pumpBody(upstream, res, progress)
      return true
    } catch (error) {
      if (signal.aborted || res.destroyed || res.writableEnded) return false
      if (attempt >= MAX_STREAM_RETRIES) throw error
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, STREAM_RETRY_BASE_DELAY_MS * attempt))
      if (signal.aborted || res.destroyed || res.writableEnded) return false

      const resumeFrom = offset + progress.bytes
      const retried = await fetch(target, {
        headers: { ...reqHeaders, range: `bytes=${resumeFrom}-` },
        signal,
      })
      const resumedAt = contentRangeStart(retried.headers.get('content-range'))
      if (retried.status !== 206 || resumedAt !== resumeFrom) {
        // 服务端没按 Range 续传（或起点对不上），继续写会错位，放弃这轮播放，
        // 让播放器自己重新发请求，比写出一段坏音频强。
        await retried.body?.cancel().catch(() => {})
        return false
      }
      offset = resumedAt
      progress.bytes = 0
      upstream = retried
    }
  }
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

  const trace = (message) => {
    appendFile(REPORT_FILE, `${new Date().toISOString()} stream ${message}\n`).catch(() => {})
  }

  try {
    const headers = { 'user-agent': UA, referer: REFERER }
    const range = typeof req.headers.range === 'string' ? req.headers.range.trim() : ''
    trace(`req method=${req.method} host=${req.headers.host || '-'} range=${range || '-'} ua=${(req.headers['user-agent'] || '-').slice(0, 40)}`)
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
    trace(
      `upstream status=${upstream.status} length=${length} cr=${upstream.headers.get('content-range') || '-'} ar=${upstream.headers.get('accept-ranges') || '-'} ct=${upstream.headers.get('content-type') || '-'}`,
    )

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
      trace(`out 206(sliced) ${wanted.start}-${wanted.end}/${total} cl=${wanted.end - wanted.start + 1}`)
      if (req.method === 'HEAD' || upstream.body === null) {
        res.end()
        if (upstream.body !== null) await upstream.body.cancel().catch(() => {})
        return
      }
      try {
        const sliced = Readable.from(sliceBody(Readable.fromWeb(upstream.body), wanted.start, wanted.end))
        // 流被 CDN 半路掐断时只会抛异步 'error' 事件，外层 try/catch 接不住；
        // 不挂 handler 就会升级成 uncaughtException，直接带走整个 host 进程。
        sliced.on('error', () => res.destroy())
        sliced.pipe(res)
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
    trace(`out ${upstream.status} cl=${outHeaders['content-length'] || '-'} cr=${outHeaders['content-range'] || '-'}`)
    if (req.method === 'HEAD' || upstream.body === null) {
      res.end()
      return
    }
    const completed = await pumpWithRetry({
      first: upstream,
      target,
      reqHeaders: headers,
      res,
      signal: controller.signal,
      startOffset: contentRangeStart(upstream.headers.get('content-range')) ?? 0,
    })
    if (completed) {
      res.end()
    } else {
      res.destroy()
    }
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

const SELFTEST_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>B站音频 seek 自检</title>
<style>
body{font:13px/1.7 ui-monospace,Consolas,monospace;padding:18px;background:#101114;color:#d6d8e0}
h3{margin:0 0 10px}
pre{white-space:pre-wrap;background:#181a20;border:1px solid #2b2f3a;border-radius:8px;padding:12px;min-height:240px}
button{padding:7px 14px;margin:0 6px 10px 0;border-radius:7px;border:1px solid #3a4050;background:#232733;color:#e6e8f0;cursor:pointer}
audio{display:block;margin:10px 0;width:100%}
</style></head><body>
<h3>B站音频 seek 自检</h3>
<p>先点播放，听几秒，再点下面两个 seek 按钮，然后把整段输出发给我。</p>
<audio id="a" controls preload="auto"></audio>
<button id="seek50">seek 到 50%</button>
<button id="seek10">seek 到第 10 秒</button>
<button id="reset">清空输出</button>
<pre id="out"></pre>
<script>
var out = document.getElementById('out')
var a = document.getElementById('a')
function log(m) { out.textContent += m + String.fromCharCode(10) }
function state() {
  var sk = a.seekable
  var bf = a.buffered
  return 't=' + a.currentTime.toFixed(2) + ' dur=' + a.duration + ' ready=' + a.readyState +
    ' seekable=' + sk.length + (sk.length ? '[' + sk.start(0) + ',' + sk.end(0) + ']' : '') +
    ' buffered=' + (bf.length ? '[' + bf.start(bf.length - 1) + ',' + bf.end(bf.length - 1) + ']' : 'none')
}
;['loadedmetadata','canplay','seeking','seeked','waiting','playing','pause','error','stalled'].forEach(function (name) {
  a.addEventListener(name, function () {
    if (name === 'stalled') return
    if (name === 'error') log('[error] code=' + (a.error && a.error.code) + ' msg=' + (a.error && a.error.message))
    else log('[' + name + '] ' + state())
  })
})
fetch('/bili-audio/api/search?keyword=' + encodeURIComponent('晴天 周杰伦')).then(function (r) { return r.json() }).then(function (s) {
  var bvid = s.items && s.items[0] ? s.items[0].bvid : ''
  log('search bvid=' + bvid)
  return fetch('/bili-audio/api/resolve?raw=' + bvid).then(function (r) { return r.json() })
}).then(function (r) {
  log('resolve ok=' + r.ok + ' title=' + (r.track && r.track.title))
  log('streamUrl=' + (r.track && r.track.streamUrl))
  a.src = r.track.streamUrl
}).catch(function (e) { log('fail ' + e) })
function seekTo(t) {
  log('--- click seek -> ' + t + '  ' + state())
  a.currentTime = t
  log('    set currentTime, immediately ' + state())
  setTimeout(function () { log('    +1s ' + state()) }, 1000)
  setTimeout(function () { log('    +3s ' + state()) }, 3000)
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
async function autoTest() {
  for (var i = 0; i < 120 && a.readyState < 1; i++) await wait(250)
  log('A meta: ' + state())
  try { await a.play(); log('B play ok') } catch (e) { log('B play FAIL ' + e) }
  await wait(2500)
  log('C after 2.5s: ' + state())
  a.currentTime = 60
  log('D seek->60 set: ' + state())
  await wait(1200)
  log('E +1.2s: ' + state())
  await wait(2000)
  log('F +3.2s: ' + state())
  var stream = a.captureStream()
  log('G captureStream tracks=' + stream.getAudioTracks().length)
  await wait(700)
  log('H after capture: ' + state())
  a.currentTime = 120
  log('I seek->120 set: ' + state())
  await wait(1200)
  log('J +1.2s: ' + state())
  await wait(2000)
  log('K +3.2s: ' + state())
  a.pause()
  log('DONE')
}
if (location.search.indexOf('auto=1') >= 0) {
  autoTest().catch(function (e) { log('AUTO FAIL ' + e) })
}
document.getElementById('seek50').addEventListener('click', function () { seekTo(Math.floor(a.duration / 2) || 30) })
document.getElementById('seek10').addEventListener('click', function () { seekTo(10) })
document.getElementById('reset').addEventListener('click', function () { out.textContent = '' })
</script></body></html>`

/**
 * The desktop shell serves the UI from `dsh-app://app/`, so a relative media URL
 * would be resolved against that custom scheme — where byte ranges are not
 * honoured and the element reports `seekable = [0,0]`. Media must therefore be
 * pointed at the real HTTP listener (whose Host header the shell forwards).
 */
function publicBase(req) {
  const candidates = [req.headers['x-forwarded-host'], req.headers.host]
  for (const value of candidates) {
    if (typeof value === 'string' && /^[A-Za-z0-9.\-]+:\d+$/.test(value.trim())) {
      return `http://${value.trim()}`
    }
  }
  return ''
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

/** Diagnostic sink: the client posts seek traces here so they can be inspected on disk. */
async function handleReport(req, res) {
  let body = ''
  try {
    for await (const chunk of req) body += chunk
    await appendFile(REPORT_FILE, `${new Date().toISOString()} ${body.slice(0, 4000)}\n`)
  } catch {
    /* diagnostics must never break playback */
  }
  sendJson(res, 200, { ok: true })
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
    const disposeSelftest = ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/selftest`,
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(SELFTEST_HTML)
      },
    })
    const disposeReport = ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/report`,
      handler: (req, res) => route(req, res, handleReport),
    })
    return () => {
      disposeResolve()
      disposeSearch()
      disposeStream()
      disposeSelftest()
      disposeReport()
    }
  }, 'bilibili-audio: resolve, search and stream routes')
}
