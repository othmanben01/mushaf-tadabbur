/* ============================================================================
 * مصحف التدبر — Audio Engine (v4)
 * ----------------------------------------------------------------------------
 * Clean, resilient verse-by-verse recitation engine designed for mobile PWAs
 * (iOS Safari, Android Chrome, Desktop):
 *
 *  1. Screen-off / Lock-screen reliability:
 *     - Reuses the single active <audio> element when document.hidden is true
 *       (iOS/Android block switching to a second <audio> element in background).
 *     - Implements inter-verse gaps using a real generated silent WAV played on
 *       the SAME <audio> element instead of pause() + setTimeout() so the OS
 *       never suspends the audio session between verses.
 *     - Relies on native `timeupdate` and `ended` events (never killed by
 *       background timer throttling) plus a monotonic playId guard.
 *
 *  2. Zero random stops at the end of a verse:
 *     - Automatic fallback from spare <audio> -> primary <audio> if .play()
 *       rejects (e.g. NotAllowedError / AbortError).
 *     - Resilient fetch & playback retries (blob -> /audio/ proxy -> direct
 *       EveryAyah URL) without permanently disabling proxy on transient drops.
 *     - Stall watchdog recovers hung mobile streams automatically.
 *     - Sequential, memory-bounded silence trimming (skipped while hidden to
 *       avoid iOS background memory pressure).
 * ============================================================================ */

(function (global) {
  "use strict";

  const RECITERS = [
    { id: "ghamdi",     name: "سعد الغامدي",             dir: "Ghamadi_40kbps" },
    { id: "muaiqly",    name: "ماهر المعيقلي",           dir: "MaherAlMuaiqly128kbps" },
    { id: "abdulbasit", name: "عبد الباسط عبد الصمد",    dir: "Abdul_Basit_Murattal_192kbps" },
    { id: "husary",     name: "محمود خليل الحصري",       dir: "Husary_128kbps" },
    { id: "dossari",    name: "ياسر الدوسري",            dir: "Yasser_Ad-Dussary_128kbps" },
    { id: "minshawi",   name: "محمد صديق المنشاوي",      dir: "Minshawy_Murattal_128kbps" },
    { id: "shuraim",    name: "سعود الشريم",             dir: "Saood_ash-Shuraym_128kbps" },
    { id: "shatri",     name: "أبو بكر الشاطري",         dir: "Abu_Bakr_Ash-Shaatree_128kbps" },
    { id: "rifai",      name: "هاني الرفاعي",            dir: "Hani_Rifai_192kbps" },
    { id: "tablawi",    name: "محمد محمود الطبلاوي",     dir: "Mohammad_al_Tablaway_128kbps" },
    { id: "qatami",     name: "ناصر القطامي",            dir: "Nasser_Alqatami_128kbps" },
    { id: "fares",      name: "فارس عباد",               dir: "Fares_Abbad_64kbps" },
    { id: "ajamy",      name: "أحمد العجمي",             dir: "ahmed_ibn_ali_al_ajamy_128kbps" },
    { id: "matroud",    name: "عبد الله المطرود",        dir: "Abdullah_Matroud_128kbps" },
    { id: "juhany",     name: "عبد الله عواد الجهني",    dir: "Abdullaah_3awwaad_Al-Juhaynee_128kbps" },
    { id: "salamah",    name: "ياسر سلامة",              dir: "Yaser_Salamah_128kbps" },
    { id: "alijaber",   name: "علي جابر",                dir: "Ali_Jaber_64kbps" },
    { id: "hudhaify",   name: "علي الحذيفي",             dir: "Hudhaify_128kbps" },
    { id: "ayyoub",     name: "محمد أيوب",               dir: "Muhammad_Ayyoub_128kbps" },
    { id: "bukhatir",   name: "صلاح بوخاطر",             dir: "Salaah_AbdulRahman_Bukhatir_128kbps" }
  ];

  const GAPS = [0, 0.3, 0.6, 1, 2];

  const CONFIG = {
    KEEP_IN: 0.04,          // 40 ms kept before voice starts (never clips first letter)
    KEEP_OUT: 0.025,        // 25 ms kept after voice ends
    PREFETCH_AHEAD: 6,      // Verses prefetched ahead into RAM
    MAX_RAW_CACHE: 10,      // Max raw MP3 ArrayBuffers kept in memory
    MAX_TRIM_CACHE: 6,      // Max decoded/trimmed WAV blobs kept in memory
    FETCH_TIMEOUT_MS: 12000,// Per-request network timeout
    STALL_TIMEOUT_MS: 10000,// Reload current verse if stalled this long while playing
    WATCH_INTERVAL_MS: 45,  // Foreground tight handoff polling interval
    MAX_PLAY_RETRIES: 2     // Retries before reporting an error
  };

  const TINY_SILENT_WAV =
    "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

  /* --------------------------------------------------------------------------
   * PCM / WAV Helpers & Silence Bounds Detection
   * ------------------------------------------------------------------------ */

  function pad3(x) {
    return String(x).padStart(3, "0");
  }

  function createWavBlob(samples, sampleRate, from, to) {
    const n = Math.max(1, to - from);
    const buf = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buf);
    const writeStr = (off, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + n * 2, true);
    writeStr(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const x = Math.max(-1, Math.min(1, samples[from + i]));
      view.setInt16(44 + i * 2, x < 0 ? x * 32768 : x * 32767, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  const silenceGapUrls = new Map();
  /** Generates & caches a real silent PCM WAV of `seconds` duration (keeps OS audio alive during gaps). */
  function getSilenceGapUrl(seconds) {
    const key = Number(seconds).toFixed(2);
    if (silenceGapUrls.has(key)) return silenceGapUrls.get(key);
    const sampleRate = 8000;
    const count = Math.max(800, Math.round(sampleRate * seconds));
    const zeros = new Float32Array(count);
    const url = URL.createObjectURL(createWavBlob(zeros, sampleRate, 0, count));
    silenceGapUrls.set(key, url);
    return url;
  }

  /**
   * Detects where the reciter's voice begins and ends using 10 ms RMS windows
   * compared against the recording's own peak and background noise floor.
   */
  function detectVoiceBounds(samples, sampleRate) {
    const win = Math.max(1, Math.round(sampleRate * 0.01));
    const count = Math.floor(samples.length / win);
    if (!count) return [0, samples.length - 1];

    const rms = new Float32Array(count);
    let peak = 0;
    for (let i = 0; i < count; i++) {
      let sumSq = 0;
      for (let j = i * win, end = j + win; j < end; j++) {
        sumSq += samples[j] * samples[j];
      }
      rms[i] = Math.sqrt(sumSq / win);
      if (rms[i] > peak) peak = rms[i];
    }
    if (peak < 0.003) return [0, samples.length - 1];

    const sorted = Array.from(rms).sort((a, b) => a - b);
    const noise = sorted[Math.floor(count * 0.1)];
    const threshold = Math.max(0.006, peak * 0.1, noise * 3);
    const soft = Math.max(threshold * 0.35, noise * 1.6);

    let startWin = 0;
    while (startWin < count - 1 && !(rms[startWin] > threshold && rms[startWin + 1] > threshold)) {
      startWin++;
    }
    // Widen start by up to 80 ms so soft opening consonants are never clipped
    for (let g = 0; g < 8 && startWin > 0 && rms[startWin - 1] > soft; g++) {
      startWin--;
    }

    const step = Math.max(1, Math.floor(sampleRate / 1000));
    let endSample = samples.length - 1;
    while (endSample > startWin * win && Math.abs(samples[endSample]) < 0.02) {
      endSample -= step;
    }
    return [startWin * win, endSample];
  }

  /* --------------------------------------------------------------------------
   * Verse Prefetch, Memory Cache & Sequential Silence Trimmer
   * ------------------------------------------------------------------------ */

  function createVerseCache(opts) {
    const isActiveSrc = opts.isActiveSrc;
    const onMeasured = opts.onMeasured;
    const timing = Object.create(null);     // url -> { lead, tail, dur }
    const rawMap = new Map();               // url -> ArrayBuffer
    const pendingMap = new Map();           // url -> Promise<ArrayBuffer|null>
    const mp3BlobMap = new Map();           // url -> ObjectURL (raw MP3)
    const trimBlobMap = new Map();          // url -> ObjectURL (trimmed WAV)
    const decodeQueue = [];
    let decoding = false;

    let proxyUnavailable = !opts.standalone || /github\.io$/i.test(location.hostname);
    let directCorsBlocked = false;

    const toProxiedUrl = (url) => "/audio/" + url.split("/data/")[1];

    async function fetchWithTimeout(reqUrl, init) {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), CONFIG.FETCH_TIMEOUT_MS) : null;
      try {
        const res = await fetch(reqUrl, ctrl ? Object.assign({}, init, { signal: ctrl.signal }) : init);
        return res;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    function evictIfNeeded() {
      while (rawMap.size > CONFIG.MAX_RAW_CACHE) {
        const oldest = rawMap.keys().next().value;
        if (!oldest) break;
        rawMap.delete(oldest);
        pendingMap.delete(oldest);
        const mp3Url = mp3BlobMap.get(oldest);
        if (mp3Url && !isActiveSrc(mp3Url)) {
          URL.revokeObjectURL(mp3Url);
          mp3BlobMap.delete(oldest);
        }
      }
      while (trimBlobMap.size > CONFIG.MAX_TRIM_CACHE) {
        const oldest = trimBlobMap.keys().next().value;
        if (!oldest) break;
        const trimUrl = trimBlobMap.get(oldest);
        if (trimUrl && isActiveSrc(trimUrl)) {
          // Move active entry to end so we don't infinite-loop
          trimBlobMap.delete(oldest);
          trimBlobMap.set(oldest, trimUrl);
          if (trimBlobMap.size <= 2) break;
          continue;
        }
        if (trimUrl) URL.revokeObjectURL(trimUrl);
        trimBlobMap.delete(oldest);
      }
    }

    function enqueueDecode(url) {
      if (timing[url] || document.hidden) return;
      if (decodeQueue.includes(url)) return;
      decodeQueue.push(url);
      if (!decoding) drainDecodeQueue();
    }

    function decodeArrayBuffer(ab) {
      return new Promise((resolve) => {
        const OfflineCtx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
        if (!OfflineCtx) { resolve(null); return; }
        const rates = [32000, 44100, 48000];
        let idx = 0;
        const attempt = () => {
          if (idx >= rates.length) { resolve(null); return; }
          const rate = rates[idx++];
          let ctx;
          try {
            ctx = new OfflineCtx(1, rate, rate);
          } catch (_) {
            attempt();
            return;
          }
          let settled = false;
          const ok = (buf) => { if (!settled) { settled = true; resolve(buf); } };
          const fail = () => { if (!settled) { settled = true; attempt(); } };
          try {
            const p = ctx.decodeAudioData(ab.slice(0), ok, fail);
            if (p && typeof p.then === "function") p.then(ok, fail);
          } catch (_) {
            fail();
          }
        };
        attempt();
      });
    }

    async function drainDecodeQueue() {
      if (decoding) return;
      decoding = true;
      try {
        while (decodeQueue.length && !document.hidden) {
          const url = decodeQueue.shift();
          if (timing[url] || !rawMap.has(url)) continue;
          const ab = rawMap.get(url);
          if (!ab) continue;
          const audioBuf = await decodeArrayBuffer(ab);
          if (!audioBuf || !rawMap.has(url)) continue;
          const data = audioBuf.getChannelData(0);
          const sr = audioBuf.sampleRate;
          const [startSample, endSample] = detectVoiceBounds(data, sr);
          timing[url] = {
            lead: Math.max(0, startSample / sr - 0.045),
            tail: Math.max(0, (data.length - endSample) / sr - 0.01),
            dur: audioBuf.duration
          };
          if (endSample > startSample && !document.hidden) {
            try {
              const from = Math.max(0, startSample - Math.round(CONFIG.KEEP_IN * sr));
              const to = Math.min(data.length, endSample + Math.round(CONFIG.KEEP_OUT * sr));
              const trimUrl = URL.createObjectURL(createWavBlob(data, sr, from, to));
              const prevTrim = trimBlobMap.get(url);
              if (prevTrim && !isActiveSrc(prevTrim)) URL.revokeObjectURL(prevTrim);
              trimBlobMap.set(url, trimUrl);
              evictIfNeeded();
            } catch (_) {
              /* fall back to raw MP3 */
            }
          }
          if (onMeasured) onMeasured(url);
        }
      } finally {
        decoding = false;
      }
    }

    function fetchVerse(url) {
      if (rawMap.has(url)) {
        enqueueDecode(url);
        return Promise.resolve(rawMap.get(url));
      }
      if (pendingMap.has(url)) return pendingMap.get(url);

      const p = (async () => {
        let res = null;

        // 1. Try same-origin Vercel proxy (/audio/...)
        if (!proxyUnavailable) {
          try {
            res = await fetchWithTimeout(toProxiedUrl(url));
            const ct = (res.headers.get("content-type") || "").toLowerCase();
            if (res.status === 404 || (res.ok && !/audio|octet-stream/.test(ct))) {
              // Server genuinely does not serve /audio/ proxy (e.g. local static server)
              proxyUnavailable = true;
              res = null;
            } else if (!res.ok) {
              // Transient 5xx / gateway error — do NOT permanently disable proxy
              res = null;
            }
          } catch (_) {
            // Transient network error or timeout — do NOT permanently disable proxy
            res = null;
          }
        }

        // 2. Fallback to direct EveryAyah CORS fetch
        if (!res && !directCorsBlocked) {
          try {
            res = await fetchWithTimeout(url, { mode: "cors" });
            if (!res.ok) res = null;
          } catch (err) {
            // Only assume CORS unsupported if we appear online and got TypeError
            if (navigator.onLine && err && err.name === "TypeError") {
              directCorsBlocked = true;
            }
            res = null;
          }
        }

        if (!res) {
          pendingMap.delete(url);
          return null;
        }

        const ab = await res.arrayBuffer();
        if (!ab || ab.byteLength < 128) {
          pendingMap.delete(url);
          return null;
        }
        rawMap.set(url, ab);
        evictIfNeeded();
        enqueueDecode(url);
        return ab;
      })().catch(() => {
        pendingMap.delete(url);
        return null;
      });

      pendingMap.set(url, p);
      return p;
    }

    function getSource(url, preferRawNetwork) {
      if (!preferRawNetwork) {
        // When screen is off, prefer raw MP3 blob over heavy WAV if WAV isn't already ready
        const trimmed = trimBlobMap.get(url);
        if (trimmed) return { src: trimmed, kind: "trim" };

        let mp3 = mp3BlobMap.get(url);
        const raw = rawMap.get(url);
        if (!mp3 && raw) {
          mp3 = URL.createObjectURL(new Blob([raw], { type: "audio/mpeg" }));
          mp3BlobMap.set(url, mp3);
        }
        if (mp3) return { src: mp3, kind: "raw" };
      }
      return {
        src: proxyUnavailable ? url : toProxiedUrl(url),
        kind: "raw"
      };
    }

    function invalidate(url) {
      pendingMap.delete(url);
      rawMap.delete(url);
      const t = trimBlobMap.get(url);
      if (t && !isActiveSrc(t)) URL.revokeObjectURL(t);
      trimBlobMap.delete(url);
      const m = mp3BlobMap.get(url);
      if (m && !isActiveSrc(m)) URL.revokeObjectURL(m);
      mp3BlobMap.delete(url);
    }

    function clearAll() {
      pendingMap.clear();
      rawMap.clear();
      decodeQueue.length = 0;
      for (const [k, u] of trimBlobMap) {
        if (!isActiveSrc(u)) { URL.revokeObjectURL(u); trimBlobMap.delete(k); }
      }
      for (const [k, u] of mp3BlobMap) {
        if (!isActiveSrc(u)) { URL.revokeObjectURL(u); mp3BlobMap.delete(k); }
      }
    }

    return {
      timing,
      hasRaw: (url) => rawMap.has(url),
      hasTrim: (url) => trimBlobMap.has(url),
      isProxyUnavailable: () => proxyUnavailable,
      markProxyUnavailable: () => { proxyUnavailable = true; },
      toProxiedUrl,
      fetchVerse,
      getSource,
      invalidate,
      clearAll,
      resumeDecoding: () => { if (!document.hidden && decodeQueue.length) drainDecodeQueue(); }
    };
  }

  /* --------------------------------------------------------------------------
   * Main Audio Engine
   * ------------------------------------------------------------------------ */

  function createAudioEngine(hooks) {
    let reciter = hooks.getReciter();
    let playId = 0;
    let handedPlayId = 0;
    let watchTimer = null;
    let stallTimer = null;
    let lastProgressTime = -1;
    let lastProgressAt = 0;
    let retryCount = 0;
    let retryTimer = null;
    let unlockDone = false;
    let pendingViewSync = null;

    // Live public state (kept compatible with existing UI code)
    const state = {
      a: null,          // active <audio> element
      s: 0,             // current surah (1..114), 0 when stopped
      v: 0,             // current verse (1..N)
      bas: false,       // true if currently playing the opening basmala
      inGap: false,     // true if playing inter-verse silent WAV gap
      gapNext: null,    // callback to run when silent WAV gap ends
      queue: null,      // Hifz repetition queue: Array<[s, v, rep]>
      onStep: null,
      onDone: null
    };

    const audioUrl = (s, v) =>
      "https://everyayah.com/data/" + reciter.dir + "/" + pad3(s) + pad3(v) + ".mp3";

    // Two HTMLAudioElements: primaryEl is always blessed; spareEl is used only
    // in foreground when already buffered for zero-gap verse transitions.
    const els = [];

    const cache = createVerseCache({
      standalone: hooks.standalone,
      isActiveSrc: (blobUrl) => els.some((el) => el.src === blobUrl),
      onMeasured: (url) => {
        if (state.a && state.a.dataset.url === url && state.a.dataset.kind === "raw") {
          skipLead(state.a);
        }
        prepareNext();
      }
    });

    function ensureElements() {
      if (els.length) return els;
      for (let i = 0; i < 2; i++) {
        const el = new Audio();
        el.preload = "auto";
        el.setAttribute("playsinline", "");
        el.dataset.slot = String(i);
        bindElementEvents(el);
        els.push(el);
      }
      state.a = els[0];
      return els;
    }

    function primaryEl() {
      ensureElements();
      return els[0];
    }

    function spareEl() {
      ensureElements();
      return els[0] === state.a ? els[1] : els[0];
    }

    function isPaused() {
      if (!state.s) return true;
      if (state.inGap) return state.a ? state.a.paused : false;
      return !state.a || state.a.paused;
    }

    /* ---- Event bindings on each <audio> element ---- */

    function bindElementEvents(el) {
      el.addEventListener("loadedmetadata", () => {
        if (el === state.a) {
          if (!state.inGap) {
            skipLead(el);
            updatePositionState(el);
          }
        } else {
          cueLead(el);
        }
      });

      el.addEventListener("timeupdate", () => {
        if (el !== state.a || !state.s || state.inGap) return;
        // Track forward progress for stall watchdog
        if (el.currentTime !== lastProgressTime) {
          lastProgressTime = el.currentTime;
          lastProgressAt = Date.now();
        }
        checkEarlyEnd(el);
      });

      el.addEventListener("ended", () => {
        if (el !== state.a || !state.s) return;
        if (state.inGap) {
          const nextFn = state.gapNext;
          state.inGap = false;
          state.gapNext = null;
          if (nextFn) nextFn();
          return;
        }
        triggerVerseEndOnce();
      });

      el.addEventListener("play", () => {
        if (el !== state.a) return;
        lastProgressTime = el.currentTime;
        lastProgressAt = Date.now();
        retryCount = 0;
        if (!state.inGap) updatePositionState(el);
        hooks.onUIUpdate();
      });

      el.addEventListener("pause", () => {
        if (el !== state.a) return;
        hooks.onUIUpdate();
      });

      el.addEventListener("error", () => {
        if (!el.getAttribute("src")) return;
        if (el !== state.a) {
          // Failed while preloading into spare: clear spare, active verse unaffected
          el.dataset.url = "";
          el.dataset.cued = "";
          return;
        }
        if (!state.s) return;
        if (state.inGap) {
          // Silent gap WAV somehow failed: proceed immediately to next verse
          const nextFn = state.gapNext;
          state.inGap = false;
          state.gapNext = null;
          if (nextFn) nextFn();
          return;
        }
        handlePlaybackFailure(el, playId);
      });
    }

    /* ---- Lead silence skipping & early foreground handoff ---- */

    function skipLead(el) {
      if (!el || el !== state.a || !state.s || el.dataset.kind === "trim") return;
      const t = cache.timing[el.dataset.url];
      if (t && t.lead > 0.04 && el.currentTime < Math.min(0.25, t.lead - 0.02)) {
        try { el.currentTime = t.lead; } catch (_) {}
      }
    }

    function cueLead(el) {
      if (el.dataset.kind === "trim") {
        el.dataset.cued = "1";
        return;
      }
      const t = cache.timing[el.dataset.url];
      if (t && t.lead > 0.04) {
        try { el.currentTime = t.lead; } catch (_) {}
      }
      el.dataset.cued = t ? "1" : "";
    }

    function canUseSpareFor(url) {
      if (document.hidden || hooks.getGapSec() > 0) return false;
      const sp = spareEl();
      return !!(sp && sp.dataset.url === url && sp.getAttribute("src") && sp.readyState >= 3);
    }

    function checkEarlyEnd(el) {
      if (!el || el !== state.a || !state.s || state.inGap || el.paused) return;
      if (!el.duration || !isFinite(el.duration) || el.duration <= 0.15) return;

      const remaining = el.duration - el.currentTime;
      if (remaining < 8 && !document.hidden) prepareNext();

      const nextUrl = upcomingUrl();
      const two = canUseSpareFor(nextUrl);
      const t = cache.timing[el.dataset.url];
      const isTrim = el.dataset.kind === "trim";

      // In background (screen off): let native `ended` event handle the switch cleanly
      // unless there is substantial measured trailing silence (> 0.25s) on a raw file.
      if (document.hidden) {
        if (!isTrim && t && t.tail > 0.25 && remaining <= t.tail - 0.05) {
          triggerVerseEndOnce();
        }
        return;
      }

      // Foreground: smooth handoff right as voice ends
      let leadMargin;
      if (two) {
        const tail = isTrim ? CONFIG.KEEP_OUT : (t && t.tail !== undefined ? t.tail : 0.15);
        leadMargin = tail + 0.08 + Math.max(0, CONFIG.KEEP_IN - 0.005);
      } else {
        const tail = isTrim ? 0.02 : (t && t.tail !== undefined ? Math.max(0.02, t.tail - 0.05) : 0.08);
        leadMargin = tail;
      }

      if (remaining <= leadMargin) {
        triggerVerseEndOnce();
      }
    }

    function triggerVerseEndOnce() {
      if (!state.s || handedPlayId === playId) return;
      handedPlayId = playId;
      onVerseEnded();
    }

    function startWatchers() {
      stopWatchers();
      if (!document.hidden) {
        watchTimer = setInterval(() => {
          if (state.a && state.s && !state.inGap) checkEarlyEnd(state.a);
        }, CONFIG.WATCH_INTERVAL_MS);
      }
      // Stall watchdog: checks every 2.5s if playback froze mid-verse on flaky mobile network
      stallTimer = setInterval(() => {
        const el = state.a;
        if (!el || !state.s || state.inGap || el.paused || el.ended) return;
        const now = Date.now();
        if (el.currentTime !== lastProgressTime) {
          lastProgressTime = el.currentTime;
          lastProgressAt = now;
          return;
        }
        if (lastProgressAt && now - lastProgressAt >= CONFIG.STALL_TIMEOUT_MS) {
          const url = el.dataset.url;
          if (!url) return;
          const resumeAt = el.currentTime || 0;
          lastProgressAt = now;
          if (retryCount < CONFIG.MAX_PLAY_RETRIES) {
            retryCount++;
            reloadAndResume(el, url, playId, resumeAt);
          }
        }
      }, 2500);
    }

    function stopWatchers() {
      if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
      if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    }

    /* ---- Safe playback, fallback & error recovery ---- */

    function assignSource(el, url, preferRawNetwork) {
      const resolved = cache.getSource(url, preferRawNetwork);
      el.dataset.url = url;
      el.dataset.kind = resolved.kind;
      el.src = resolved.src;
    }

    function reloadAndResume(el, url, myPlayId, resumeAt) {
      if (myPlayId !== playId || !state.s) return;
      const directSrc = url; // Direct EveryAyah URL bypasses any hung blob/proxy
      el.dataset.url = url;
      el.dataset.kind = "raw";
      el.src = directSrc;
      try { el.load(); } catch (_) {}
      if (resumeAt > 0.2) {
        const seekOnce = () => {
          el.removeEventListener("loadedmetadata", seekOnce);
          if (myPlayId === playId && state.s && isFinite(el.duration) && resumeAt < el.duration - 0.5) {
            try { el.currentTime = resumeAt; } catch (_) {}
          }
        };
        el.addEventListener("loadedmetadata", seekOnce);
      }
      safePlay(el, url, myPlayId, false);
    }

    function handlePlaybackFailure(el, myPlayId) {
      if (myPlayId !== playId || !state.s) return;
      const url = el.dataset.url;

      // Step 1: If a memory blob failed, drop it and try proxy/network immediately
      if (url && el.src && el.src.startsWith("blob:")) {
        cache.invalidate(url);
        assignSource(el, url, true);
        safePlay(el, url, myPlayId, false);
        return;
      }

      // Step 2: If /audio/ proxy failed, fall back directly to EveryAyah URL
      if (url && el.src && el.src.indexOf("/audio/") > -1) {
        el.dataset.kind = "raw";
        el.src = url;
        safePlay(el, url, myPlayId, false);
        return;
      }

      // Step 3: Transient network retry with backoff
      if (url && retryCount < CONFIG.MAX_PLAY_RETRIES) {
        retryCount++;
        const delay = retryCount === 1 ? 500 : 1500;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          if (myPlayId !== playId || !state.s) return;
          el.dataset.kind = "raw";
          el.src = url;
          try { el.load(); } catch (_) {}
          safePlay(el, url, myPlayId, false);
        }, delay);
        return;
      }

      hooks.onError("تعذّر تشغيل تلاوة " + reciter.name + ". جرّب قارئًا آخر أو تحقّق من الاتصال.");
      stop();
    }

    function safePlay(el, url, myPlayId, allowFallbackToPrimary) {
      let p;
      try {
        p = el.play();
      } catch (err) {
        p = Promise.reject(err);
      }
      if (!p || typeof p.then !== "function") return;

      p.catch((err) => {
        if (myPlayId !== playId || !state.s) return;
        const name = err && err.name ? err.name : "";

        // If spare <audio> was rejected by mobile autoplay policy, immediately
        // fall back to the blessed primary <audio> element!
        if (allowFallbackToPrimary && el !== primaryEl()) {
          const pri = primaryEl();
          try { el.pause(); } catch (_) {}
          state.a = pri;
          assignSource(pri, url, false);
          skipLead(pri);
          safePlay(pri, url, myPlayId, false);
          return;
        }

        // AbortError happens when src/load interrupts play — retry once shortly
        if (name === "AbortError" && retryCount < CONFIG.MAX_PLAY_RETRIES) {
          retryCount++;
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => {
            if (myPlayId !== playId || !state.s) return;
            safePlay(el, url, myPlayId, false);
          }, 180);
          return;
        }

        // Media decode / source error
        if (name !== "NotAllowedError") {
          handlePlaybackFailure(el, myPlayId);
        } else {
          // User must tap play (rare case: autoplay completely blocked)
          hooks.onUIUpdate();
        }
      });
    }

    /* ---- Prefetching & Spare Preloading ---- */

    function upcomingTarget() {
      if (!state.s) return null;
      if (state.queue) {
        if (!state.queue.length) return null;
        const [s, v] = state.queue[0];
        return { s, v, bas: false };
      }
      return hooks.getNextPlay(state.s, state.v, state.bas);
    }

    function targetToUrl(t) {
      if (!t) return "";
      return t.bas && t.s !== 1 && t.s !== 9 ? audioUrl(1, 1) : audioUrl(t.s, t.v);
    }

    function upcomingUrl() {
      return targetToUrl(upcomingTarget());
    }

    function prepareNext() {
      if (document.hidden || !state.s) return;
      const url = upcomingUrl();
      if (!url) return;
      const sp = spareEl();
      if (sp.dataset.url === url && !(sp.dataset.kind === "raw" && cache.hasTrim(url))) {
        if (sp.readyState >= 1 && !sp.dataset.cued && cache.timing[url]) cueLead(sp);
        return;
      }
      if (!cache.hasRaw(url)) return;
      try { sp.pause(); } catch (_) {}
      sp.dataset.cued = "";
      assignSource(sp, url, false);
      try { sp.load(); } catch (_) {}
    }

    async function prefetchAhead(s, v, bas) {
      const urls = [];
      if (state.queue && state.queue.length) {
        for (const item of state.queue.slice(0, CONFIG.PREFETCH_AHEAD)) {
          urls.push(audioUrl(item[0], item[1]));
        }
      } else {
        let cur = { s, v, bas };
        for (let i = 0; i < CONFIG.PREFETCH_AHEAD; i++) {
          cur = hooks.getNextPlay(cur.s, cur.v, cur.bas);
          if (!cur) break;
          urls.push(targetToUrl(cur));
        }
      }
      const unique = [...new Set(urls)].filter((u) => u && !cache.hasRaw(u));
      for (let i = 0; i < unique.length; i += 2) {
        await Promise.all(unique.slice(i, i + 2).map((u) => cache.fetchVerse(u)));
      }
    }

    function unlockSpareOnFirstGesture() {
      if (unlockDone) return;
      unlockDone = true;
      const sp = spareEl();
      try {
        sp.muted = true;
        sp.src = TINY_SILENT_WAV;
        const p = sp.play();
        const restore = () => {
          try { sp.pause(); } catch (_) {}
          sp.muted = false;
          if (sp.src === TINY_SILENT_WAV || sp.src.startsWith("data:")) {
            sp.removeAttribute("src");
          }
        };
        if (p && typeof p.then === "function") p.then(restore, restore);
        else restore();
      } catch (_) {
        sp.muted = false;
      }
    }

    /* ---- Gap Playback (keeps background audio session unbroken!) ---- */

    function playGapThen(gapSec, fn) {
      if (!gapSec || gapSec <= 0) {
        fn();
        return;
      }
      const myPlayId = playId;
      const el = state.a || primaryEl();
      state.inGap = true;
      state.gapNext = () => {
        if (myPlayId !== playId || !state.s) return;
        fn();
      };
      // Play a real silent WAV on the SAME active <audio> element so iOS/Android
      // never pause or suspend the PWA during the gap!
      el.dataset.url = "";
      el.dataset.kind = "gap";
      el.src = getSilenceGapUrl(gapSec);
      const p = el.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          // Fallback timer if silent WAV couldn't start
          setTimeout(() => {
            if (myPlayId === playId && state.s && state.inGap) {
              const nextFn = state.gapNext;
              state.inGap = false;
              state.gapNext = null;
              if (nextFn) nextFn();
            }
          }, gapSec * 1000);
        });
      }
    }

    /* ---- Verse Transitions ---- */

    function onVerseEnded() {
      const s = state.s;
      const v = state.v;
      const bas = state.bas;
      if (s && !bas) hooks.onVerseListened(s, v);

      // 1. Hifz / Review queue mode
      if (state.queue) {
        if (state.queue.length) {
          const [qs, qv, rep] = state.queue.shift();
          playGapThen(hooks.getGapSec(), () => {
            playVerse(qs, qv, { keep: true, rep, autoAdvance: true });
          });
        } else {
          const done = state.onDone;
          stop();
          if (done) done();
        }
        return;
      }

      if (!s) {
        stop();
        return;
      }

      // 2. Normal continuous recitation
      const nx = hooks.getNextPlay(s, v, bas);
      if (!nx) {
        stop();
        hooks.onComplete();
        return;
      }

      const advance = () => {
        playVerse(nx.s, nx.v, { keep: true, bas: !!nx.bas, autoAdvance: true });
        if (document.hidden) {
          // Avoid heavy background DOM/font rendering while screen is off;
          // view will snap cleanly to the active verse when the screen wakes.
          pendingViewSync = { s: nx.s, v: nx.v };
        } else {
          pendingViewSync = null;
          hooks.onSyncView(nx.s, nx.v);
        }
      };

      playGapThen(hooks.getGapSec(), advance);
    }

    /* ---- Core Public Controls ---- */

    function playVerse(s, v, opt) {
      opt = opt || {};
      ensureElements();
      clearTimeout(retryTimer);

      const myPlayId = ++playId;
      handedPlayId = 0;
      retryCount = 0;
      state.inGap = false;
      state.gapNext = null;

      if (!opt.keep) {
        state.queue = null;
        state.onStep = null;
        state.onDone = null;
      }

      const bas = !!opt.bas && s !== 1 && s !== 9;
      const url = bas ? audioUrl(1, 1) : audioUrl(s, v);

      // Unlock spare <audio> only on direct user gesture (not during auto-advance)
      if (!opt.autoAdvance) {
        unlockSpareOnFirstGesture();
      }

      const canHandoffToSpare = opt.autoAdvance && canUseSpareFor(url);
      let el;

      if (canHandoffToSpare) {
        // Foreground gapless handoff: spare is already buffered at readyState >= 3
        el = spareEl();
        if (!el.dataset.cued) cueLead(el);
        state.a = el;
      } else {
        // Single-element path (always used when screen is off, on user click,
        // when gap > 0, or if spare wasn't fully buffered yet)
        el = state.a || primaryEl();
        els.forEach((other) => {
          if (other !== el) {
            try { other.pause(); } catch (_) {}
          }
        });
        assignSource(el, url, false);
        skipLead(el);
      }

      state.s = s;
      state.v = v;
      state.bas = bas;
      lastProgressTime = -1;
      lastProgressAt = Date.now();

      startWatchers();
      safePlay(el, url, myPlayId, canHandoffToSpare);

      // Prefetch upcoming verses & warm spare element shortly after starting
      prefetchAhead(s, v, bas);
      if (!document.hidden) {
        setTimeout(() => {
          if (myPlayId === playId && state.s) prepareNext();
        }, 1200);
      }

      if (!bas) hooks.onSaveListenPos(s, v, reciter.id);
      updateMediaSession(s, v);
      if (state.onStep) state.onStep(s, v, opt.rep || 1);
      hooks.onMarkPlaying();
    }

    function playFrom(s, v) {
      playVerse(s, v, { bas: v === 1 });
    }

    function playQueue(items, onStep, onDone) {
      if (!items || !items.length) return;
      state.queue = items.slice(1);
      state.onStep = onStep;
      state.onDone = onDone;
      const [s, v, rep] = items[0];
      playVerse(s, v, { keep: true, rep });
    }

    function togglePause() {
      if (!state.s || !state.a) return;
      if (state.a.paused) {
        lastProgressAt = Date.now();
        safePlay(state.a, state.a.dataset.url || "", playId, false);
      } else {
        state.a.pause();
      }
    }

    function stop() {
      stopWatchers();
      playId++;
      handedPlayId = 0;
      retryCount = 0;
      pendingViewSync = null;
      state.s = 0;
      state.v = 0;
      state.bas = false;
      state.inGap = false;
      state.gapNext = null;
      state.queue = null;
      state.onStep = null;
      state.onDone = null;
      els.forEach((el) => {
        try { el.pause(); } catch (_) {}
        el.removeAttribute("src");
        el.dataset.url = "";
        el.dataset.cued = "";
        try { el.load(); } catch (_) {}
      });
      if (els.length) state.a = els[0];
      updateMediaSessionState();
      hooks.onClearUI();
    }

    function setReciter(nextReciter) {
      reciter = nextReciter;
      cache.clearAll();
      if (state.s) {
        playVerse(state.s, state.v, { keep: !!state.queue, bas: state.bas });
      }
    }

    /* ---- MediaSession (iOS Lock Screen & Android Notification) ---- */

    let mediaHandlersBound = false;

    function msJump(target) {
      if (!target) return;
      playVerse(target.s, target.v, { keep: !!state.queue, bas: !!target.bas });
      if (document.hidden) {
        pendingViewSync = { s: target.s, v: target.v };
      } else {
        pendingViewSync = null;
        hooks.onSyncView(target.s, target.v);
      }
    }

    function msNext() {
      if (!state.s) return;
      if (state.queue) {
        if (!state.queue.length) {
          const done = state.onDone;
          stop();
          if (done) done();
          return;
        }
        const [s, v, rep] = state.queue.shift();
        playVerse(s, v, { keep: true, rep });
        return;
      }
      msJump(hooks.getNextPlay(state.s, state.v, state.bas));
    }

    function msPrev() {
      if (!state.s) return;
      const s = state.s;
      const v = state.v;
      if (state.queue || state.bas) {
        playVerse(s, v, { keep: !!state.queue });
        return;
      }
      if (v > 1) msJump({ s, v: v - 1 });
      else if (s > 1) msJump({ s: s - 1, v: hooks.getSurahVerseCount(s - 1) });
      else playVerse(s, v);
    }

    function msRestart() {
      if (state.s) playVerse(state.s, state.v, { keep: !!state.queue, bas: state.bas });
    }

    function updateMediaSession(s, v) {
      if (!("mediaSession" in navigator)) return;
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: `سورة ${hooks.getSurahName(s)}، الآية ${v}`,
          artist: reciter.name,
          album: "مصحف التدبر",
          artwork: [
            { src: new URL("apple-touch-icon.png", location.href).href, sizes: "180x180", type: "image/png" },
            { src: new URL("icon-512.png", location.href).href, sizes: "512x512", type: "image/png" }
          ]
        });
        if (!mediaHandlersBound) {
          mediaHandlersBound = true;
          const ms = navigator.mediaSession;
          const on = (k, fn) => { try { ms.setActionHandler(k, fn); } catch (_) {} };
          on("play", () => { if (isPaused()) togglePause(); });
          on("pause", () => { if (!isPaused()) togglePause(); });
          on("nexttrack", msNext);
          on("previoustrack", msPrev);
          on("seekbackward", msRestart);
          on("stop", stop);
        }
      } catch (_) {}
    }

    function updateMediaSessionState() {
      if (!("mediaSession" in navigator)) return;
      try {
        navigator.mediaSession.playbackState = state.s
          ? (isPaused() ? "paused" : "playing")
          : "none";
        if (!state.s) navigator.mediaSession.metadata = null;
      } catch (_) {}
    }

    function updatePositionState(el) {
      if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
      if (!el || !isFinite(el.duration) || el.duration <= 0) return;
      try {
        navigator.mediaSession.setPositionState({
          duration: el.duration,
          playbackRate: el.playbackRate || 1,
          position: Math.min(el.duration, Math.max(0, el.currentTime || 0))
        });
      } catch (_) {}
    }

    /* ---- Visibility / Wake Synchronization ---- */

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        // Pause foreground polling timer; native `timeupdate` & `ended` keep running cleanly
        if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
        return;
      }
      // Screen woke up: resume foreground watcher, silence trimming, and sync view if surah/page advanced while locked
      if (state.s) {
        if (!watchTimer) {
          watchTimer = setInterval(() => {
            if (state.a && state.s && !state.inGap) checkEarlyEnd(state.a);
          }, CONFIG.WATCH_INTERVAL_MS);
        }
        cache.resumeDecoding();
        if (pendingViewSync) {
          const target = pendingViewSync;
          pendingViewSync = null;
          hooks.onSyncView(target.s, target.v);
        }
        hooks.onMarkPlaying();
        setTimeout(prepareNext, 250);
      }
    });

    return {
      state,
      playVerse,
      playFrom,
      playQueue,
      togglePause,
      stop,
      setReciter,
      isPaused,
      updateMediaSessionState,
      msNext,
      msPrev,
      msRestart
    };
  }

  global.MushafAudio = {
    RECITERS,
    GAPS,
    createAudioEngine
  };
})(window);
