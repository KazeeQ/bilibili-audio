/**
 * Client half of the B站音频 plugin.
 *
 * The player is a plugin-level singleton, not panel state: the <audio> element
 * is created once in `apply`, so switching to the conversation keeps the music
 * playing. The main panel and the floating mini bar both subscribe to that one
 * player through `useSyncExternalStore`.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-bilibili-audio',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'bilibiliAudio'
    const PANEL_ID = 'bilibili-audio'
    const MINI_ID = 'bilibili-audio-mini'
    const API = '/bili-audio/api/'
    const TRACKS_KEY = 'dsh.bilibili-audio.tracks.v1'
    const LAST_KEY = 'dsh.bilibili-audio.last.v1'
    const VOLUME_KEY = 'dsh.bilibili-audio.volume.v1'

    const zh = {
      meta: {
        title: 'B站音频',
        description: '左侧栏里的 B站音频播放器：粘贴 BV 号或视频链接，收藏并播放 B站音频。',
      },
      panel: 'B站音频',
      title: 'B站音频',
      subtitle: '粘一个 BV 号或视频链接进来，就在这里听。切走也会继续放。',
      placeholder: 'BV1xx…、av 号或视频链接',
      submit: '添加并播放',
      submitting: '解析中…',
      favorites: '我的收藏',
      count: '首',
      emptyTitle: '还没有收藏',
      emptyBody: '粘贴一个 BV 号，比如 BV1GJ411x7h7，然后就能在这里听了。',
      nothing: '还没有选歌',
      nothingHint: '从下面点一首，或者在上面粘个链接。',
      playing: '正在播放',
      paused: '已暂停',
      loading: '加载中',
      seeking: '缓冲中…',
      play: '播放',
      pause: '暂停',
      prev: '上一首',
      next: '下一首',
      volume: '音量',
      remove: '移除',
      stop: '停止播放',
      failed: '解析失败',
      playFailed: '音频播放失败，换一首试试',
      quality: '音质',
      emptyInput: '先输入关键词或 BV 号',
      pages: '多 P 视频，先播第 1 P',
      modeBv: 'BV号',
      modeTitle: '标题',
      search: '搜索',
      searching: '搜索中…',
      placeholderTitle: '输入标题关键词，比如「周杰伦」',
      noResults: '没搜到，换个关键词试试',
      plays: '播放',
      results: '条结果',
    }

    const en = {
      meta: {
        title: 'Bilibili Audio',
        description: 'A Bilibili audio player in the sidebar: paste a BV id or video link to save and play it.',
      },
      panel: 'Bilibili Audio',
      title: 'Bilibili Audio',
      subtitle: 'Paste a BV id or a video link and keep listening — it plays while you work.',
      placeholder: 'BV1xx…, av id, or a video link',
      submit: 'Add & play',
      submitting: 'Resolving…',
      favorites: 'Saved',
      count: 'tracks',
      emptyTitle: 'Nothing saved yet',
      emptyBody: 'Paste a BV id such as BV1GJ411x7h7 to start listening here.',
      nothing: 'No track selected',
      nothingHint: 'Pick one below, or paste a link above.',
      playing: 'Playing',
      paused: 'Paused',
      loading: 'Loading',
      seeking: 'Buffering…',
      play: 'Play',
      pause: 'Pause',
      prev: 'Previous',
      next: 'Next',
      volume: 'Volume',
      remove: 'Remove',
      stop: 'Stop playback',
      failed: 'Could not resolve',
      playFailed: 'Playback failed — try another track',
      quality: 'Quality',
      emptyInput: 'Type a keyword or BV id first',
      pages: 'Multi-part video — playing part 1',
      modeBv: 'BV id',
      modeTitle: 'Title',
      search: 'Search',
      searching: 'Searching…',
      placeholderTitle: 'Search by title, e.g. "Never Gonna"',
      noResults: 'No results — try another keyword',
      plays: 'plays',
      results: 'results',
    }

    function readTracks() {
      try {
        const raw = localStorage.getItem(TRACKS_KEY)
        const value = raw === null ? [] : JSON.parse(raw)
        if (!Array.isArray(value)) return []
        return value.filter((item) => item !== null && typeof item === 'object' && typeof item.bvid === 'string')
      } catch {
        return []
      }
    }

    function writeTracks(list) {
      try {
        localStorage.setItem(TRACKS_KEY, JSON.stringify(list))
      } catch {
        /* ignore quota errors */
      }
    }

    function readLast() {
      try {
        return localStorage.getItem(LAST_KEY) ?? ''
      } catch {
        return ''
      }
    }

    function writeLast(bvid) {
      try {
        if (bvid === '') localStorage.removeItem(LAST_KEY)
        else localStorage.setItem(LAST_KEY, bvid)
      } catch {
        /* ignore */
      }
    }

    function readVolume() {
      try {
        const raw = localStorage.getItem(VOLUME_KEY)
        if (raw === null) return 0.8
        const value = Number(raw)
        if (!Number.isFinite(value)) return 0.8
        return Math.min(1, Math.max(0, value))
      } catch {
        return 0.8
      }
    }

    function writeVolume(value) {
      try {
        localStorage.setItem(VOLUME_KEY, String(value))
      } catch {
        /* ignore */
      }
    }

    function formatTime(seconds) {
      const value = Number(seconds)
      if (!Number.isFinite(value) || value < 0) return '0:00'
      const whole = Math.floor(value)
      const minutes = Math.floor(whole / 60)
      const rest = whole % 60
      return `${minutes}:${String(rest).padStart(2, '0')}`
    }

    function formatPlay(value) {
      const count = Number(value)
      if (!Number.isFinite(count) || count <= 0) return '0'
      if (count >= 100000000) return `${(count / 100000000).toFixed(1)}亿`
      if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
      return String(Math.round(count))
    }

    /**
     * The one player for the whole plugin: owns the <audio> element, the saved
     * list, and every derived playback state. Lives on the plugin's lifetime,
     * so panel navigation cannot interrupt the sound.
     */
    function createPlayer() {
      const audio = new Audio()
      audio.preload = 'auto'

      const listeners = new Set()
      let sequence = 0
      // While a seek is in flight the UI must keep showing the target time,
      // otherwise mid-seek `timeupdate` events snap the slider back.
      let pendingSeek = null
      let pendingSince = 0
      let state = {
        tracks: readTracks(),
        current: null,
        playing: false,
        time: 0,
        duration: 0,
        volume: readVolume(),
        loading: false,
        seeking: false,
        error: '',
      }

      const emit = (patch) => {
        state = { ...state, ...patch }
        for (const fn of [...listeners]) fn()
      }

      const subscribe = (fn) => {
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      }

      const getSnapshot = () => state

      function rememberTrack(track) {
        const entry = {
          bvid: track.bvid,
          title: track.title,
          owner: track.owner,
          cover: track.cover,
          duration: track.duration,
          addedAt: Date.now(),
        }
        const index = state.tracks.findIndex((item) => item.bvid === track.bvid)
        let next
        if (index >= 0) {
          next = state.tracks.slice()
          next[index] = { ...state.tracks[index], ...entry, addedAt: state.tracks[index].addedAt ?? Date.now() }
        } else {
          next = [entry, ...state.tracks]
        }
        writeTracks(next)
        emit({ tracks: next })
      }

      let objectUrl = null

      function releaseObjectUrl() {
        if (objectUrl === null) return
        try {
          URL.revokeObjectURL(objectUrl)
        } catch {
          /* ignore */
        }
        objectUrl = null
      }

      async function open(raw) {
        const value = String(raw ?? '').trim()
        if (value === '') return
        const mine = ++sequence
        emit({ loading: true, error: '' })
        try {
          const response = await fetch(`${API}resolve?raw=${encodeURIComponent(value)}`)
          const payload = await response.json()
          if (mine !== sequence) return
          if (payload === null || payload.ok !== true) {
            emit({ loading: false, error: (payload && payload.error) || '解析失败' })
            return
          }
          const track = payload.track
          rememberTrack(track)
          writeLast(track.bvid)
          pendingSeek = null
          emit({
            current: track,
            duration: Number(track.duration) || 0,
            time: 0,
            loading: true,
            seeking: false,
            error: '',
          })
          // The desktop shell serves the UI from `dsh-app://`, whose handler does
          // not honour byte ranges — a media element pointed at it reports
          // `seekable = [0,0]` and refuses every seek. Pulling the bytes through
          // fetch and handing the element a blob: URL keeps seeking local.
          const data = await fetch(track.streamUrl)
          if (mine !== sequence) return
          if (!data.ok) throw new Error(`音频下载失败 HTTP ${data.status}`)
          const buffer = await data.arrayBuffer()
          if (mine !== sequence) return
          releaseObjectUrl()
          objectUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/mp4' }))
          audio.src = objectUrl
          audio.currentTime = 0
          emit({ loading: false, time: 0, seeking: false })
          ensureAnalyser()
          const attempt = audio.play()
          if (attempt !== undefined && typeof attempt.catch === 'function') {
            attempt.catch(() => emit({ playing: false }))
          }
        } catch (cause) {
          if (mine !== sequence) return
          emit({ loading: false, error: String((cause && cause.message) || cause) })
        }
      }

      function toggle() {
        if (state.current === null) {
          if (state.tracks.length > 0) open(state.tracks[0].bvid)
          return
        }
        if (audio.paused) {
          ensureAnalyser()
          const attempt = audio.play()
          if (attempt !== undefined && typeof attempt.catch === 'function') attempt.catch(() => {})
        } else {
          audio.pause()
        }
      }

      function step(delta) {
        if (state.tracks.length === 0) return
        const activeId = state.current === null ? '' : state.current.bvid
        const index = state.tracks.findIndex((item) => item.bvid === activeId)
        const nextIndex = index < 0 ? 0 : (index + delta + state.tracks.length) % state.tracks.length
        const target = state.tracks[nextIndex]
        if (target !== undefined) open(target.bvid)
      }

      const reportSeek = (tag, extra) => {
        try {
          const ranges = []
          for (let i = 0; i < audio.seekable.length; i += 1) {
            ranges.push([Number(audio.seekable.start(i).toFixed(2)), Number(audio.seekable.end(i).toFixed(2))])
          }
          const buffered = []
          for (let i = 0; i < audio.buffered.length; i += 1) {
            buffered.push([Number(audio.buffered.start(i).toFixed(2)), Number(audio.buffered.end(i).toFixed(2))])
          }
          fetch(`${API}report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              tag,
              bvid: state.current === null ? '' : state.current.bvid,
              origin: typeof location === 'object' ? location.origin : '-',
              href: typeof location === 'object' ? String(location.href).slice(0, 120) : '-',
              src: String(audio.src).slice(0, 90),
              t: Number(audio.currentTime.toFixed(3)),
              dur: audio.duration,
              ready: audio.readyState,
              seeking: audio.seeking,
              paused: audio.paused,
              seekable: ranges,
              buffered,
              ...extra,
            }),
          }).catch(() => {})
        } catch {
          /* diagnostics must never break playback */
        }
      }

      function applySeek(target) {
        reportSeek('apply-start', { target })
        pendingSeek = target
        pendingSince = Date.now()
        emit({ time: target, seeking: true })
        try {
          audio.currentTime = target
          reportSeek('apply-set', { target })
        } catch (error) {
          reportSeek('apply-throw', { target, error: String(error) })
          pendingSeek = null
          emit({ seeking: false })
        }
      }

      function seek(seconds) {
        const value = Number(seconds)
        if (!Number.isFinite(value) || value < 0) return
        const limit = state.duration > 0 ? state.duration : value
        const target = Math.min(value, limit)
        if (audio.readyState >= 1) {
          applySeek(target)
          return
        }
        // Metadata is not in yet: a currentTime write would be ignored and the
        // slider would jump back. Hold the target and commit once it is ready.
        pendingSeek = target
        pendingSince = Date.now()
        emit({ time: target, seeking: true })
        const commit = () => {
          audio.removeEventListener('loadedmetadata', commit)
          applySeek(target)
        }
        audio.addEventListener('loadedmetadata', commit)
      }

      function setVolume(value) {
        const next = Math.max(0, Math.min(1, Number(value)))
        if (!Number.isFinite(next)) return
        audio.volume = next
        writeVolume(next)
        emit({ volume: next })
      }

      function remove(bvid) {
        const next = state.tracks.filter((item) => item.bvid !== bvid)
        writeTracks(next)
        const isCurrent = state.current !== null && state.current.bvid === bvid
        emit({ tracks: next })
        if (isCurrent) stop()
      }

      function stop() {
        sequence += 1
        cancelAutoSkip()
        pendingSeek = null
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
        releaseObjectUrl()
        writeLast('')
        emit({ current: null, playing: false, time: 0, duration: 0, seeking: false, error: '' })
      }

      let audioCtx = null
      let analyser = null
      let freqData = null
      let analyserTried = false
      let silenceSince = 0
      let lastResume = 0

      // An analyser byte covers minDecibels..maxDecibels; the rim works on a
      // narrower window so ordinary music never pins the glow at maximum.
      const ANALYSER_MIN_DB = -90
      const ANALYSER_MAX_DB = -5
      const LEVEL_FLOOR_DB = -50
      const LEVEL_CEIL_DB = -12

      /**
       * Frequency analysis for the rim. A context may only take over the element
       * once it reports "running": a suspended one would silently swallow the
       * audio. captureStream stays as a fallback and never intercepts output.
       */
      function ensureAnalyser() {
        if (analyser !== null || analyserTried) return analyser
        analyserTried = true
        const Ctx = window.AudioContext || window.webkitAudioContext
        if (typeof Ctx !== 'function') return null
        let ctx = null
        try {
          ctx = new Ctx()
        } catch {
          return null
        }
        if (ctx.state === 'running' && typeof ctx.createMediaElementSource === 'function') {
          try {
            const source = ctx.createMediaElementSource(audio)
            const node = ctx.createAnalyser()
            node.fftSize = 1024
            node.minDecibels = ANALYSER_MIN_DB
            node.maxDecibels = ANALYSER_MAX_DB
            node.smoothingTimeConstant = 0.2
            source.connect(node)
            node.connect(ctx.destination)
            audioCtx = ctx
            analyser = node
            freqData = new Uint8Array(node.frequencyBinCount)
            return analyser
          } catch {
            /* fall through to the non-invasive path */
          }
        }
        try {
          if (typeof audio.captureStream !== 'function') throw new Error('no captureStream')
          const stream = audio.captureStream()
          const tracks = stream && typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : []
          if (tracks.length === 0) throw new Error('no audio track')
          const source = ctx.createMediaStreamSource(stream)
          const node = ctx.createAnalyser()
          node.fftSize = 1024
          node.minDecibels = ANALYSER_MIN_DB
          node.maxDecibels = ANALYSER_MAX_DB
          node.smoothingTimeConstant = 0.2
          source.connect(node)
          audioCtx = ctx
          analyser = node
          freqData = new Uint8Array(node.frequencyBinCount)
          if (typeof ctx.resume === 'function') ctx.resume().catch(() => {})
        } catch {
          try {
            ctx.close()
          } catch {
            /* ignore */
          }
          audioCtx = null
          analyser = null
          freqData = null
        }
        return analyser
      }

      function simulatedEnergy(now) {
        const t = now / 1000
        const pulse = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2.1)), 8)
        return 0.12 + 0.74 * pulse
      }

      /** Analyser byte (already scaled to min/max dB) to a 0..1 working level. */
      function toLevel(byte) {
        const db = ANALYSER_MIN_DB + (byte / 255) * (ANALYSER_MAX_DB - ANALYSER_MIN_DB)
        return Math.max(0, Math.min(1, (db - LEVEL_FLOOR_DB) / (LEVEL_CEIL_DB - LEVEL_FLOOR_DB)))
      }

      /** 0..1 loudness on a fixed dB window, so quiet passages really dim out. */
      function energy() {
        const node = ensureAnalyser()
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
        if (node === null || freqData === null) return simulatedEnergy(now)

        if (audioCtx !== null && audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function' && now - lastResume > 1200) {
          lastResume = now
          audioCtx.resume().catch(() => {})
        }

        node.getByteFrequencyData(freqData)
        const size = Math.min(freqData.length, 40)
        let lowSum = 0
        let lowCount = 0
        let midSum = 0
        let midCount = 0
        for (let i = 0; i < size; i += 1) {
          const value = toLevel(freqData[i])
          if (i < 4) {
            lowSum += value
            lowCount += 1
          } else {
            midSum += value
            midCount += 1
          }
        }
        const low = lowCount === 0 ? 0 : lowSum / lowCount
        const mid = midCount === 0 ? 0 : midSum / midCount
        const level = low * 0.72 + mid * 0.28

        if (level < 0.015) {
          if (silenceSince === 0) silenceSince = now
          if (now - silenceSince > 2500) return simulatedEnergy(now)
          return 0.04
        }
        silenceSince = 0
        return Math.min(1, level)
      }

      audio.addEventListener('play', () => {
        analyserTried = false
        silenceSince = 0
        ensureAnalyser()
        if (audioCtx !== null && audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
          audioCtx.resume().catch(() => {})
        }
        emit({ playing: true })
      })
      audio.addEventListener('pause', () => emit({ playing: false }))
      audio.addEventListener('timeupdate', () => {
        const current = Number(audio.currentTime) || 0
        if (pendingSeek !== null) {
          if (Math.abs(current - pendingSeek) <= 1.5 || Date.now() - pendingSince > 12000) {
            reportSeek('lock-release', { target: pendingSeek, current })
            pendingSeek = null
            emit({ time: current, seeking: false })
            return
          }
          // Still buffering towards the requested point: hold the UI there.
          emit({ time: pendingSeek })
          return
        }
        emit({ time: current })
      })
      audio.addEventListener('seeked', () => {
        reportSeek('seeked', { target: pendingSeek })
        pendingSeek = null
        emit({ time: Number(audio.currentTime) || 0, seeking: false })
      })
      audio.addEventListener('loadedmetadata', () => {
        const total = Number(audio.duration)
        if (Number.isFinite(total) && total > 0) emit({ duration: total })
      })
      audio.addEventListener('ended', () => step(1))

      // ── 坏源自动跳过 ────────────────────────────────────────────────────
      // 服务端已经做了 3 次断点续传；如果还是拉不动（源本身坏了 / CDN 持续拒绝），
      // <audio> 会派发 error。这里自动切下一首，不用用户手动点。
      // 设上限是为了防止「整个网络都断了」时在列表里无限打转。
      const MAX_AUTO_SKIP = 3
      const AUTO_SKIP_DELAY_MS = 400
      let autoSkipCount = 0
      let autoSkipTimer = null

      function cancelAutoSkip() {
        if (autoSkipTimer !== null) {
          clearTimeout(autoSkipTimer)
          autoSkipTimer = null
        }
      }

      function scheduleAutoSkip() {
        if (state.tracks.length < 2) return
        if (autoSkipCount >= MAX_AUTO_SKIP) return
        const failedId = state.current === null ? '' : state.current.bvid
        cancelAutoSkip()
        autoSkipCount += 1
        autoSkipTimer = setTimeout(() => {
          autoSkipTimer = null
          // 这 400ms 里用户可能手动换了歌或停了播放，别抢方向盘
          if (state.current === null || state.current.bvid !== failedId) return
          step(1)
        }, AUTO_SKIP_DELAY_MS)
      }

      audio.addEventListener('playing', () => {
        // 真的出声了才算这一轮恢复，连败计数清零
        autoSkipCount = 0
        cancelAutoSkip()
      })

      audio.addEventListener('error', () => {
        if (typeof audio.src !== 'string' || audio.src.length === 0) return
        // code 1 = MEDIA_ERR_ABORTED：是我们主动换源/暂停造成的，不算失败，
        // 否则切歌时会把自己新设的 src 也当成坏源，白跳一首。
        if (audio.error !== null && audio.error.code === 1) return
        // blob: 播不了（页面策略拦 media-src blob:）就退回直连——至少还有声音。
        if (audio.src.startsWith('blob:') && state.current !== null) {
          const fallback = state.current.streamUrl
          if (typeof fallback === 'string' && fallback.length > 0) {
            reportSeek('blob-fallback', { code: audio.error === null ? 0 : audio.error.code })
            releaseObjectUrl()
            audio.src = fallback
            audio.currentTime = 0
            const attempt = audio.play()
            if (attempt !== undefined && typeof attempt.catch === 'function') attempt.catch(() => {})
            return
          }
        }
        emit({ error: 'playFailed' })
        scheduleAutoSkip()
      })
      audio.volume = state.volume

      function dispose() {
        sequence += 1
        cancelAutoSkip()
        audio.pause()
        audio.removeAttribute('src')
        try {
          audio.load()
        } catch {
          /* ignore */
        }
        releaseObjectUrl()
        listeners.clear()
      }

      const spectrumCache = []

      /**
       * Log-spaced band magnitudes (0..1), low frequencies first. This is what
       * paints the rim, so the colours actually match what is playing.
       */
      function spectrum(count) {
        const size = Math.max(1, Math.min(64, Math.round(Number(count) || 12)))
        while (spectrumCache.length < size) spectrumCache.push(0)
        const node = ensureAnalyser()
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
        if (node === null || freqData === null) {
          for (let i = 0; i < size; i += 1) {
            const target = simulatedEnergy(now + i * 137)
            spectrumCache[i] += (target - spectrumCache[i]) * 0.18
          }
          return spectrumCache
        }
        node.getByteFrequencyData(freqData)
        const maxBin = Math.min(freqData.length - 1, 360)
        const ratio = maxBin / 1
        for (let i = 0; i < size; i += 1) {
          const from = Math.max(1, Math.floor(Math.pow(ratio, i / size)))
          const to = Math.max(from, Math.min(maxBin, Math.floor(Math.pow(ratio, (i + 1) / size)) - 1))
          let top = 0
          for (let bin = from; bin <= to; bin += 1) {
            const value = toLevel(freqData[bin])
            if (value > top) top = value
          }
          const target = Math.min(1, top * 1.02)
          const previous = spectrumCache[i]
          spectrumCache[i] = previous + (target - previous) * (target > previous ? 0.78 : 0.16)
        }
        return spectrumCache
      }

      /** Console diagnostics for the RGB rim. */
      function debug() {
        let bands = 0
        if (analyser !== null && freqData !== null) {
          analyser.getByteFrequencyData(freqData)
          const size = Math.min(freqData.length, 40)
          for (let i = 0; i < size; i += 1) bands += freqData[i]
        }
        return {
          context: audioCtx === null ? 'none' : audioCtx.state,
          analyser: analyser !== null,
          bins: freqData === null ? 0 : freqData.length,
          bandSum: bands,
          energy: energy(),
        }
      }

      return { subscribe, getSnapshot, open, toggle, step, seek, setVolume, remove, stop, dispose, energy, spectrum, debug }
    }

    const CSS = `
.bili-audio-page{height:100%;min-height:100%;box-sizing:border-box;overflow-y:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}
.bili-audio-inner{box-sizing:border-box;max-width:880px;margin:0 auto;padding:28px 32px 72px;display:flex;flex-direction:column;gap:22px;}
.bili-audio-head{display:flex;flex-direction:column;gap:6px;}
.bili-audio-title{font-size:22px;font-weight:600;line-height:1.3;margin:0;}
.bili-audio-sub{font-size:13px;color:var(--dsw-alias-label-secondary);margin:0;line-height:1.5;}
.bili-audio-form{display:flex;gap:10px;}
.bili-audio-mode{display:flex;align-items:center;gap:2px;padding:3px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);flex:none;}
.bili-audio-mode-btn{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;height:32px;padding:0 10px;border-radius:7px;cursor:pointer;white-space:nowrap;font-family:inherit;}
.bili-audio-mode-btn:hover{color:var(--dsw-alias-label-primary);}
.bili-audio-mode-btn.is-on{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:500;}
.bili-audio-results{display:flex;flex-direction:column;gap:4px;max-height:372px;overflow-y:auto;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);}
.bili-audio-result{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:9px;border:none;background:transparent;color:inherit;cursor:pointer;text-align:left;width:100%;font:inherit;}
.bili-audio-result:hover{background:var(--dsw-alias-bg-layer-2);}
.bili-audio-result-cover{width:52px;height:34px;border-radius:6px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);flex:none;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);}
.bili-audio-result-cover img{width:100%;height:100%;object-fit:cover;display:block;}
.bili-audio-result-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}
.bili-audio-result-title{font-size:13px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}
.bili-audio-result-meta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bili-audio-hint{font-size:12px;color:var(--dsw-alias-label-secondary);padding:10px 8px;text-align:center;}
.bili-audio-input{flex:1;min-width:0;height:40px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 14px;font-size:14px;outline:none;transition:border-color .15s ease;}
.bili-audio-input:focus{border-color:var(--dsw-alias-brand-primary);}
.bili-audio-input::placeholder{color:var(--dsw-alias-label-secondary);}
.bili-audio-submit{height:40px;padding:0 18px;border-radius:10px;border:none;background:var(--dsw-alias-brand-primary);color:#fff;font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap;}
.bili-audio-submit:disabled{opacity:.55;cursor:default;}
.bili-audio-error{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:10px;padding:10px 14px;font-size:13px;line-height:1.5;}
.bili-audio-player{display:flex;gap:18px;padding:18px;border-radius:16px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}
.bili-audio-cover{width:132px;height:132px;flex:none;border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);}
.bili-audio-cover img{width:100%;height:100%;object-fit:cover;display:block;}
.bili-audio-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;justify-content:center;}
.bili-audio-now-title{font-size:16px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}
.bili-audio-now-sub{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bili-audio-row{display:flex;align-items:center;gap:12px;margin-top:6px;}
.bili-audio-play{width:40px;height:40px;flex:none;border-radius:50%;border:none;background:var(--dsw-alias-brand-primary);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;}
.bili-audio-play svg{display:block;}
.bili-audio-progress{flex:1;min-width:0;display:flex;align-items:center;}
.bili-audio-time{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;}
.bili-audio-vol{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);}
.bili-audio-list{display:flex;flex-direction:column;gap:10px;}
.bili-audio-list-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;}
.bili-audio-list-title{font-size:14px;font-weight:600;margin:0;}
.bili-audio-list-count{font-size:12px;color:var(--dsw-alias-label-secondary);}
.bili-audio-items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}
.bili-audio-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;border:1px solid transparent;}
.bili-audio-item:hover{background:var(--dsw-alias-bg-layer-1);}
.bili-audio-item.is-active{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);}
.bili-audio-item-main{display:flex;align-items:center;gap:10px;flex:1;min-width:0;background:none;border:none;color:inherit;cursor:pointer;padding:0;text-align:left;font:inherit;}
.bili-audio-item-cover{width:36px;height:36px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);flex:none;overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);}
.bili-audio-item-cover img{width:100%;height:100%;object-fit:cover;display:block;}
.bili-audio-item-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
.bili-audio-item-title{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bili-audio-item-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bili-audio-item-del{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:15px;line-height:1;padding:6px 8px;border-radius:6px;}
.bili-audio-item-del:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);}
.bili-audio-empty{padding:32px 20px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;border:1px dashed var(--dsw-alias-border-l1);border-radius:14px;display:flex;flex-direction:column;gap:6px;align-items:center;}
.bili-audio-empty strong{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;}
input.bili-audio-range{width:100%;height:14px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0;}
input.bili-audio-range:active,input.bili-audio-range.is-scrubbing{cursor:grabbing;}
input.bili-audio-range:disabled{cursor:default;opacity:.45;}
input.bili-audio-range-sm{width:70px;height:14px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0;}
.bili-audio-mini{position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:3px;padding:5px;border-radius:999px;background:transparent;border:none;max-width:min(420px,38vw);pointer-events:auto;color:var(--dsw-alias-label-primary);-webkit-app-region:no-drag;app-region:no-drag;animation:bili-audio-mini-in 460ms cubic-bezier(.22,.9,.24,1) both;transform-origin:center;isolation:isolate;}
.bili-audio-mini::before{content:"";position:absolute;inset:0;box-sizing:border-box;border-radius:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 1px 3px rgba(0,0,0,.10);z-index:-1;pointer-events:none;transition:background .18s ease;}
.bili-audio-mini::after{content:"";position:absolute;inset:-1px;border-radius:inherit;background:var(--bili-rim,conic-gradient(from 0deg,#ff4d6d,#ffb84d,#7dff9c,#4dd2ff,#8b5cf6,#ff5fd2,#ff4d6d));filter:blur(calc(4px + var(--bili-audio-energy,0) * 3px)) saturate(calc(1.05 + var(--bili-audio-energy,0) * 1.05));opacity:0;transform:scale(calc(1 + var(--bili-audio-energy,0) * 0.025));z-index:-2;pointer-events:none;transition:opacity .05s linear;}
.bili-audio-mini.is-playing::after{opacity:calc(0.12 + var(--bili-audio-energy,0) * 0.88);}
@keyframes bili-audio-mini-in{
  0%{opacity:0;transform:translate(-50%,0) scale(.26,.46);}
  58%{opacity:1;transform:translate(-50%,0) scale(1.06,1.09);}
  80%{transform:translate(-50%,0) scale(.982,.99);}
  100%{opacity:1;transform:translate(-50%,0) scale(1);}
}
@media (prefers-reduced-motion:reduce){.bili-audio-mini{animation:none;}.bili-audio-mini::after{animation:none;}}
.bili-audio-mini:hover::before{background:var(--dsw-alias-bg-layer-2);}
.bili-audio-mini-main{display:flex;align-items:center;gap:8px;min-width:0;background:none;border:none;color:inherit;cursor:pointer;padding:0;font:inherit;text-align:left;}
.bili-audio-mini-cover{width:26px;height:26px;border-radius:7px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);flex:none;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);}
.bili-audio-mini-cover img{width:100%;height:100%;object-fit:cover;display:block;-webkit-user-drag:none;pointer-events:none;}
.bili-audio-mini-title{font-size:12.5px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px;}
.bili-audio-mini-btn{width:24px;height:24px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;flex:none;}
.bili-audio-mini-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.bili-audio-mini-close{margin-left:3px;color:var(--dsw-alias-label-secondary);}
.bili-audio-mini-close:hover{color:var(--dsw-alias-state-error-primary);}
`

    function IconPlay({ size = 18 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M8 5.2v13.6a1 1 0 0 0 1.52.85l10.8-6.8a1 1 0 0 0 0-1.7L9.52 4.35A1 1 0 0 0 8 5.2Z', fill: 'currentColor' }),
      )
    }

    function IconPause({ size = 18 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        h('rect', { x: 6.5, y: 4.5, width: 4, height: 15, rx: 1.2, fill: 'currentColor' }),
        h('rect', { x: 13.5, y: 4.5, width: 4, height: 15, rx: 1.2, fill: 'currentColor' }),
      )
    }

    function IconNext({ size = 14 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M8.5 5.5 17 12l-8.5 6.5Z', fill: 'currentColor' }),
        h('rect', { x: 17.6, y: 5, width: 2.4, height: 14, rx: 1.2, fill: 'currentColor' }),
      )
    }

    function IconClose({ size = 13 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 2.2,
          'stroke-linecap': 'round',
        }),
      )
    }

    function IconVolume({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M4 9.5h3.2L12 5.4v13.2L7.2 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M15.4 8.6a5 5 0 0 1 0 6.8M17.9 6a8.4 8.4 0 0 1 0 12',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.8,
          'stroke-linecap': 'round',
        }),
      )
    }

    function IconNote({ size = 22 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M9.5 17.2V7.1l8.2-2.1v9.4',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.8,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
        h('circle', { cx: 7.2, cy: 17.4, r: 2.4, fill: 'currentColor' }),
        h('circle', { cx: 15.4, cy: 15.4, r: 2.4, fill: 'currentColor' }),
      )
    }

    /** The sidebar glyph: the Bilibili pink tile with a play triangle. */
    function SidebarIcon({ size }) {
      const edge = Number(size) > 0 ? Number(size) : 20
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 24 24',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('rect', { x: 1.5, y: 1.5, width: 21, height: 21, rx: 7, fill: '#FB7299' }),
        h('path', {
          d: 'M10.1 7.9v8.2a.9.9 0 0 0 1.38.76l6-4.1a.9.9 0 0 0 0-1.52l-6-4.1a.9.9 0 0 0-1.38.76Z',
          fill: '#fff',
        }),
      )
    }

    function Cover({ src, title, size }) {
      const [broken, setBroken] = React.useState(false)
      const style = size === undefined ? undefined : { width: size, height: size }
      if (typeof src !== 'string' || src.length === 0 || broken) {
        return h('div', { className: 'bili-audio-cover', style }, h(IconNote, { size: 28 }))
      }
      return h(
        'div',
        { className: 'bili-audio-cover', style },
        h('img', { src, alt: title, loading: 'lazy', onError: () => setBroken(true) }),
      )
    }

    /** Keep a render failure inside the panel instead of blanking the main column. */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error !== null) {
          const text = String((this.state.error && this.state.error.message) || this.state.error)
          return h(
            'div',
            { className: 'bili-audio-page' },
            h('style', null, CSS),
            h(
              'div',
              { className: 'bili-audio-inner' },
              h('div', { className: 'bili-audio-error', role: 'alert' }, `B站音频面板出错了：${text}`),
            ),
          )
        }
        return this.props.children
      }
    }

    /** `useSyncExternalStore` when the host React has it, a subscription fallback otherwise. */
    const useSyncStore =
      typeof React.useSyncExternalStore === 'function'
        ? (subscribe, getSnapshot) => React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
        : (subscribe, getSnapshot) => {
            const [, force] = React.useState(0)
            React.useEffect(() => subscribe(() => force((count) => count + 1)), [subscribe])
            return getSnapshot()
          }

    function usePlayer(player) {
      return useSyncStore(player.subscribe, player.getSnapshot)
    }

    /**
     * RGB rim: hue sweep speed and glow strength follow the live audio energy,
     * and the whole effect goes dark while the app sits in the background.
     */
    function useRgbRim(player, playing) {
      const ref = React.useRef(null)
      const [background, setBackground] = React.useState(false)

      React.useEffect(() => {
        const visible = () => setBackground(document.hidden === true)
        const leave = () => setBackground(true)
        visible()
        document.addEventListener('visibilitychange', visible)
        window.addEventListener('blur', leave)
        window.addEventListener('focus', visible)
        return () => {
          document.removeEventListener('visibilitychange', visible)
          window.removeEventListener('blur', leave)
          window.removeEventListener('focus', visible)
        }
      }, [])

      const active = playing === true && background === false

      React.useEffect(() => {
        const el = ref.current
        if (el === null) return undefined
        if (!active || !player || typeof player.energy !== 'function') {
          el.style.setProperty('--bili-audio-energy', '0')
          return undefined
        }
        let raf = 0
        let last = performance.now()
        let lastRim = 0
        let angle = 0
        let smooth = 0
        const tick = (now) => {
          const dt = Math.min(0.064, Math.max(0.001, (now - last) / 1000))
          last = now
          let next = 0
          let bands = null
          try {
            bands = player.spectrum(12)
          } catch {
            bands = null
          }
          try {
            next = player.energy()
          } catch {
            next = 0
          }
          smooth += (next - smooth) * (next > smooth ? 1 - Math.exp(-dt * 60) : 1 - Math.exp(-dt * 12))
          angle = (angle + (38 + smooth * 380) * dt) % 360
          if (bands !== null && bands.length > 0 && now - lastRim > 15) {
            lastRim = now
            let rim = 'conic-gradient(from ' + angle.toFixed(1) + 'deg'
            for (let i = 0; i < bands.length; i += 1) {
              const value = bands[i]
              const hue = Math.round((i / bands.length) * 360)
              const light = Math.round(34 + value * 26)
              const sat = Math.round(76 + value * 18)
              rim += ',hsl(' + hue + ' ' + sat + '% ' + light + '%)'
            }
            rim += ')'
            el.style.setProperty('--bili-rim', rim)
          }
          el.style.setProperty('--bili-audio-energy', smooth.toFixed(3))
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return () => {
          cancelAnimationFrame(raf)
          el.style.setProperty('--bili-audio-energy', '0')
        }
      }, [active, player])

      return { ref, active }
    }

    /** Media bar merged into the title row: fixed at the top centre, no chrome of its own. */
    function MiniPlayer(props) {
      const { t, player, openPanel } = props
      if (!player) return null
      const state = usePlayer(player)
      const rim = useRgbRim(player, state.playing)
      if (state.current === null) return null
      const track = state.current

      return h(
        'div',
        { className: rim.active ? 'bili-audio-mini is-playing' : 'bili-audio-mini', ref: rim.ref },
        h('style', null, CSS),
        h(
          'button',
          { type: 'button', className: 'bili-audio-mini-main', onClick: openPanel, title: t('panel') },
          h(
            'div',
            { className: 'bili-audio-mini-cover' },
            typeof track.cover === 'string' && track.cover.length > 0
              ? h('img', { src: track.cover, alt: '' })
              : h(IconNote, { size: 14 }),
          ),
          h('span', { className: 'bili-audio-mini-title' }, track.title || track.bvid),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'bili-audio-mini-btn',
            onClick: player.toggle,
            title: state.playing ? t('pause') : t('play'),
            'aria-label': state.playing ? t('pause') : t('play'),
          },
          state.playing ? h(IconPause, { size: 14 }) : h(IconPlay, { size: 14 }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'bili-audio-mini-btn',
            onClick: () => player.step(1),
            title: t('next'),
            'aria-label': t('next'),
          },
          h(IconNext, { size: 13 }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'bili-audio-mini-btn bili-audio-mini-close',
            onClick: player.stop,
            title: t('stop'),
            'aria-label': t('stop'),
          },
          h(IconClose, { size: 13 }),
        ),
      )
    }

    function PlayerPanel(props) {
      return h(PanelBoundary, null, h(PlayerPanelBody, props))
    }

    function PlayerPanelBody(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const player = props.player
      const state = usePlayer(player)
      const { tracks, current, playing, time, loading, volume } = state

      const [input, setInput] = React.useState('')
      const [mode, setMode] = React.useState('bv')
      const [results, setResults] = React.useState(null)
      const [searching, setSearching] = React.useState(false)
      const [localError, setLocalError] = React.useState('')

      const error = localError.length > 0 ? localError : state.error === 'playFailed' ? t('playFailed') : state.error

      async function search(keyword) {
        setSearching(true)
        setLocalError('')
        try {
          const response = await fetch(`${API}search?keyword=${encodeURIComponent(keyword)}`)
          const payload = await response.json()
          if (payload === null || payload.ok !== true) {
            setResults(null)
            setLocalError((payload && payload.error) || t('failed'))
            return
          }
          setResults(Array.isArray(payload.items) ? payload.items : [])
        } catch (cause) {
          setResults(null)
          setLocalError(String((cause && cause.message) || cause))
        } finally {
          setSearching(false)
        }
      }

      function switchMode(next) {
        if (next === mode) return
        setMode(next)
        setResults(null)
        setLocalError('')
      }

      function submit(event) {
        event.preventDefault()
        const value = input.trim()
        if (value === '') {
          setLocalError(t('emptyInput'))
          return
        }
        setInput('')
        if (mode === 'title') {
          search(value)
          return
        }
        player.open(value)
      }

      function openTrack(bvid) {
        player.open(bvid)
      }

      const duration = current !== null && Number(current.duration) > 0 ? Number(current.duration) : 0
      const currentId = current === null ? '' : current.bvid

      // Scrubbing. The slider is deliberately *uncontrolled*: the browser owns
      // its value while the thumb is held, so no React re-render (timeupdate,
      // seek state, buffering) can snap it back. We only write the value from
      // an effect once the drag is over.
      const progressRef = React.useRef(null)
      const draggingRef = React.useRef(false)
      const draftRef = React.useRef(0)
      const [draftTime, setDraftTime] = React.useState(null)

      const shownTime = draftTime !== null ? draftTime : time

      function beginScrub() {
        const el = progressRef.current
        draggingRef.current = true
        draftRef.current = el === null ? 0 : Number(el.value) || 0
        setDraftTime(draftRef.current)
      }

      function moveScrub(event) {
        const next = Number(event.target.value)
        if (!Number.isFinite(next)) return
        if (draggingRef.current) {
          draftRef.current = next
          setDraftTime(next)
        } else {
          // Keyboard arrows / a plain click on the track: no drag in progress.
          player.seek(next)
        }
      }

      function endScrub() {
        if (!draggingRef.current) return
        draggingRef.current = false
        const target = draftRef.current
        setDraftTime(null)
        if (Number.isFinite(target)) player.seek(target)
      }

      // Keep the native slider in sync with playback, but never while dragging.
      React.useEffect(() => {
        const el = progressRef.current
        if (el === null || draggingRef.current) return
        const value = Math.min(Number(time) || 0, duration)
        if (Math.abs(Number(el.value) - value) > 0.5) el.value = String(value)
      }, [time, duration])

      React.useEffect(() => {
        if (draftTime === null) return undefined
        const release = () => endScrub()
        window.addEventListener('pointerup', release)
        window.addEventListener('pointercancel', release)
        return () => {
          window.removeEventListener('pointerup', release)
          window.removeEventListener('pointercancel', release)
        }
      }, [draftTime])

      const status = loading
        ? t('loading')
        : state.seeking
          ? t('seeking')
          : playing
            ? t('playing')
            : current === null
              ? ''
              : t('paused')

      const nowTitle = current === null ? t('nothing') : current.title || current.bvid
      const nowSub =
        current === null
          ? t('nothingHint')
          : [current.owner, current.pageCount > 1 ? t('pages') : ''].filter((part) => part && part.length > 0).join(' · ')

      const playerCard =
        current === null
          ? h(
              'section',
              { className: 'bili-audio-empty' },
              h('strong', null, t('nothing')),
              h('span', null, t('nothingHint')),
            )
          : h(
              'section',
              { className: 'bili-audio-player' },
              h(Cover, { src: current.cover, title: current.title }),
              h(
                'div',
                { className: 'bili-audio-main' },
                h('div', { className: 'bili-audio-now-title' }, nowTitle),
                h('div', { className: 'bili-audio-now-sub' }, nowSub),
                h(
                  'div',
                  { className: 'bili-audio-row' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'bili-audio-play',
                      onClick: player.toggle,
                      title: playing ? t('pause') : t('play'),
                      'aria-label': playing ? t('pause') : t('play'),
                    },
                    playing ? h(IconPause) : h(IconPlay),
                  ),
                  h(
                    'div',
                    { className: 'bili-audio-progress' },
                    h('input', {
                      type: 'range',
                      ref: progressRef,
                      className: draftTime !== null ? 'bili-audio-range is-scrubbing' : 'bili-audio-range',
                      min: 0,
                      max: duration,
                      step: 0.1,
                      defaultValue: 0,
                      disabled: duration <= 0,
                      onPointerDown: beginScrub,
                      onInput: moveScrub,
                      onPointerUp: endScrub,
                      onPointerCancel: endScrub,
                      onBlur: endScrub,
                      'aria-label': t('play'),
                    }),
                  ),
                  h('span', { className: 'bili-audio-time' }, `${formatTime(shownTime)} / ${formatTime(duration)}`),
                  h(
                    'div',
                    { className: 'bili-audio-vol' },
                    h(IconVolume),
                    h('input', {
                      type: 'range',
                      className: 'bili-audio-range-sm',
                      min: 0,
                      max: 1,
                      step: 0.01,
                      value: volume,
                      onChange: (event) => player.setVolume(Number(event.target.value)),
                      'aria-label': t('volume'),
                    }),
                  ),
                ),
                status.length > 0 ? h('div', { className: 'bili-audio-now-sub' }, status) : null,
              ),
            )

      const list =
        tracks.length === 0
          ? h(
              'section',
              { className: 'bili-audio-empty' },
              h('strong', null, t('emptyTitle')),
              h('span', null, t('emptyBody')),
            )
          : h(
              'ul',
              { className: 'bili-audio-items' },
              tracks.map((track) =>
                h(
                  'li',
                  {
                    key: track.bvid,
                    className: `bili-audio-item${track.bvid === currentId ? ' is-active' : ''}`,
                  },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'bili-audio-item-main',
                      onClick: () => openTrack(track.bvid),
                      title: track.title || track.bvid,
                    },
                    h(
                      'div',
                      { className: 'bili-audio-item-cover' },
                      typeof track.cover === 'string' && track.cover.length > 0
                        ? h('img', { src: track.cover, alt: '', loading: 'lazy' })
                        : h(IconNote, { size: 16 }),
                    ),
                    h(
                      'div',
                      { className: 'bili-audio-item-body' },
                      h('span', { className: 'bili-audio-item-title' }, track.title || track.bvid),
                      h(
                        'span',
                        { className: 'bili-audio-item-sub' },
                        [track.bvid, track.owner, formatTime(track.duration)].filter((part) => part && part.length > 0).join(' · '),
                      ),
                    ),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'bili-audio-item-del',
                      title: t('remove'),
                      'aria-label': t('remove'),
                      onClick: () => player.remove(track.bvid),
                    },
                    '×',
                  ),
                ),
              ),
            )

      return h(
        'div',
        { className: 'bili-audio-page' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'bili-audio-inner' },
          h(
            'header',
            { className: 'bili-audio-head', 'data-window-drag': true },
            h('h1', { className: 'bili-audio-title' }, t('title')),
            h('p', { className: 'bili-audio-sub' }, t('subtitle')),
          ),
          h(
            'form',
            { className: 'bili-audio-form', onSubmit: submit },
            h(
              'div',
              { className: 'bili-audio-mode', role: 'group' },
              h(
                'button',
                {
                  type: 'button',
                  className: `bili-audio-mode-btn${mode === 'bv' ? ' is-on' : ''}`,
                  onClick: () => switchMode('bv'),
                  'aria-pressed': mode === 'bv',
                  title: t('modeBv'),
                },
                t('modeBv'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: `bili-audio-mode-btn${mode === 'title' ? ' is-on' : ''}`,
                  onClick: () => switchMode('title'),
                  'aria-pressed': mode === 'title',
                  title: t('modeTitle'),
                },
                t('modeTitle'),
              ),
            ),
            h('input', {
              className: 'bili-audio-input',
              value: input,
              onChange: (event) => setInput(event.target.value),
              placeholder: mode === 'title' ? t('placeholderTitle') : t('placeholder'),
              'aria-label': mode === 'title' ? t('placeholderTitle') : t('placeholder'),
              autoComplete: 'off',
              spellCheck: false,
            }),
            h(
              'button',
              { type: 'submit', className: 'bili-audio-submit', disabled: loading || searching },
              mode === 'title'
                ? searching
                  ? t('searching')
                  : t('search')
                : loading
                  ? t('submitting')
                  : t('submit'),
            ),
          ),
          error.length > 0 ? h('div', { className: 'bili-audio-error', role: 'alert' }, error) : null,
          results === null
            ? null
            : h(
                'section',
                { className: 'bili-audio-results', 'aria-label': t('search') },
                results.length === 0
                  ? h('div', { className: 'bili-audio-hint' }, t('noResults'))
                  : results.map((item) =>
                      h(
                        'button',
                        {
                          key: item.bvid,
                          type: 'button',
                          className: 'bili-audio-result',
                          onClick: () => openTrack(item.bvid),
                          title: item.title,
                        },
                        h(
                          'div',
                          { className: 'bili-audio-result-cover' },
                          typeof item.cover === 'string' && item.cover.length > 0
                            ? h('img', { src: item.cover, alt: '', loading: 'lazy' })
                            : h(IconNote, { size: 16 }),
                        ),
                        h(
                          'div',
                          { className: 'bili-audio-result-body' },
                          h('span', { className: 'bili-audio-result-title' }, item.title || item.bvid),
                          h(
                            'span',
                            { className: 'bili-audio-result-meta' },
                            [
                              item.owner,
                              item.duration > 0 ? formatTime(item.duration) : '',
                              item.play > 0 ? `${formatPlay(item.play)} ${t('plays')}` : '',
                            ]
                              .filter((part) => typeof part === 'string' && part.length > 0)
                              .join(' · '),
                          ),
                        ),
                      ),
                    ),
              ),
          playerCard,
          h(
            'section',
            { className: 'bili-audio-list' },
            h(
              'div',
              { className: 'bili-audio-list-head' },
              h('h2', { className: 'bili-audio-list-title' }, t('favorites')),
              h('span', { className: 'bili-audio-list-count' }, `${tracks.length} ${t('count')}`),
            ),
            list,
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'bilibili-audio: dictionaries')
        const t = ctx.locale.bind(NS)

        const player = createPlayer()
        try {
          window.__biliAudioPlayer = player
        } catch {
          /* not a browser context */
        }
        ctx.effect(
          () => () => {
            try {
              if (window.__biliAudioPlayer === player) delete window.__biliAudioPlayer
            } catch {
              /* ignore */
            }
            player.dispose()
          },
          'bilibili-audio: player lifetime',
        )

        const openPanel = () => {
          try {
            ctx.layout.selectPanel(PANEL_ID)
          } catch {
            /* layout unavailable */
          }
        }

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 50,
              label: () => t('panel'),
              locale: NS,
            },
            SidebarIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              inject: () => ({ player }),
            },
            PlayerPanel,
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: MINI_ID,
              order: 60,
              locale: NS,
              inject: () => ({ player, openPanel }),
            },
            MiniPlayer,
          ),
        )
      },
    }
  },
})
