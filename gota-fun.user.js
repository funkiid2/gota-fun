// ==UserScript==
// @name         gota fun v2
// @namespace    http://tampermonkey.net/
// @version      3.35.0
// @description  v3.35.0: las animaciones CSS continuas de los paneles del menú (nebulaMove en xp-meter/botones/nombre de servidor/portal-label, apexPortalAura, apexAvatarBreath) seguían corriendo aunque el jugador ya estuviera en partida y el menú estuviera fuera de vista -- una animación "infinite" no se detiene sola solo porque el elemento no se ve, salvo que quede en display:none real (no alcanza con opacity/visibility/estar tapado). Se agrega _updateInGameState, que revisa en cada tick de _scheduleBeautify (cada ~400ms, sin timer nuevo) si el panel de Funkiid Build/Perfil sigue realmente visible (offsetParent + getComputedStyle) y alterna una clase 'apex-in-game' en <html>; la hoja _apex_perf usa esa clase para pausar esas animaciones con animation-play-state (no cambia colores/posiciones, solo si siguen corriendo cuadro a cuadro) y las reactiva sola en cuanto el menú vuelve a ser visible.
// @author       funkiid
// @updateURL    https://github.com/funkiid2/gota-fun/raw/refs/heads/main/gota-fun.user.js
// @downloadURL  https://github.com/funkiid2/gota-fun/raw/refs/heads/main/gota-fun.user.js
// @icon         https://cdn.shopify.com/s/files/1/0125/8261/7145/files/BOYFRIEND_PLUSH_TOY-SV4-P-1_1000x.png.webp?v=1726159538
// @match        https://gota.io/web/*
// @match        https://play.gota.io/*
// @match        https://gota.io/*
// @match        https://gota.io/camlan/*
// @grant        none
// @run-at       document-start
// ==/UserScript==


(function () {
'use strict';

const SCRIPT_VERSION = '3.35.0';
const DEBUG_FREEZE_LOG = false;
const RETINA_PERF_MODE = false;
if (RETINA_PERF_MODE) {
    try { Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true }); } catch (_) {}
}
const LOW_LATENCY_CANVAS_WEBGL = false;
const LOW_LATENCY_CANVAS_2D    = false;
const NET_TIMEOUT_MS = 8000;
const W = window, D = document;
const RL = D.head || D.documentElement;
const NOP = () => {};

const _pNow      = performance.now.bind(performance);
const _rAF       = W.requestAnimationFrame.bind(W);
const _oST_      = W.setTimeout;
const _OrigWS    = W.WebSocket;
const _OrigWrk   = W.Worker;
const _origCE    = D.createElement.bind(D);
const _origFetch = W.fetch;

const _origWSSend = _OrigWS.prototype.send;
const _OrigPO     = W.PerformanceObserver;
const _elRemove   = Element.prototype.remove;

W.__freezeLog = W.__freezeLog || [];
W.__wsGapMax  = W.__wsGapMax  || 0;

const _logPush = (entry) => {
    const log = W.__freezeLog;
    log.push(entry);
    if (log.length > 1000) W.__freezeLog = log.slice(-800);
};

W.__freezeSummary = function () {
    const log = W.__freezeLog;
    const grp = Object.create(null);
    let i = log.length;
    while (i--) {
        const t = log[i].type;
        if (!grp[t]) grp[t] = [];
        grp[t].push(log[i]);
    }
    const stat = (arr, field) => {
        if (!arr || !arr.length) return { n: 0, avg: 0, max: 0, p95: 0 };
        const vals = [];
        let j = arr.length;
        while (j--) { const v = arr[j][field]; if (v > 0) vals.push(v); }
        if (!vals.length) return { n: arr.length, avg: 0, max: 0, p95: 0 };
        vals.sort((a, b) => a - b);
        const n = vals.length;
        return { n, avg: vals.reduce((s, v) => s + v, 0) / n | 0, max: vals[n - 1] | 0, p95: vals[Math.floor(n * 0.95)] | 0 };
    };

    const _eventTs = e => e.start !== undefined ? e.start : e.t;
    const _resumes = grp.PageResume || [];
    const _heavyEvents = [].concat(grp.LongTask || [], grp.LoAF || [], grp.JankFrame || []);
    const _heavyTs = _heavyEvents.map(_eventTs).sort((a, b) => a - b);
    const _catchupGaps = [];
    for (let r = 0; r < _resumes.length; r++) {
        const rt = _resumes[r].t;
        let lo = 0, hi = _heavyTs.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (_heavyTs[mid] < rt) lo = mid + 1; else hi = mid; }
        if (lo < _heavyTs.length) _catchupGaps.push({ gap: _heavyTs[lo] - rt });
    }

    const _wsCloses = grp.WSClose || [];

    const _loafEntries = grp.LoAF || [];
    const _topScriptsAgg = Object.create(null);
    for (let i = 0; i < _loafEntries.length; i++) {
        const key = _loafEntries[i].topScript || '(desconocido)';
        if (!_topScriptsAgg[key]) _topScriptsAgg[key] = { count: 0, totalDur: 0 };
        _topScriptsAgg[key].count++;
        _topScriptsAgg[key].totalDur += _loafEntries[i].topScriptDur || 0;
    }
    const topOffenders = Object.keys(_topScriptsAgg)
        .map(k => ({ script: k, count: _topScriptsAgg[k].count, totalDur: _topScriptsAgg[k].totalDur | 0 }))
        .sort((a, b) => b.totalDur - a.totalDur)
        .slice(0, 5);

    return {
        JankFrame:           stat(grp.JankFrame,      'gap'),
        LongTask:            stat(grp.LongTask,       'dur'),
        LoAF:                stat(grp.LoAF,           'dur'),
        topOffenders,
        InputDelay:          stat(grp.InputDelay,     'delay'),
        WSBackpressure:      stat(grp.WSBackpressure, 'ba'),
        CPUPressure:         { n: (grp.CPUPressure || []).length },
        PageFreezeCount:     { n: (grp.PageFreeze   || []).length },
        BFCacheRestoreCount: { n: (grp.BFCacheRestore || []).length },
        WSCloseEvents:       { n: _wsCloses.length, codes: _wsCloses.map(e => e.code) },
        postResumeCatchupMs: stat(_catchupGaps, 'gap'),
        wsGapMax:            W.__wsGapMax,
        totalEntries:        log.length,
    };
};

let _lastBPLog = 0, _lastIDLog = 0;

if (DEBUG_FREEZE_LOG) {
    try {
        if (W.PressureObserver) {
            const _po = new W.PressureObserver(records => {
                let i = records.length;
                while (i--) _logPush({ type: 'CPUPressure', state: records[i].state, t: _pNow() | 0 });
            });
            _po.observe('cpu', { sampleInterval: 1000 }).catch(NOP);
        }
    } catch (_) {}

    try {
        D.addEventListener('freeze', () => _logPush({ type: 'PageFreeze', t: _pNow() | 0 }));
        D.addEventListener('resume', () => _logPush({ type: 'PageResume', t: _pNow() | 0 }));
    } catch (_) {}

    try {
        if (_OrigPO) {
            const _hasLoAF = _OrigPO.supportedEntryTypes &&
                              _OrigPO.supportedEntryTypes.indexOf('long-animation-frame') !== -1;
            if (_hasLoAF) {
                new _OrigPO(list => {
                    const entries = list.getEntries(); let i = entries.length;
                    while (i--) {
                        const e = entries[i];
                        const scripts = e.scripts || [];
                        let topDur = 0, topScript = '';
                        for (let s = 0; s < scripts.length; s++) {
                            if (scripts[s].duration > topDur) {
                                topDur = scripts[s].duration;
                                topScript = scripts[s].invoker || scripts[s].sourceURL || '';
                            }
                        }
                        _logPush({
                            type: 'LoAF',
                            dur: e.duration | 0,
                            renderDelay: ((e.styleAndLayoutStart || e.renderStart || 0) - (e.renderStart || 0)) | 0,
                            topScript,
                            topScriptDur: topDur | 0,
                            start: e.startTime | 0,
                        });
                    }
                }).observe({ type: 'long-animation-frame', buffered: false });
            } else if (_OrigPO) {
                new _OrigPO(list => {
                    const entries = list.getEntries(); let i = entries.length;
                    while (i--) {
                        const e = entries[i];
                        _logPush({ type: 'LongTask', dur: e.duration | 0, start: e.startTime | 0,
                            src: e.attribution && e.attribution[0] ? (e.attribution[0].containerSrc || e.attribution[0].name || '') : '' });
                    }
                }).observe({ entryTypes: ['longtask'] });
            }
        }
    } catch (_) {}

    try {
        if (_OrigPO) {
            new _OrigPO(list => {
                const entries = list.getEntries(); let i = entries.length;
                while (i--) {
                    const e = entries[i];
                    const delay = e.processingStart - e.startTime;
                    if (delay > 16) {
                        const now = _pNow();
                        if (now - _lastIDLog > 100) { _lastIDLog = now; _logPush({ type: 'InputDelay', name: e.name, delay: delay | 0, t: e.startTime | 0 }); }
                    }
                }
            }).observe({ type: 'event', durationThreshold: 16 });
        }
    } catch (_) {}

    (function () {
        let _rfTs = 0;
        const _rfW = ts => { const gap = ts - _rfTs; if (_rfTs > 0 && gap > 50) _logPush({ type: 'JankFrame', gap: gap | 0, t: ts | 0 }); _rfTs = ts; _rAF(_rfW); };
        _rAF(_rfW);
    })();

    (function () {
        const _logSummary = () => {
            try { console.log('[gota fun] __freezeSummary():', W.__freezeSummary()); } catch (_) {}
            _oST_(_logSummary, 30000);
        };
        _oST_(_logSummary, 30000);
    })();
}

try { if (W.performance) W.performance.toJSON = function () { return {}; }; } catch (_) {}

if (!DEBUG_FREEZE_LOG) {
    try {
        if (W.performance) {
            W.performance.mark = NOP; W.performance.measure = NOP;
            W.performance.clearMarks = NOP; W.performance.clearMeasures = NOP;
        }
        W.PerformanceObserver = function () { return { observe: NOP, disconnect: NOP, takeRecords: () => [] }; };
        W.PerformanceObserver.supportedEntryTypes = [];
    } catch (_) {}

    const _nukedKeys = ['log','debug','info','warn','error','trace','group','groupEnd','groupCollapsed','table','count','time','timeEnd','timeLog','dir','dirxml','assert','clear'];
    const _buildNukedConsole = (base) => {
        const c = Object.create(base || Object.prototype);
        for (let i = 0; i < _nukedKeys.length; i++) c[_nukedKeys[i]] = NOP;
        return c;
    };
    let _lockedConsole = null;
    try {
        _lockedConsole = _buildNukedConsole(W.console);
        Object.defineProperty(W, 'console', {
            get: () => _lockedConsole,
            set: NOP,
            configurable: false,
        });
    } catch (_) {
        try {
            const c = W.console;
            for (let i = 0; i < _nukedKeys.length; i++) try { c[_nukedKeys[i]] = NOP; } catch (_2) {}
        } catch (_2) {}
    }
}

try { W.addEventListener('securitypolicyviolation', e => { e.stopImmediatePropagation(); e.preventDefault(); }, true); } catch (_) {}
try { if (W.ReportingObserver) W.ReportingObserver = () => ({ observe: NOP, disconnect: NOP }); } catch (_) {}

const _lru = (max) => {
    const m = new Map();
    return {
        get(k) {
            if (!m.has(k)) return undefined;
            const v = m.get(k);
            m.delete(k); m.set(k, v);
            return v;
        },
        set(k, v) {
            if (m.has(k)) { m.delete(k); }
            else if (m.size >= max) { m.delete(m.keys().next().value); }
            m.set(k, v);
        }
    };
};

const _errCache = _lru(48);
const _isGErr = m => {
    if (!m) return false;
    const h = _errCache.get(m); if (h !== undefined) return h;
    const r = m.includes('_0x') || m.includes('net::') || m.includes('NS_ERROR') || m.includes('Failed to fetch') ||
        m.includes('is not a function') || m.includes('is not defined') || m.includes('Cannot set') ||
        m.includes('of undefined') || m.includes('of null') ||
        (m.includes('Cannot read') && (m.includes('null') || m.includes('undefined'))) ||
        (m.includes('style') && m.includes('null'));
    _errCache.set(m, r); return r;
};
W.addEventListener('error', e => { if (_isGErr(e && e.message)) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
W.addEventListener('unhandledrejection', e => {
    const m = e.reason && typeof e.reason.message === 'string' ? e.reason.message : typeof e.reason === 'string' ? e.reason : null;
    if (m && _isGErr(m)) { e.stopImmediatePropagation(); e.preventDefault(); }
}, true);

W.ga = W.gtag = W.fbq = W._fbq = NOP;
W.dataLayer = { push: NOP };
D.write = D.writeln = NOP;

try {
    if (W.RTCPeerConnection) {
        const _OrigRTC = W.RTCPeerConnection;
        const _rtcMk = () => ({
            createOffer:          () => Promise.resolve({ type: 'offer',  sdp: '' }),
            createAnswer:         () => Promise.resolve({ type: 'answer', sdp: '' }),
            setLocalDescription:  () => Promise.resolve(),
            setRemoteDescription: () => Promise.resolve(),
            addIceCandidate:      () => Promise.resolve(),
            close:                NOP,
            addEventListener:     NOP,
            removeEventListener:  NOP,
            dispatchEvent:        () => false,
            onicecandidate:       null,
            ontrack:              null,
            ondatachannel:        null,
            connectionState:      'connected',
            iceConnectionState:   'completed',
            iceGatheringState:    'complete',
            signalingState:       'stable',
            getStats:             () => Promise.resolve(new Map()),
            getSenders:           () => [],
            getReceivers:         () => [],
            getTransceivers:      () => [],
            createDataChannel:    () => ({ send: NOP, close: NOP, readyState: 'open', addEventListener: NOP, removeEventListener: NOP }),
        });
        W.RTCPeerConnection = function () { return _rtcMk(); };
        W.RTCPeerConnection.prototype = _OrigRTC.prototype;
        try { W.webkitRTCPeerConnection = W.RTCPeerConnection; } catch (_) {}
    }
} catch (_) {}

try {
    if (W.IdleDetector) {
        class _IdleDSub extends EventTarget {
            constructor() { super(); }
            static async requestPermission() { return 'granted'; }
            async start() {}
            get userState()   { return 'active'; }
            get screenState() { return 'unlocked'; }
        }
        W.IdleDetector = _IdleDSub;
    }
} catch (_) {}

const OPT_PASSIVE_TRUE    = Object.freeze({ passive: true });
const OPT_PASSIVE_CAPTURE = Object.freeze({ capture: true, passive: true });
const OPT_ACTIVE_CAPTURE  = Object.freeze({ capture: true, passive: false });

const _origAEL = EventTarget.prototype.addEventListener;
const _origREL = EventTarget.prototype.removeEventListener;

const _PASSIVES = Object.create(null);
_PASSIVES['wheel']            = true;
_PASSIVES['mousewheel']       = true;
_PASSIVES['touchstart']       = true;
_PASSIVES['touchmove']        = true;
_PASSIVES['pointerrawupdate'] = true;

EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (_PASSIVES[type]) {
        if (opts === undefined) opts = OPT_PASSIVE_TRUE;
        else if (typeof opts === 'object') opts = opts.passive ? opts : (opts.capture ? OPT_PASSIVE_CAPTURE : OPT_PASSIVE_TRUE);
        else if (typeof opts === 'boolean') opts = opts ? OPT_PASSIVE_CAPTURE : OPT_PASSIVE_TRUE;
    }
    return _origAEL.call(this, type, fn, opts);
};
const _aEL = _origAEL;
const _rEL = _origREL;

try { W.addEventListener('pointerrawupdate', NOP, OPT_PASSIVE_TRUE); } catch (_) {}

const _hDesc = Object.getOwnPropertyDescriptor(D, 'hidden') ||
               Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
const _getRealHidden = (_hDesc && _hDesc.get)
    ? () => { try { return _hDesc.get.call(D); } catch (_) { return false; } }
    : () => false;

const _macrotask = (function () {
    try {
        const channel = new MessageChannel();
        let isPending = false, queue = [];
        channel.port1.onmessage = function () {
            isPending = false; const tasks = queue; queue = [];
            const len = tasks.length; for (let i = 0; i < len; i++) tasks[i]();
        };
        return function (fn) { queue.push(fn); if (!isPending) { isPending = true; channel.port2.postMessage(null); } };
    } catch (e) { return f => _oST_(f, 0); }
})();

const OPT_P = OPT_PASSIVE_TRUE;
const OPT_O = Object.freeze({ once: true, passive: true });
const EMPTY = Object.freeze([]);

let _sacredStyleEl = null, _perfStyleEl = null;

let _beautifyQueue = new Set();
const _queueBeautify = node => {
    if (!node || _beautifyQueue.has(D.body)) return;
    _beautifyQueue.add(node);
    if (_beautifyQueue.size > 300) { _beautifyQueue.clear(); if (D.body) _beautifyQueue.add(D.body); }
};

let _mutBacklogDropped = false;

if (!DEBUG_FREEZE_LOG) {
}
try { if (W.console) { } } catch (_) {}

try {
    const _idbBlk = new Set(['amplitude','mixpanel','analytics','clarity','posthog','segment','hotjar','sentry','newrelic','datadog']);
    const _FAKE = Object.freeze({ result:null, error:null, readyState:'done', onsuccess:null, onerror:null, onupgradeneeded:null, onblocked:null, addEventListener:NOP, removeEventListener:NOP, dispatchEvent:()=>false });
    const _idbO = indexedDB.open.bind(indexedDB);
    indexedDB.open = function (name, ver) {
        if (typeof name === 'string') {
            const n = name.toLowerCase();
            if (!n.includes('gota') && !n.includes('firebase') && !n.includes('google') && !n.includes('auth'))
                for (const b of _idbBlk) if (n.includes(b)) return _FAKE;
        }
        return ver !== undefined ? _idbO(name, ver) : _idbO(name);
    };
} catch (_) {}

try {
    if (W.scheduler && W.scheduler.postTask) {
        const _origPostTask = W.scheduler.postTask.bind(W.scheduler);
        W.scheduler.postTask = function (task, opts) {
            if (opts && opts.priority === 'background') return Promise.resolve();
            return _origPostTask(task, opts);
        };
    }
} catch (_) {}

const _ORI = location.origin;
const _BLK_RX = new RegExp('google-analytics\\.com|googletagmanager\\.com|googletagservices\\.com|googlesyndication\\.com|doubleclick\\.net|googleadservices\\.com|facebook\\.net|analytics\\.facebook\\.com|onesignal\\.com|hotjar\\.com|clarity\\.ms|mixpanel\\.com|amplitude\\.com|fullstory\\.com|segment\\.com|segment\\.io|sentry\\.io|browser\\.sentry-cdn\\.com|newrelic\\.com|nr-data\\.net|datadoghq\\.com|logrocket\\.com|posthog\\.com|plausible\\.io|mouseflow\\.com|luckyorange\\.com|smartlook\\.com|heap\\.io|heapanalytics\\.com|static\\.cloudflareinsights\\.com|cloudflareinsights\\.com|cdn\\.addinplay\\.com|addinplay\\.com|pubmatic\\.com|criteo\\.com|taboola\\.com|outbrain\\.com|raygun\\.io|bugsnag\\.com|rubiconproject\\.com|openx\\.net|amazon-adsystem\\.com|optimizely\\.com|quantserve\\.com|comscore\\.com|chartbeat\\.com|parsely\\.com|branch\\.io|adjust\\.com|kochava\\.com|appsflyer\\.com|moengage\\.com|clevertap\\.com|leanplum\\.com|analytics\\.tiktok\\.com|px\\.ads\\.linkedin\\.com|ct\\.pinterest\\.com', 'i');

const _sbCache = _lru(200);
function _sb(url) {
    if (!url) return 0;
    const s = typeof url === 'string' ? url : '' + url;
    const c0 = s.charCodeAt(0);
    if (c0 === 47 || c0 === 100 || c0 === 98 || c0 === 119) return 0;
    if (s.startsWith(_ORI)) return 0;
    let hn;
    try { hn = new URL(s, _ORI).hostname; } catch (_) { return 0; }
    const cached = _sbCache.get(hn);
    if (cached !== undefined) return cached;
    const r = _BLK_RX.test(hn) ? 1 : 0;
    _sbCache.set(hn, r);
    return r;
}

const _AD_SEL = '#main-left-ad, #main-right-ad, #main-bottom-ad, .ad-container, [id^="div-gpt-ad"], [id^="google_ads"], [id*="-ad-container"]';

const _isAdPlaceholderText = (text) => text.indexOf('Advertisement') !== -1 || text.indexOf('Adblock!') !== -1;

const _trashCan = new Set();
let _trashPending = false;
const _emptyTrash = () => {
    _trashPending = false;
    _trashCan.forEach(el => { try { _elRemove.call(el); } catch (_) {} });
    _trashCan.clear();
};
const _scheduleTrash = (typeof queueMicrotask === 'function') ? queueMicrotask : fn => Promise.resolve().then(fn);
const _blkEl = el => {
    _trashCan.add(el);
    if (!_trashPending) { _trashPending = true; _scheduleTrash(_emptyTrash); }
};

try {
    const _pp = (proto, prop) => {
        const d = Object.getOwnPropertyDescriptor(proto, prop);
        if (!d || !d.set) return;
        const orig = d.set;
        Object.defineProperty(proto, prop, {
            get: d.get,
            set(v) { if (_sb(typeof v === 'string' ? v : '' + v)) { _blkEl(this); return; } orig.call(this, v); },
            configurable: true
        });
    };
    _pp(HTMLScriptElement.prototype, 'src');
    _pp(HTMLIFrameElement.prototype, 'src');
    _pp(HTMLLinkElement.prototype, 'href');
    _pp(HTMLImageElement.prototype, 'src');
} catch (_) {}

const _hasAbortTimeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function';
const _hasAbortAny     = typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function';

const _combineSignals = (a, b) => {
    if (a.aborted) return a;
    if (b.aborted) return b;
    const c = new AbortController();
    const onAbort = e => c.abort(e.target.reason);
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
    return c.signal;
};

W.fetch = function (inp, init) {
    const u = typeof inp === 'string' ? inp : inp instanceof URL ? inp.href : (inp && inp.url ? inp.url : '');
    if (_sb(u)) return Promise.resolve(new Response('', { status: 200 }));

    if (u.includes('gota.io') || u.includes('googleapis.com') || u.includes('firebase')) {
        let next = init;
        if (!next) {
            next = { priority: 'high' };
        } else if (next.priority !== 'high' || next.keepalive) {
            next = Object.assign({}, next, { priority: 'high' });
            delete next.keepalive;
        }
        if (_hasAbortTimeout) {
            if (next.signal) {
                const _timeoutSig = AbortSignal.timeout(NET_TIMEOUT_MS);
                next = Object.assign({}, next, {
                    signal: _hasAbortAny ? AbortSignal.any([next.signal, _timeoutSig]) : _combineSignals(next.signal, _timeoutSig)
                });
            } else {
                next = Object.assign({}, next, { signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
            }
        }
        init = next;
    }
    return _origFetch.call(W, inp, init);
};

const _xBlk = new WeakSet();
const _oXO  = XMLHttpRequest.prototype.open;
const _oXS  = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (m, u, a, us, pw) {
    const url = typeof u === 'string' ? u : '' + u;
    if (_sb(url)) { _xBlk.add(this); }
    else if (url.includes('gota.io') || url.includes('googleapis.com') || url.includes('firebase')) try { this.timeout = NET_TIMEOUT_MS; } catch (_) {}
    return us !== undefined ? _oXO.call(this, m, u, a, us, pw) : a !== undefined ? _oXO.call(this, m, u, a) : _oXO.call(this, m, u);
};
XMLHttpRequest.prototype.send = function (d) {
    if (_xBlk.has(this)) return;
    return d !== undefined ? _oXS.call(this, d) : _oXS.call(this);
};
try {
    W.Worker = function (url, opts) {
        if (typeof url === 'string' && _sb(url)) return { postMessage: NOP, terminate: NOP };
        return opts !== undefined ? new _OrigWrk(url, opts) : new _OrigWrk(url);
    };
    W.Worker.prototype = _OrigWrk.prototype;
    Object.setPrototypeOf(W.Worker, _OrigWrk);
} catch (_) {}

const _origSendBeacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
try { navigator.sendBeacon = function (url, data) { if (_sb(url)) return true; return _origSendBeacon ? _origSendBeacon(url, data) : true; }; } catch (_) {}

try {
    const _conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (_conn) {
        Object.defineProperty(_conn, 'saveData', { get: () => false, configurable: true });
        try { Object.defineProperty(_conn, 'effectiveType', { get: () => '4g', configurable: true }); } catch (_) {}
        try { Object.defineProperty(_conn, 'downlink', { get: () => 10, configurable: true }); } catch (_) {}
        try { Object.defineProperty(_conn, 'rtt', { get: () => 50, configurable: true }); } catch (_) {}
    }
} catch (_) {}

const _sanitizeInput = el => {
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        const type = el.type;
        if (type !== 'password' && type !== 'hidden') {
            el.setAttribute('spellcheck', 'false');
            el.setAttribute('autocomplete', 'off');
            el.setAttribute('autocorrect', 'off');
            el.setAttribute('autocapitalize', 'off');
        }
    }
};

try {
    let _mutQueue = [];
    let _mutHead = 0;
    let _mutNodeCursor = -1;
    let _mutScheduled = false;

    const _MUT_USES_RIC = !!W.requestIdleCallback;
    const _MUT_MAX_PER_TICK      = _MUT_USES_RIC ? 200 : 60;
    const _MUT_CHUNK_CHECK_EVERY = 24;
    const _MUT_BACKLOG_CAP       = 500;
    const _MUT_COMPACT_THRESHOLD = 200;

    const _hasInputPendingAPI = !!(navigator.scheduling && typeof navigator.scheduling.isInputPending === 'function');
    const _isInputPending = _hasInputPendingAPI ? () => navigator.scheduling.isInputPending() : () => false;

    const _scheduleProcessMuts = _MUT_USES_RIC
        ? cb => W.requestIdleCallback(cb, { timeout: 100 })
        : _rAF;

    const _processMuts = (deadline) => {
        const _canCheckDeadline = deadline && typeof deadline.timeRemaining === 'function' && !deadline.didTimeout;
        const muts = _mutQueue;
        const len = muts.length;
        let processedThisTick = 0, checkCounter = 0;
        let added, n, tag, src, cls, pEl;

        outer:
        while (_mutHead < len) {
            added = muts[_mutHead].addedNodes;
            if (_mutNodeCursor < 0) _mutNodeCursor = added.length - 1;

            while (_mutNodeCursor >= 0) {
                if (processedThisTick >= _MUT_MAX_PER_TICK) break outer;
                if (++checkCounter >= _MUT_CHUNK_CHECK_EVERY) {
                    checkCounter = 0;
                    if (_isInputPending()) break outer;
                    if (_canCheckDeadline && deadline.timeRemaining() <= 1) break outer;
                }
                processedThisTick++;
                n = added[_mutNodeCursor--];

                if (n.nodeType === 3) { _queueBeautify(n); continue; }
                if (n.nodeType !== 1) continue;
                tag = n.tagName;
                if (tag !== 'SCRIPT' && tag !== 'IFRAME' && tag !== 'LINK' && tag !== 'IMG' && tag !== 'INPUT') _queueBeautify(n);
                if (tag === 'INPUT' || tag === 'TEXTAREA') { _sanitizeInput(n); continue; }
                if (tag === 'SCRIPT' || tag === 'IFRAME' || tag === 'LINK' || tag === 'IMG') {
                    src = n.src || n.href || (n.getAttribute && (n.getAttribute('src') || n.getAttribute('href')));
                    if (src && _sb(src)) { _blkEl(n); continue; }
                }
                cls = n.getAttribute ? n.getAttribute('class') : null;
                if (((n.id && n.id.indexOf('ad') !== -1) || (cls && cls.indexOf('ad') !== -1)) && n.matches && n.matches(_AD_SEL)) _blkEl(n);

                if (n.id !== 'profile-panel' && n.id !== 'leaderboard-panel' && n.id !== 'party-panel') {
                    pEl = n.parentElement;
                    if ((tag === 'DIV' && pEl && (pEl.id === 'main-left' || pEl.id === 'main-right')) || (cls && cls.indexOf('main-panel') !== -1)) {
                        if (_isAdPlaceholderText(n.textContent || '')) n.style.setProperty('display', 'none', 'important');
                    }
                }
            }
            _mutHead++;
            _mutNodeCursor = -1;
        }

        if (_sacredStyleEl && !_sacredStyleEl.isConnected) {
            const h = D.head || D.documentElement;
            if (h) { h.appendChild(_sacredStyleEl); if (_perfStyleEl) h.appendChild(_perfStyleEl); }
        }

        if (_mutHead < len) {
            if (_mutHead > _MUT_COMPACT_THRESHOLD) { _mutQueue = _mutQueue.slice(_mutHead); _mutHead = 0; }
            _mutScheduled = true;
            _scheduleProcessMuts(_processMuts);
            return;
        }

        _mutQueue = [];
        _mutHead = 0;
        _mutNodeCursor = -1;
        _mutScheduled = false;
    };

    new MutationObserver(muts => {
        for (let i = 0; i < muts.length; i++) _mutQueue.push(muts[i]);
        const unprocessed = _mutQueue.length - _mutHead;
        if (unprocessed > _MUT_BACKLOG_CAP) {
            _mutQueue = _mutQueue.slice(-_MUT_BACKLOG_CAP);
            _mutHead = 0;
            _mutNodeCursor = -1;
            _mutBacklogDropped = true;
        }
        if (!_mutScheduled) { _mutScheduled = true; _scheduleProcessMuts(_processMuts); }
    }).observe(D, { childList: true, subtree: true });
} catch (_) {}

try {
    const ckD = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
                Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
    if (ckD && ckD.set) {
        const oCKS = ckD.set;
        const CKP = ['_ga=','_gid=','_gat=','_gcl','_fbp=','_fbc=','_hjid=','ph_','mp_'];
        Object.defineProperty(D, 'cookie', {
            get: ckD.get && ckD.get.bind(D),
            set(v) { const s = typeof v === 'string' ? v : '' + v; for (let i = 0; i < CKP.length; i++) if (s.startsWith(CKP[i])) return; oCKS.call(D, s); },
            configurable: true
        });
    }
} catch (_) {}

const _preconnectedOrigins = new Map();
const _preconnectEls = new Map();
const PRECONNECT_TTL_MS = 30000;
try {
    const frag = D.createDocumentFragment();
    const hs = [
        ['//accounts.google.com','high'],['//oauth2.googleapis.com','high'],
        ['//apis.google.com','high'],['//securetoken.googleapis.com','high'],
        ['//game.gota.io','high'],['//play.gota.io','high'],
        ['//us.gota.io','auto'],['//us2.gota.io','auto'],
        ['//eu.gota.io','auto'],['//eu2.gota.io','auto'],
        ['//ap.gota.io','low'],['//sg.gota.io','low'],
        ['//br.gota.io','low'],['//kr.gota.io','low'],['//au.gota.io','low']
    ];
    for (let i = 0; i < hs.length; i++) {
        const pc = _origCE('link'); pc.rel = 'preconnect'; pc.href = hs[i][0]; pc.crossOrigin = 'anonymous';
        try { pc.fetchPriority = hs[i][1]; } catch (_) {} frag.appendChild(pc);
        const dp = _origCE('link'); dp.rel = 'dns-prefetch'; dp.href = hs[i][0]; frag.appendChild(dp);
        try { _preconnectedOrigins.set(new URL(hs[i][0], location.href).origin, _pNow()); } catch (_) {}
    }
    RL.appendChild(frag);
} catch (_) {}

const _preconnectOrigin = origin => {
    if (!origin) return;
    const now = _pNow();
    const last = _preconnectedOrigins.get(origin);
    if (last !== undefined && (now - last) < PRECONNECT_TTL_MS) return;
    _preconnectedOrigins.set(origin, now);
    try {
        const prev = _preconnectEls.get(origin);
        if (prev) {
            try { if (prev.pc && prev.pc.isConnected) _elRemove.call(prev.pc); } catch (_) {}
            try { if (prev.dp && prev.dp.isConnected) _elRemove.call(prev.dp); } catch (_) {}
        }
        const frag = D.createDocumentFragment();
        const pc = _origCE('link'); pc.rel = 'preconnect'; pc.href = origin; pc.crossOrigin = 'anonymous'; try { pc.fetchPriority = 'high'; } catch (_) {} frag.appendChild(pc);
        const dp = _origCE('link'); dp.rel = 'dns-prefetch'; dp.href = origin; frag.appendChild(dp);
        (D.head || D.documentElement).appendChild(frag);
        _preconnectEls.set(origin, { pc, dp });
    } catch (_) {}
};

const _BAD  = ['_ga','_gid','_gat','_gcl','_fbp','_fbc','_hjid','_hjSession','amplitude_','amp_','ajs_','mp_','clarity-','ph_','posthog'];
const _BAD_RX = new RegExp('^(?:' + _BAD.join('|') + ')');
const _oLSGet = Storage.prototype.getItem;
const _oLSSet = Storage.prototype.setItem;
const _oLSDel = Storage.prototype.removeItem;
Storage.prototype.setItem = function (k, v) {
    const key = typeof k === 'string' ? k : '' + k;
    if (_BAD_RX.test(key)) return;
    return _oLSSet.call(this, key, v);
};
const _wipeStorage = () => {
    try {
        const st = W.localStorage; const toDelete = []; let i = st.length;
        while (i--) {
            try {
                const k = st.key(i); if (!k) continue;
                if (_BAD_RX.test(k)) toDelete.push(k);
            } catch (_) {}
        }
        i = toDelete.length; while (i--) try { _oLSDel.call(st, toDelete[i]); } catch (_) {}
    } catch (_) {}
};
_wipeStorage();
try {
    const raw = _oLSGet.call(localStorage, 'settings');
    if (raw) { const s = JSON.parse(raw); if (s && typeof s === 'object' && s.theme !== 1) { s.theme = 1; _oLSSet.call(localStorage, 'settings', JSON.stringify(s)); } }
    else { _oLSSet.call(localStorage, 'settings', JSON.stringify({ theme: 1 })); }
} catch (_) {}

const _pCRT  = (performance.clearResourceTimings  && performance.clearResourceTimings.bind(performance))  || NOP;
const _pSRTS = (performance.setResourceTimingBufferSize && performance.setResourceTimingBufferSize.bind(performance)) || NOP;
const _pCM   = (performance.clearMarks    && performance.clearMarks.bind(performance))    || NOP;
const _pCMs  = (performance.clearMeasures && performance.clearMeasures.bind(performance)) || NOP;
try { _pSRTS(0); _pCRT(); } catch (_) {}
try {
    performance.getEntries       = () => EMPTY;
    performance.getEntriesByType = () => EMPTY;
    performance.getEntriesByName = () => EMPTY;
} catch (_) {}

let _maintPend = false, _lastPerfMaint = 0, _lastStorageMaint = 0;
const _schedMaint = () => {
    if (_maintPend) return;
    _maintPend = true;
    const _doMaint = () => {
        const now = _pNow();
        if (now - _lastPerfMaint > 5000) {
            _lastPerfMaint = now;
            try { _pSRTS(0); _pCRT(); _pCM(); _pCMs(); } catch (_) {}
        }
        if (now - _lastStorageMaint > 120000) {
            _lastStorageMaint = now;
            const _yieldFn = (W.scheduler && typeof W.scheduler.yield === 'function')
                ? W.scheduler.yield.bind(W.scheduler)
                : () => new Promise(r => _oST_(r, 0));
            _yieldFn().then(() => {
                _wipeStorage(); _maintPend = false; _oST_(_schedMaint, 5000);
            }).catch(() => {
                _wipeStorage(); _maintPend = false; _oST_(_schedMaint, 5000);
            });
            return;
        }
        _maintPend = false;
        _oST_(_schedMaint, 5000);
    };
    if (W.requestIdleCallback) W.requestIdleCallback(_doMaint, { timeout: 5000 });
    else _macrotask(_doMaint);
};
_schedMaint();

let _audioCtx = null, _audioGestureOk = false;
const _initAudio = () => {
    try {
        if (_audioCtx) { if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(NOP); else if (_audioCtx.state === 'closed') { _audioCtx = null; _initAudio(); } return; }
        const AC = W.AudioContext || W.webkitAudioContext; if (!AC) return;
        _audioCtx = new AC({ latencyHint: 'playback', sampleRate: 8000 });
        const buf = _audioCtx.createBuffer(1, _audioCtx.sampleRate, _audioCtx.sampleRate);
        const ch = buf.getChannelData(0); let i = ch.length; while (i--) ch[i] = (i & 1 ? 1 : -1);
        const src = _audioCtx.createBufferSource(); src.buffer = buf; src.loop = true;
        const gain = _audioCtx.createGain();
        gain.gain.value = 0.001;
        src.connect(gain); gain.connect(_audioCtx.destination); src.start(0);
    } catch (_) {}
};
const _suspendAudio = () => { try { if (_audioCtx && _audioCtx.state === 'running') _audioCtx.suspend(); } catch (_) {} };
const _resumeAudio = () => {
    if (!_audioGestureOk) return;
    try { if (!_audioCtx) { _initAudio(); return; } if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(NOP); else if (_audioCtx.state === 'closed') { _audioCtx = null; _initAudio(); } } catch (_) {}
};
const _onFirstGesture = () => {
    _audioGestureOk = true; _initAudio();
    try { _rEL.call(D, 'click',      _onFirstGesture, true); } catch (_) {}
    try { _rEL.call(D, 'keydown',    _onFirstGesture, true); } catch (_) {}
    try { _rEL.call(D, 'touchstart', _onFirstGesture, true); } catch (_) {}
};
_aEL.call(D, 'click',      _onFirstGesture, { capture: true, passive: true, once: true });
_aEL.call(D, 'keydown',    _onFirstGesture, { capture: true, passive: true, once: true });
_aEL.call(D, 'touchstart', _onFirstGesture, { capture: true, passive: true, once: true });

let _storagePersistDone = false;
const _requestStoragePersist = () => {
    if (_storagePersistDone) return;
    try {
        if (navigator.storage && navigator.storage.persist) {
            _storagePersistDone = true;
            navigator.storage.persist().catch(NOP);
        }
    } catch (_) {}
};

let _cvDone = false, _cvFocusTs = 0, _gameCanvas = null, _lastWSOrigin = null;
let _isNewServer = true;

function WebSocket(url, protos) {
    _isNewServer = true;
    try { _lastWSOrigin = new URL(url, location.href).origin.replace(/^wss?:/, 'https:'); _preconnectOrigin(_lastWSOrigin); } catch (_) {}
    const ws = protos !== undefined ? new _OrigWS(url, protos) : new _OrigWS(url);
    try {
        Object.defineProperty(ws, 'binaryType', { get() { return 'arraybuffer'; }, set() {}, configurable: true });
    } catch (_) { ws.binaryType = 'arraybuffer'; }

    if (DEBUG_FREEZE_LOG) {
        ws.send = function (data) {
            const ba = this.bufferedAmount;
            if (ba > 0) { const now = _pNow(); if (now - _lastBPLog > 500) { _lastBPLog = now; _logPush({ type: 'WSBackpressure', ba, t: now | 0 }); } }
            return _origWSSend.call(this, data);
        };
        ws.addEventListener('close', e => {
            _logPush({ type: 'WSClose', code: e.code, reason: e.reason || '', wasClean: e.wasClean, t: _pNow() | 0 });
        }, OPT_P);
    } else {
        Object.defineProperty(ws, 'send', { value: _origWSSend, writable: false, configurable: false });
    }

    _resumeAudio();
    _requestStoragePersist();
    return ws;
}
WebSocket.prototype = _OrigWS.prototype;
Object.setPrototypeOf(WebSocket, _OrigWS);
Object.defineProperty(WebSocket, Symbol.hasInstance, { value: o => o instanceof _OrigWS, writable: false, configurable: true });
W.WebSocket = WebSocket;

try {
    _aEL.call(W, 'online', () => {
        if (_lastWSOrigin) { _preconnectedOrigins.delete(_lastWSOrigin); _preconnectOrigin(_lastWSOrigin); }
    }, OPT_P);
} catch (_) {}

const _OrigRO = W.ResizeObserver;
if (_OrigRO) {
    W.ResizeObserver = function (cb) {
        let frame = false, queuedEntries = [];
        return new _OrigRO((entries, observer) => {
            for (let i = 0; i < entries.length; i++) queuedEntries.push(entries[i]);
            if (!frame) { frame = true; _rAF(() => { cb(queuedEntries, observer); queuedEntries = []; frame = false; }); }
        });
    };
    W.ResizeObserver.prototype = _OrigRO.prototype;
}
const _OrigIO = W.IntersectionObserver;
if (_OrigIO) {
    W.IntersectionObserver = function (cb, options) {
        let isScheduled = false, queuedEntries = [];
        return new _OrigIO((entries, observer) => {
            for (let i = 0; i < entries.length; i++) queuedEntries.push(entries[i]);
            if (!isScheduled) { isScheduled = true; _macrotask(() => { cb(queuedEntries, observer); queuedEntries = []; isScheduled = false; }); }
        }, options);
    };
    W.IntersectionObserver.prototype = _OrigIO.prototype;
}

const _origGetCtx = HTMLCanvasElement.prototype.getContext;
const _promoteCanvas = cv => {
    if (cv._apexPromoted) return;
    cv._apexPromoted = true;
    try {
        cv.style.setProperty('touch-action',        'none',                'important');
        cv.style.setProperty('user-select',         'none',                'important');
        cv.style.setProperty('overscroll-behavior', 'none',                'important');
        _aEL.call(cv, 'contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
        _aEL.call(cv, 'dragstart',   e => { e.preventDefault(); e.stopPropagation(); });
        _aEL.call(cv, 'selectstart', e => { e.preventDefault(); });
        _aEL.call(cv, 'pointerrawupdate', NOP, OPT_P);
    } catch (_) {}
};

HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === '2d') {
        if (this._cvProm2d) return _origGetCtx.call(this, type, attrs);
        this._cvProm2d = true;
        const a = attrs ? Object.assign({}, attrs) : {};
        a.alpha = true; a.desynchronized = LOW_LATENCY_CANVAS_2D; a.willReadFrequently = false; a.powerPreference = 'high-performance';
        const ctx = _origGetCtx.call(this, type, a);
        if (ctx) {
            ctx.imageSmoothingEnabled = false; ctx.shadowBlur = 0;
            try { ctx.filter = 'none'; } catch (_) {}
            try { ctx.imageSmoothingQuality = 'low'; } catch (_) {}
        }
        _promoteCanvas(this);
        return ctx;
    }
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
        if (_cvDone) return _origGetCtx.call(this, type, attrs);
        _cvDone = true;
        const a = attrs ? Object.assign({}, attrs) : {};
        a.powerPreference = 'high-performance'; a.desynchronized = LOW_LATENCY_CANVAS_WEBGL;
        a.antialias        = a.antialias       != null ? a.antialias       : false;
        a.depth            = a.depth           != null ? a.depth           : false;
        a.stencil          = a.stencil         != null ? a.stencil         : false;
        a.premultipliedAlpha = a.premultipliedAlpha != null ? a.premultipliedAlpha : true;
        a.preserveDrawingBuffer = false; a.failIfMajorPerformanceCaveat = false;
        a.xrCompatible = false;
        _gameCanvas = this;
        const cv = this;
        _promoteCanvas(cv);
        try {
            cv.tabIndex = -1; cv.style.setProperty('outline', 'none', 'important'); cv.focus({ preventScroll: true });
            _aEL.call(cv, 'mousedown', () => {
                const n = _pNow(); if (n - _cvFocusTs > 500) { _cvFocusTs = n; cv.focus({ preventScroll: true }); }
            }, OPT_P);
            _aEL.call(cv, 'pointerdown', e => {
                const n = _pNow(); if (n - _cvFocusTs > 500) { _cvFocusTs = n; cv.focus({ preventScroll: true }); }
            }, { passive: true });
            _aEL.call(cv, 'webglcontextlost', e => { e.preventDefault(); }, { passive: false });
        } catch (_) {}
        try {
            const origGetExt = this.getExtension && this.getExtension.bind(this);
            if (origGetExt) {
                this.getExtension = function (name) {
                    if (name === 'EXT_disjoint_timer_query' || name === 'EXT_disjoint_timer_query_webgl2' ||
                        name === 'WEBGL_debug_renderer_info' || name === 'WEBGL_debug_shaders') return null;
                    return origGetExt(name);
                };
            }
        } catch (_) {}
        return _origGetCtx.call(this, type, a);
    }
    return _origGetCtx.call(this, type, attrs);
};
D.addEventListener('DOMContentLoaded', () => { try { D.querySelectorAll('canvas').forEach(_promoteCanvas); } catch (_) {} }, OPT_O);

try {
    if (navigator.gpu && typeof navigator.gpu.requestAdapter === 'function') {
        const _origRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
        navigator.gpu.requestAdapter = function (opts) {
            const next = opts ? Object.assign({}, opts) : {};
            if (!next.powerPreference) next.powerPreference = 'high-performance';
            return _origRequestAdapter(next);
        };
    }
} catch (_) {}

try {
    Object.defineProperty(D, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(D, 'visibilityState', { get: () => 'visible', configurable: true });
    try {
        Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
        Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
    } catch (_) {}
} catch (_) {}
try { Document.prototype.hasFocus = function () { return true; }; } catch (_) {}

let _tabHidden = _getRealHidden(), _wakelock = null, _wakelockPending = false;
const _acqWL = async () => {
    if (_wakelockPending || _wakelock || !navigator.wakeLock) return;
    _wakelockPending = true;
    try {
        _wakelock = await navigator.wakeLock.request('screen');
        _wakelock.addEventListener('release', () => { _wakelock = null; if (!_tabHidden) _oST_(_acqWL, 1000); }, OPT_O);
    } catch (_) {
    } finally {
        _wakelockPending = false;
    }
};
D.addEventListener('visibilitychange', () => {
    const realHidden = _getRealHidden();
    if (realHidden && !_tabHidden) {
        _tabHidden = true;
        try { if (_wakelock) _wakelock.release(); } catch (_) {} _wakelock = null;
        _suspendAudio();
    } else if (!realHidden && _tabHidden) {
        _tabHidden = false; _resumeAudio(); _acqWL();
        if (_lastWSOrigin) { _preconnectedOrigins.delete(_lastWSOrigin); _preconnectOrigin(_lastWSOrigin); }
        _beautifyFullSweep();
        if (_gameCanvas) {
            _oST_(() => {
                try { if (!_tabHidden && !_inTextField) _gameCanvas.focus({ preventScroll: true }); } catch (_) {}
            }, 50);
        }
    }
});
D.addEventListener('DOMContentLoaded', _acqWL, OPT_O);
try { _aEL.call(W, 'focus', () => { if (!_wakelock) _acqWL(); }, OPT_P); } catch (_) {}

try {
    _aEL.call(W, 'pageshow', e => {
        if (!e.persisted) return;
        if (DEBUG_FREEZE_LOG) _logPush({ type: 'BFCacheRestore', t: _pNow() | 0 });
        _wakelock = null;
        _resumeAudio();
        if (!_tabHidden) { _acqWL(); }
    }, OPT_P);
} catch (_) {}

let _inTextField = false;
_aEL.call(W, 'focusin', e => {
    const target = e.target;
    if (!target) { _inTextField = false; return; }
    if (target === _gameCanvas) { _inTextField = false; return; }
    const t = target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || t === 'BUTTON' || t === 'A' || target.isContentEditable) {
        _inTextField = true;
        return;
    }
    const role = target.getAttribute ? target.getAttribute('role') : null;
    _inTextField = !!(role && (role === 'textbox' || role === 'combobox' || role === 'listbox' || role === 'searchbox'));
}, true);
_aEL.call(W, 'focusout', () => { _inTextField = false; }, true);

_aEL.call(W, 'selectstart', e => { if (!_inTextField) e.preventDefault(); }, OPT_ACTIVE_CAPTURE);
_aEL.call(W, 'contextmenu', e => { if (!_inTextField) { e.preventDefault(); e.stopPropagation(); } }, OPT_ACTIVE_CAPTURE);
_aEL.call(W, 'dragstart',   e => { if (!_inTextField) { e.preventDefault(); e.stopPropagation(); } }, OPT_ACTIVE_CAPTURE);

const _ignoredCodes = new Set([
    'Space', 'Tab',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'KeyE', 'KeyQ', 'KeyR', 'KeyF',
    'Backspace',
    'F5',
]);

_aEL.call(W, 'keydown', e => {
    if (_ignoredCodes.has(e.code) && !_inTextField && !e.isComposing &&
        !e.ctrlKey && !e.altKey && !e.metaKey) e.preventDefault();
}, OPT_ACTIVE_CAPTURE);

try { if (navigator.getBattery) navigator.getBattery = () => Promise.resolve({ charging:true, chargingTime:0, dischargingTime:Infinity, level:1.0, addEventListener:NOP, removeEventListener:NOP, dispatchEvent:()=>true }); } catch (_) {}
try {
    const _td = Object.getOwnPropertyDescriptor(Document.prototype, 'title') || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'title');
    if (_td && _td.set) {
        const _ots = _td.set; let _pt = null, _tr = 0;
        Object.defineProperty(D, 'title', {
            get: _td.get && _td.get.bind(D),
            set(v) { _pt = v; if (!_tr) _tr = _rAF(() => { _tr = 0; if (_pt !== null) { try { _ots.call(D, _pt); } catch (_) {} _pt = null; } }); },
            configurable: true
        });
    }
} catch (_) {}
try {
    if (navigator.locks && navigator.locks.request) {
        const _lockName = 'gota_fun_v' + SCRIPT_VERSION.replace(/\./g, '_') + '_singleton';
        navigator.locks.request(_lockName, { mode: 'exclusive' }, () => new Promise(() => {}));
    }
} catch (_) {}

D.addEventListener('DOMContentLoaded', () => {
    try {
        D.querySelectorAll('input, textarea').forEach(_sanitizeInput);
    } catch (_) {}
}, OPT_O);

const _injectStyles = () => {
    try {
        const head = D.head || D.documentElement;
        const frag = D.createDocumentFragment();
        const pc1 = _origCE('link'); pc1.rel = 'preconnect'; pc1.href = 'https://fonts.googleapis.com'; frag.appendChild(pc1);
        const pc2 = _origCE('link'); pc2.rel = 'preconnect'; pc2.href = 'https://fonts.gstatic.com'; pc2.crossOrigin = 'anonymous'; frag.appendChild(pc2);
        const fontLink = _origCE('link');
        fontLink.rel = 'stylesheet';
        fontLink.href = 'https://fonts.googleapis.com/css2?family=Karla:wght@400;700&display=swap';
        fontLink.id = '_apex_font';
        fontLink.media = 'print';
        fontLink.onload = function () { this.onload = null; this.media = 'all'; };
        frag.appendChild(fontLink);
        head.insertBefore(frag, head.firstChild);
    } catch (_) {}

    const sacredStyle = _origCE('style');
    sacredStyle.id = '_apex_sacred';
    sacredStyle.textContent = `
        body {
            font-family: 'Karla', sans-serif !important;
            cursor: url("data:image/svg+xml;charset=utf-8,%3Csvg width='32' height='32' viewBox='0 0 32 32' xmlns='http://www.w3.org/2000/svg'%3E%3Cline x1='16' y1='2' x2='16' y2='30' stroke='%238a2be2' stroke-width='2' stroke-linecap='round'/%3E%3Cline x1='2' y1='16' x2='30' y2='16' stroke='%238a2be2' stroke-width='2' stroke-linecap='round'/%3E%3Ccircle cx='16' cy='16' r='3' fill='%23d76d77' stroke='%233a1c71' stroke-width='1'/%3E%3C/svg%3E") 16 16, crosshair !important;
        }
        .logo, #logo, img[src*="logo"] {
            display: none !important;
        }
        .xp-meter {
            background: #050510 !important; border: 1px solid rgba(88, 12, 133, 0.4) !important;
            border-radius: 5px !important; overflow: hidden !important; position: relative !important; height: 12px !important;
        }
        .xp-meter > span {
            position: relative !important; display: block !important; height: 100% !important;
            background: linear-gradient(90deg, #020111, #3a1c71, #d76d77, #3a1c71, #020111) !important;
            background-size: 200% 100% !important; animation: nebulaMove 6s linear infinite !important;
        }
        .xp-meter > span::before {
            content: "" !important; position: absolute !important; top: 0; left: 0; right: 0; bottom: 0 !important;
            background-image: radial-gradient(1px 1px at 10% 20%, #fff, transparent), radial-gradient(1.5px 1.5px at 40% 50%, #fff, transparent), radial-gradient(1px 1px at 80% 10%, #fff, transparent) !important;
            background-size: 100px 100% !important; animation: starsMove 3s linear infinite !important; opacity: 0.6 !important;
        }
        @keyframes nebulaMove { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
        @keyframes starsMove { from { background-position: 0 0; } to { background-position: -100px 0; } }

        #score-panel, #party-panel {
            background: rgba(0, 0, 0, 0.01) !important; border: 1px solid rgba(255, 255, 255, 0.02) !important;
            box-shadow: none !important; backdrop-filter: blur(0px) !important;
        }
        #minimap-panel, #minimap, .minimap, #mini-map, .mini-map,
        [id*="minimap" i], [class*="minimap" i] {
            background: rgba(0, 0, 0, 0.005) !important; border: 1px solid rgba(255, 255, 255, 0.02) !important;
            box-shadow: none !important; backdrop-filter: blur(0px) !important;
            opacity: 0.65 !important;
        }

        #leaderboard-panel {
            font-family: 'Karla', sans-serif !important;
            background: rgba(8, 4, 18, 0.55) !important;
            border: 1px solid rgba(138, 43, 226, 0.35) !important;
            box-shadow: 0 0 20px rgba(138, 43, 226, 0.25), inset 0 0 15px rgba(215, 109, 119, 0.08) !important;
            backdrop-filter: blur(8px) !important;
        }
        #leaderboard-panel * {
            font-family: 'Karla', sans-serif !important;
        }

        .main-panel {
            background: rgba(8, 4, 18, 0.88) !important;
            border: 1px solid rgba(138, 43, 226, 0.35) !important;
            box-shadow: 0 0 35px rgba(138, 43, 226, 0.25), inset 0 0 20px rgba(215, 109, 119, 0.12) !important;
            backdrop-filter: blur(12px) !important;
            border-radius: 8px !important;
            padding: 24px !important;
            transition: border-color 0.4s ease, box-shadow 0.4s ease,
                        opacity 0.2s ease, transform 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important;
            align-self: flex-start !important;
            animation: apexMenuIn 0.28s cubic-bezier(0.16, 1, 0.3, 1) both;
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            contain: layout paint !important;
        }
        .main-panel:hover {
            border-color: rgba(138, 43, 226, 0.6) !important;
            box-shadow: 0 0 45px rgba(138, 43, 226, 0.45), inset 0 0 25px rgba(215, 109, 119, 0.18) !important;
        }
        .apex-menu-row {
            display: flex !important;
            align-items: flex-start !important;
            gap: 20px !important;
        }
        .apex-left-col {
            display: flex !important;
            flex-direction: column !important;
            gap: 4px !important;
        }
        .apex-menu-grid {
            display: grid !important;
            grid-template-columns: 1fr 1fr !important;
            gap: 8px !important;
        }
        .apex-menu-grid > * {
            width: 100% !important;
            min-width: 0 !important;
            box-sizing: border-box !important;
            padding: 10px 8px !important;
            min-height: 40px !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            text-align: center !important;
            line-height: 1.15 !important;
            white-space: normal !important;
            overflow: visible !important;
            background-color: rgba(255, 255, 255, 0.02) !important;
            border: 1px solid rgba(255, 255, 255, 0.05) !important;
            border-radius: 6px !important;
        }
        .apex-extra-grid {
            display: grid !important;
            grid-template-columns: 1fr 1fr !important;
            gap: 6px !important;
            margin-top: 4px !important;
        }
        .apex-extra-grid > * {
            width: 100% !important;
            min-width: 0 !important;
            margin: 0 !important;
            box-sizing: border-box !important;
            box-shadow: none !important;
            padding: 10px 8px !important;
            min-height: 40px !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            text-align: center !important;
            line-height: 1.15 !important;
            white-space: normal !important;
            font-size: 13px !important;
            border-radius: 6px !important;
            background-color: rgba(255, 255, 255, 0.02) !important;
            border: 1px solid rgba(255, 255, 255, 0.05) !important;
            cursor: pointer !important;
            overflow: hidden !important;
            position: relative !important;
            contain: layout style paint !important;
            transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, transform 0.12s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
        }
        .apex-extra-grid > *:hover {
            background-color: rgba(138, 43, 226, 0.4) !important;
            border-color: #8a2be2 !important;
            box-shadow: 0 0 10px rgba(138, 43, 226, 0.5) !important;
            transform: translateY(-1px) !important;
        }
        .apex-extra-grid > *:active {
            transform: scale(0.96) !important;
            transition-duration: 0.08s !important;
        }
        .main-panel input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
        .main-panel select,
        .main-panel textarea {
            background: rgba(18, 9, 32, 0.75) !important;
            border: 1px solid rgba(138, 43, 226, 0.35) !important;
            color: #eee !important;
            border-radius: 6px !important;
            padding: 10px !important;
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
            box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.6) !important;
        }
        .main-panel input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):focus,
        .main-panel select:focus,
        .main-panel textarea:focus {
            border-color: #d76d77 !important;
            box-shadow: 0 0 12px rgba(215, 109, 119, 0.55), inset 0 0 6px rgba(0, 0, 0, 0.6) !important;
            outline: none !important;
        }
        .main-panel input[type="checkbox"], .main-panel input[type="radio"] {
            accent-color: #8a2be2 !important;
        }

        #chat-container { background: rgba(0, 0, 0, 0.1) !important; border-radius: 4px !important; }
        #chat-input { background: rgba(0, 0, 0, 0.05) !important; border: 1px solid rgba(255, 255, 255, 0.02) !important; color: #eee !important; }
        .gota-btn, button {
            background-color: rgba(255, 255, 255, 0.02) !important; border: 1px solid rgba(255, 255, 255, 0.05) !important;
            color: #eee !important;
            transition: background-color 0.2s ease, border-color 0.2s ease,
                        box-shadow 0.2s ease, transform 0.12s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
        }
        .gota-btn:hover, button:hover, .server-table tr:hover {
            background-color: rgba(138, 43, 226, 0.4) !important; border-color: #8a2be2 !important;
            box-shadow: 0 0 10px rgba(138, 43, 226, 0.5) !important; cursor: pointer !important;
        }
        .gota-btn:hover, button:hover {
            transform: translateY(-1px) !important;
        }
        .gota-btn:active, button:active {
            transform: scale(0.96) !important;
            transition-duration: 0.08s !important;
        }
        .main-panel button,
        .main-panel .gota-btn {
            background-image: linear-gradient(90deg, #3a1c71, #8a2be2, #d76d77, #8a2be2, #3a1c71) !important;
            background-size: 200% 100% !important;
            -webkit-background-clip: text !important;
            background-clip: text !important;
            color: transparent !important;
            -webkit-text-fill-color: transparent !important;
            animation: nebulaMove 6s linear infinite !important;
            font-weight: 700 !important;
        }
        .main-panel img + * {
            background-image: linear-gradient(90deg, #3a1c71, #8a2be2, #d76d77, #8a2be2, #3a1c71) !important;
            background-size: 200% 100% !important;
            -webkit-background-clip: text !important;
            background-clip: text !important;
            color: transparent !important;
            -webkit-text-fill-color: transparent !important;
            animation: nebulaMove 6s linear infinite !important;
            font-weight: 700 !important;
        }
        .main-panel img {
            animation: apexAvatarBreath 4s ease-in-out infinite !important;
        }
        @keyframes apexAvatarBreath {
            0%, 100% { transform: scale(1); }
            50%      { transform: scale(1.015); }
        }
        .server-table {
            contain: paint !important;
            background: rgba(10, 5, 20, 0.45) !important;
            border-radius: 6px !important;
        }
        :has(> .server-table) {
            background: rgba(8, 4, 18, 0.88) !important;
            border: 1px solid rgba(138, 43, 226, 0.35) !important;
            box-shadow: 0 0 35px rgba(138, 43, 226, 0.25), inset 0 0 20px rgba(215, 109, 119, 0.12) !important;
            backdrop-filter: blur(12px) !important;
            border-radius: 8px !important;
            transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important;
        }
        .server-table td:first-child {
            background-image: linear-gradient(90deg, #3a1c71, #8a2be2, #d76d77, #8a2be2, #3a1c71) !important;
            background-size: 200% 100% !important;
            -webkit-background-clip: text !important;
            background-clip: text !important;
            color: transparent !important;
            -webkit-text-fill-color: transparent !important;
            animation: nebulaMove 6s linear infinite !important;
            font-weight: 700 !important;
        }
        .server-table tr.selected, .server-table tr.active, .server-table tr.is-active,
        .server-table tr.is-selected, .server-table tr.current, .server-table tr.highlighted,
        .server-table tr.row-selected, .server-table tr.active-row, .server-table tr.selected-row,
        .server-table tr[aria-selected="true"], .server-table tr[data-selected="true"] {
            background: linear-gradient(90deg, rgba(58, 28, 113, 0.55), rgba(138, 43, 226, 0.55), rgba(215, 109, 119, 0.35)) !important;
            box-shadow: inset 0 0 12px rgba(138, 43, 226, 0.4) !important;
            color: #fff !important;
        }
        .server-table tr.selected td, .server-table tr.active td, .server-table tr.is-active td,
        .server-table tr.is-selected td, .server-table tr.current td, .server-table tr.highlighted td,
        .server-table tr.row-selected td, .server-table tr.active-row td, .server-table tr.selected-row td,
        .server-table tr[aria-selected="true"] td, .server-table tr[data-selected="true"] td {
            background: transparent !important;
            color: #fff !important;
        }
        .apex-portal-label {
            display: inline-block !important;
            background: linear-gradient(90deg, #3a1c71, #8a2be2, #d76d77, #8a2be2, #3a1c71) !important;
            background-size: 200% 100% !important;
            -webkit-background-clip: text !important;
            background-clip: text !important;
            color: transparent !important;
            -webkit-text-fill-color: transparent !important;
            font-weight: 700 !important;
            animation: nebulaMove 6s linear infinite, apexPortalAura 2s ease-in-out infinite !important;
        }
        @keyframes apexPortalAura {
            0%, 100% { text-shadow: 0 0 10px rgba(138, 43, 226, 0.5),  0 0 20px rgba(215, 109, 119, 0.25); }
            50%      { text-shadow: 0 0 18px rgba(138, 43, 226, 0.85), 0 0 34px rgba(215, 109, 119, 0.5); }
        }
        #main-left-ad, #main-right-ad, #main-bottom-ad, #chat-container-ads, #main-bottom,
        .ad-container, #ad-container, .advertisement, #ad-block, .adblock-container,
        #onesignal-bell-container, .main-bottom-links, .social-media-box, .bottom-right-panel,
        [id^="div-gpt-ad"], [id^="google_ads"], [id*="-ad-container"] {
            display: none !important; width: 0 !important; height: 0 !important;
            pointer-events: none !important; opacity: 0 !important;
        }

        .apex-linesplit-fixed {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            background: rgba(10, 4, 20, 0.85) !important;
            border: 1px solid rgba(0, 255, 255, 0.4) !important;
            box-shadow: 0 0 15px rgba(0, 255, 255, 0.3), inset 0 0 10px rgba(0, 255, 255, 0.1) !important;
            border-radius: 8px !important;
            padding: 8px 16px !important;
            color: #0ff !important;
            font-size: 15px !important;
            font-family: 'Karla', sans-serif !important;
            font-weight: 700 !important;
            letter-spacing: 2px !important;
            text-transform: uppercase !important;
            backdrop-filter: blur(10px) !important;
            animation: apexPulseCyan 1.5s infinite alternate !important;
            white-space: nowrap !important;
            z-index: 9999 !important;
            text-shadow: 0 0 8px rgba(0,255,255,0.6) !important;
        }
        .apex-linesplit-fixed[style*="display: none"],
        .apex-linesplit-fixed[style*="display:none"],
        .apex-linesplit-fixed.hidden { display: none !important; }

        .apex-linesplit-fixed::before {
            content: '';
            display: inline-block;
            width: 20px; height: 20px;
            margin-right: 8px;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2300ffff' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cline x1='12' y1='8' x2='12' y2='16'/%3E%3Cline x1='8' y1='12' x2='16' y2='12'/%3E%3C/svg%3E");
            background-size: cover;
            animation: apexPulseIcon 1.5s infinite alternate !important;
        }
        .apex-linesplit-fixed::after {
            content: 'LINE SPLIT';
        }

        @keyframes apexPulseCyan {
            0% { box-shadow: 0 0 10px rgba(0, 255, 255, 0.2), inset 0 0 5px rgba(0, 255, 255, 0.1); }
            100% { box-shadow: 0 0 25px rgba(0, 255, 255, 0.5), inset 0 0 15px rgba(0, 255, 255, 0.3); border-color: rgba(0, 255, 255, 0.8) !important; }
        }
        @keyframes apexPulseIcon {
            0% { transform: scale(0.95); opacity: 0.8; }
            100% { transform: scale(1.1); opacity: 1; }
        }

        .apex-timer-container, .apex-timer-container * {
            border: none !important;
        }
        .apex-timer-container {
            background: rgba(12, 6, 24, 0.55) !important;
            box-shadow: 0 0 20px rgba(138, 43, 226, 0.3), inset 0 0 12px rgba(215, 109, 119, 0.15) !important;
            border-radius: 8px !important;
            padding: 8px 18px !important;
            color: #fff !important;
            font-size: 16px !important;
            font-family: 'Karla', sans-serif !important;
            font-weight: 700 !important;
            letter-spacing: 1.5px !important;
            backdrop-filter: blur(12px) !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
            z-index: 9999 !important;
            text-shadow: 0 0 5px rgba(255,255,255,0.5) !important;
        }
        .apex-timer-container[style*="display: none"],
        .apex-timer-container[style*="display:none"],
        .apex-timer-container.hidden { display: none !important; }

        .apex-timer-container:hover {
            box-shadow: 0 0 30px rgba(215, 109, 119, 0.5), inset 0 0 15px rgba(138, 43, 226, 0.3) !important;
            transform: translateY(-2px);
        }

        .apex-timer-icon-fixed {
            display: inline-block !important;
            width: 20px !important; height: 20px !important;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23d76d77' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8'/%3E%3Cpath d='M21 3v5h-5'/%3E%3C/svg%3E") !important;
            background-size: cover !important;
            background-position: center !important;
            background-repeat: no-repeat !important;
            color: transparent !important;
            font-size: 0 !important;
            animation: apexSpin 2.5s linear infinite !important;
            margin-right: 10px !important;
        }

        .apex-timer-no-i-tag::before {
            content: '';
            display: inline-block !important;
            width: 20px !important; height: 20px !important;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23d76d77' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8'/%3E%3Cpath d='M21 3v5h-5'/%3E%3C/svg%3E") !important;
            background-size: cover !important;
            background-position: center !important;
            animation: apexSpin 2.5s linear infinite !important;
            margin-right: 10px !important;
        }
    `;

    const perfStyle = _origCE('style');
    perfStyle.id = '_apex_perf';
    perfStyle.textContent = `
        body { overscroll-behavior: none !important; }
        canvas {
            image-rendering: auto !important;
        }

        canvas {
            transform: translateZ(0) !important;
        }

        .apex-timer-container, .apex-linesplit-fixed {
            contain: layout style !important;
        }

        .xp-meter > span {
            contain: paint !important;
        }

        #chat-container, #score-panel, #party-panel,
        #minimap-panel, #minimap, .minimap, #mini-map, .mini-map,
        [id*="minimap" i], [class*="minimap" i] {
            contain: content !important;
        }
        .main-panel img + *, .server-table td:first-child {
            contain: paint !important;
        }

        /* v3.35.0: pausa las animaciones "infinite" que viven DENTRO de los
           paneles del menú principal en cuanto _updateInGameState detecta
           que ese menú dejó de estar realmente visible (jugando en partida).
           animation-play-state:paused congela el frame actual sin tocar
           ningún color/posición -- en cuanto el menú vuelve a verse,
           _updateInGameState saca la clase y las animaciones retoman solas
           desde donde quedaron (con "infinite" no hay estado que perder).
           No se pausa apexMenuIn (la entrada del panel, ya termina sola) ni
           nada del loader de conexión (ese ya se autooculta por su cuenta). */
        html.apex-in-game .xp-meter > span,
        html.apex-in-game .xp-meter > span::before,
        html.apex-in-game .apex-portal-label,
        html.apex-in-game .main-panel img,
        html.apex-in-game .main-panel button,
        html.apex-in-game .main-panel .gota-btn,
        html.apex-in-game .main-panel img + *,
        html.apex-in-game .server-table td:first-child {
            animation-play-state: paused !important;
        }

        #apex-bh-rotor {
            transform-origin: 110px 110px;
            animation: apexBHSpin 7s linear infinite;
            contain: paint !important;
        }
        #apex-bh-outerglow {
            animation: apexPulse 2.4s ease-in-out infinite;
            contain: paint !important;
        }
        @keyframes apexBHSpin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
        }
        @keyframes apexMenuIn {
            0%   { opacity: 0; transform: translateY(8px) scale(0.98); }
            100% { opacity: 1; transform: translateY(0)   scale(1); }
        }

        #apex-loader {
            position: fixed !important; top: 0 !important; left: 0 !important;
            width: 100vw !important; height: 100vh !important;
            background: radial-gradient(circle at center, #110423 0%, #01000b 100%) !important;
            z-index: 9999999 !important;
            display: flex !important; flex-direction: column !important;
            justify-content: center !important; align-items: center !important;
            transition: opacity 0.6s ease, visibility 0.6s ease !important; pointer-events: none !important;
            overflow: hidden !important;
            contain: layout paint !important;
        }
        #apex-loader::before {
            content: "" !important;
            position: absolute !important;
            top: -50% !important; left: -50% !important;
            width: 200% !important; height: 200% !important;
            background-image:
                radial-gradient(1.5px 1.5px at 50px 100px, #fff, rgba(0,0,0,0)),
                radial-gradient(2px 2px at 120px 200px, #d76d77, rgba(0,0,0,0)),
                radial-gradient(1.5px 1.5px at 200px 280px, #8a2be2, rgba(0,0,0,0)),
                radial-gradient(2px 2px at 280px 60px, #fff, rgba(0,0,0,0)),
                radial-gradient(2.5px 2.5px at 350px 380px, #fff, rgba(0,0,0,0)),
                radial-gradient(1px 1px at 400px 150px, #d76d77, rgba(0,0,0,0));
            background-size: 400px 400px !important;
            animation: spaceStars 200s linear infinite !important;
            opacity: 0.65 !important;
            pointer-events: none !important;
        }
        #apex-loader::after {
            content: "" !important;
            position: absolute !important;
            width: 550px !important; height: 550px !important;
            background: radial-gradient(circle, rgba(138, 43, 226, 0.18) 0%, rgba(215, 109, 119, 0.08) 50%, rgba(0,0,0,0) 70%) !important;
            filter: blur(80px) !important;
            animation: nebulaPulse 14s ease-in-out infinite alternate !important;
            pointer-events: none !important;
        }

        .apex-loader-text {
            margin-top: 30px !important; color: #fff !important; font-size: 20px !important;
            font-weight: 700 !important; letter-spacing: 6px !important; text-transform: uppercase !important;
            text-shadow: 0 0 15px rgba(138, 43, 226, 0.8), 0 0 2px #fff !important;
            animation: apexPulse 1.8s ease-in-out infinite !important;
            z-index: 10 !important;
        }

        @keyframes spaceStars {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        @keyframes nebulaPulse {
            0% { transform: scale(1) translate(0, 0); opacity: 0.5; }
            50% { transform: scale(1.25) translate(30px, -20px); opacity: 0.85; }
            100% { transform: scale(1) translate(-30px, 20px); opacity: 0.5; }
        }
        @keyframes apexSpin  { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        @keyframes apexPulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; transform: scale(1.05); } }
    `;

    const currentHead = D.head || D.documentElement;
    if (currentHead) { currentHead.appendChild(sacredStyle); currentHead.appendChild(perfStyle); }
    _sacredStyleEl = sacredStyle; _perfStyleEl = perfStyle;
};
_injectStyles();

const _initLoader = () => {
    try {
        const loader = _origCE('div'); loader.id = 'apex-loader';
        loader.innerHTML = `
<svg viewBox="0 0 220 220" width="180" height="180" style="overflow:visible">
  <defs>
    <filter id="apexBHBlur" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="9"/>
    </filter>
    <radialGradient id="apexBHOuterGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%"  stop-color="#d76d77" stop-opacity="0.55"/>
      <stop offset="60%" stop-color="#8a2be2" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#3a1c71" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="apexBHRing" gradientUnits="userSpaceOnUse" x1="0" y1="110" x2="220" y2="110">
      <stop offset="0%"   stop-color="#3a1c71"/>
      <stop offset="25%"  stop-color="#a83279"/>
      <stop offset="50%"  stop-color="#ff5f96"/>
      <stop offset="75%"  stop-color="#a83279"/>
      <stop offset="100%" stop-color="#3a1c71"/>
    </linearGradient>
    <linearGradient id="apexBHPhoton" gradientUnits="userSpaceOnUse" x1="0" y1="110" x2="220" y2="110">
      <stop offset="0%"   stop-color="#3a1c71" stop-opacity="0.7"/>
      <stop offset="50%"  stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#3a1c71" stop-opacity="0.7"/>
    </linearGradient>
  </defs>

  <circle id="apex-bh-outerglow" cx="110" cy="110" r="118" fill="url(#apexBHOuterGlow)" filter="url(#apexBHBlur)"/>

  <g id="apex-bh-rotor">
    <ellipse cx="110" cy="110" rx="140" ry="40" fill="none" stroke="url(#apexBHRing)" stroke-width="10" opacity="0.22" filter="url(#apexBHBlur)"/>
    <circle cx="110" cy="110" r="95" fill="none" stroke="url(#apexBHRing)" stroke-width="26" opacity="0.95"/>
    <circle cx="110" cy="110" r="70" fill="none" stroke="url(#apexBHPhoton)" stroke-width="4" opacity="0.9"/>
  </g>

  <circle cx="110" cy="110" r="58" fill="#020103"/>
  <circle cx="110" cy="110" r="100" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
</svg>
<div class="apex-loader-text" id="apex-loader-txt">INICIANDO...</div>`;
        const attachLoader = () => { if (D.body) { D.body.appendChild(loader); } else { _rAF(attachLoader); } };
        attachLoader();
        let loaderTimeout;
        const hideLoader = () => {
            if (!loader) return;
            loader.style.opacity = '0';
            loader.style.visibility = 'hidden';
            setTimeout(() => { if (loader) loader.style.display = 'none'; }, 600);
        };
        const showLoader = (text, duration) => {
            if (!loader) return;
            const textElement = D.getElementById('apex-loader-txt');
            if (textElement) textElement.innerText = text;
            loader.style.display = 'flex';
            setTimeout(() => {
                if (loader) {
                    loader.style.opacity = '1';
                    loader.style.visibility = 'visible';
                }
            }, 10);
            clearTimeout(loaderTimeout); if (duration) loaderTimeout = setTimeout(hideLoader, duration);
        };
        setTimeout(hideLoader, 2500);
        const _handleRealJoin = () => { if (_isNewServer) { showLoader('CONECTANDO...', 1500); _isNewServer = false; } };
        D.addEventListener('click', (e) => { const isPlayBtn = e.target.closest('#btn-play, .play-btn, button[id*="play" i], button[class*="play" i]'); if (isPlayBtn) _handleRealJoin(); });
        D.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const activeTag = D.activeElement ? D.activeElement.tagName.toLowerCase() : ''; if (activeTag !== 'input' && activeTag !== 'textarea') _handleRealJoin(); } });
        D.addEventListener('dblclick', (e) => { const isServerRow = e.target.closest('.server-table tr, .server-row, #server-list tr'); if (isServerRow) setTimeout(_handleRealJoin, 50); });
    } catch (_) {}
};
_initLoader();

_aEL.call(D, 'DOMContentLoaded', () => {
    try {
        const h = D.head; if (!h) return;
        const s = D.getElementById('_apex_sacred'), p = D.getElementById('_apex_perf'), f = D.getElementById('_apex_font');
        if (s && s.parentNode !== h) h.appendChild(s);
        if (p && p.parentNode !== h) h.appendChild(p);
        if (f && f.parentNode !== h) h.insertBefore(f, h.firstChild);
    } catch (_) {}
}, OPT_O);

D.addEventListener('DOMContentLoaded', () => {
    _requestStoragePersist();
}, OPT_O);

const _nukeAdPanels = () => {
    try {
        const adNodes = D.querySelectorAll(_AD_SEL);
        let i = adNodes.length;
        while (i--) { try { _elRemove.call(adNodes[i]); } catch (_) {} }
        const containers = D.querySelectorAll('#main-left > div, #main-right > div, .main-panel');
        i = containers.length; let el;
        while (i--) {
            el = containers[i];
            if (!el || el.id === 'profile-panel' || el.id === 'leaderboard-panel' || el.id === 'party-panel') continue;
            if (_isAdPlaceholderText(el.textContent || '')) el.style.setProperty('display', 'none', 'important');
        }
    } catch (_) {}
};
D.addEventListener('DOMContentLoaded', _nukeAdPanels, OPT_O);

const _beautifyWatched = new Map();
const _watchBeautifyNode = (node) => {
    if (_beautifyWatched.has(node)) return;
    try {
        const obs = new MutationObserver(() => { _queueBeautify(node); });
        obs.observe(node, { characterData: true });
        _beautifyWatched.set(node, obs);
    } catch (_) {}
};

const _pruneBeautifyWatchers = () => {
    _beautifyWatched.forEach((obs, node) => {
        if (!node.isConnected) { obs.disconnect(); _beautifyWatched.delete(node); }
    });
};

const _closestMainPanel = (el) => {
    while (el && el !== D.body) {
        if (el.classList && el.classList.contains('main-panel')) return el;
        el = el.parentElement;
    }
    return null;
};

let _apexProfilePanel = null;
let _apexBuildPanel = null;
let _apexMenuAssembled = false;
const _tryAssembleMenuLayout = () => {
    if (_apexMenuAssembled || !_apexProfilePanel || !_apexBuildPanel) return;
    const buildParent = _apexBuildPanel.parentElement;
    if (!buildParent) return;
    _apexMenuAssembled = true;

    const profileOldParent = _apexProfilePanel.parentElement;

    const wrapper = D.createElement('div');
    wrapper.className = 'apex-left-col';
    buildParent.insertBefore(wrapper, _apexBuildPanel);
    wrapper.appendChild(_apexProfilePanel);
    wrapper.appendChild(_apexBuildPanel);

    if (profileOldParent && profileOldParent !== buildParent && profileOldParent !== wrapper && profileOldParent.children.length === 0) {
        profileOldParent.style.setProperty('display', 'none', 'important');
    }
};

let _apexOptionsBtn = null, _apexHotkeysBtn = null, _apexThemeBtn = null, _apexCellPanelBtn = null;
let _apexExtraGridAssembled = false;
const _tryAssembleExtraGrid = () => {
    if (_apexExtraGridAssembled) return;
    if (!_apexOptionsBtn || !_apexHotkeysBtn || !_apexThemeBtn || !_apexCellPanelBtn) return;
    const anchorParent = _apexOptionsBtn.parentElement;
    if (!anchorParent) return;
    _apexExtraGridAssembled = true;

    const btns = [_apexOptionsBtn, _apexHotkeysBtn, _apexThemeBtn, _apexCellPanelBtn];
    const oldParents = btns.map(b => b.parentElement);

    const wrapper = D.createElement('div');
    wrapper.className = 'apex-extra-grid';
    anchorParent.insertBefore(wrapper, _apexOptionsBtn);
    btns.forEach(b => wrapper.appendChild(b));

    oldParents.forEach(p => {
        if (p && p !== wrapper && p !== anchorParent && p.isConnected && p.children.length === 0) {
            p.style.setProperty('display', 'none', 'important');
        }
    });
};

// v3.35.0: "¿el menú principal está realmente visible ahora?" -- offsetParent
// vuelve null cuando el elemento (o cualquier ancestro) tiene display:none,
// pero NO cuando solo tiene opacity:0 o visibility:hidden, por eso se suma el
// chequeo de getComputedStyle acá al lado. _apexBuildPanel/_apexProfilePanel
// ya existen como refs (ver _tryAssembleMenuLayout más arriba) -- se reusan,
// no hace falta un querySelector nuevo cada vez.
const _isMenuPanelVisible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.offsetParent === null) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
};
let _apexInGame = false;
const _updateInGameState = () => {
    // Antes de tener los refs del menú (recién cargó la página) no se declara
    // "en partida" -- eso dejaría las animaciones pausadas desde el arranque
    // sin ninguna señal real de que el menú se ocultó.
    if (!_apexBuildPanel && !_apexProfilePanel) return;
    const menuVisible = _isMenuPanelVisible(_apexBuildPanel) || _isMenuPanelVisible(_apexProfilePanel);
    const nowInGame = !menuVisible;
    if (nowInGame !== _apexInGame) {
        _apexInGame = nowInGame;
        try { D.documentElement.classList.toggle('apex-in-game', _apexInGame); } catch (_) {}
    }
};

const _beautifyProcessTextNode = (node) => {
    const val = node.nodeValue;
    if (!val) return;

    if (val.includes('arrow_range')) {
        const parent = node.parentElement;
        if (parent && !parent.classList.contains('apex-linesplit-fixed')) {
            parent.classList.add('apex-linesplit-fixed');
            node.nodeValue = val.replace('arrow_range', '');

            parent.style.color = '';
            parent.style.border = '';
            parent.style.background = '';
        } else if (parent) {
            node.nodeValue = val.replace('arrow_range', '');
        }
        _watchBeautifyNode(node);
        return;
    }
    if (val.includes('refresh')) {
        const parent = node.parentElement;
        if (parent && !parent.classList.contains('apex-timer-icon-fixed') && !parent.classList.contains('apex-timer-container')) {
            if (parent.tagName === 'I' || parent.classList.contains('material-icons')) {
                parent.classList.add('apex-timer-icon-fixed');
                node.nodeValue = val.replace('refresh', '');

                let container = parent.parentElement;
                if (container && container.tagName === 'SPAN') container = container.parentElement;
                if (container && container !== D.body) {
                    container.classList.add('apex-timer-container');
                    container.style.background = '';
                    container.style.border = '';
                    container.style.boxShadow = '';
                }
            } else {
                parent.classList.add('apex-timer-container');
                parent.classList.add('apex-timer-no-i-tag');
                node.nodeValue = val.replace('refresh', '');
            }
        } else if (parent && (parent.classList.contains('apex-timer-icon-fixed') || parent.classList.contains('apex-timer-container'))) {
            node.nodeValue = val.replace('refresh', '');
        }
        _watchBeautifyNode(node);
        return;
    }
    if (val.includes('Camlan Build')) {
        node.nodeValue = val.replace('Camlan Build', 'Funkiid Build');
        return;
    }

    if (val.length > 24) return;
    const trimmed = val.trim();

    switch (trimmed) {
        case 'Servers': {
            const btn = node.parentElement;
            if (btn && !btn.classList.contains('apex-portal-btn')) {
                btn.classList.add('apex-portal-btn');
                node.nodeValue = '';
                const label = D.createElement('span');
                label.className = 'apex-portal-label';
                label.textContent = 'Servidores';
                btn.appendChild(label);
            }
            break;
        }
        case 'Play': {
            const btn = node.parentElement;
            const container = btn && btn.parentElement;
            if (container && !container.classList.contains('apex-menu-grid')) container.classList.add('apex-menu-grid');
            if (btn && !btn.classList.contains('apex-full-row')) btn.classList.add('apex-full-row');
            const panel = _closestMainPanel(container);
            if (panel && panel.parentElement && !panel.parentElement.classList.contains('apex-menu-row')) {
                panel.parentElement.classList.add('apex-menu-row');
            }
            if (panel && !_apexBuildPanel) { _apexBuildPanel = panel; _tryAssembleMenuLayout(); }
            break;
        }
        case 'Spectate': {
            const btn = node.parentElement;
            if (btn && !btn.classList.contains('apex-full-row')) btn.classList.add('apex-full-row');
            break;
        }
        case 'Options': {
            const btn = node.parentElement;
            if (btn && !_apexOptionsBtn) { _apexOptionsBtn = btn; _tryAssembleExtraGrid(); }
            break;
        }
        case 'Hotkeys': {
            const btn = node.parentElement;
            if (btn && !_apexHotkeysBtn) { _apexHotkeysBtn = btn; _tryAssembleExtraGrid(); }
            break;
        }
        case 'Theme': {
            const btn = node.parentElement;
            if (btn && !_apexThemeBtn) { _apexThemeBtn = btn; _tryAssembleExtraGrid(); }
            break;
        }
        case 'Cell Panel': {
            const btn = node.parentElement;
            if (btn && !_apexCellPanelBtn) { _apexCellPanelBtn = btn; _tryAssembleExtraGrid(); }
            break;
        }
        case 'Logout': {
            const panel = _closestMainPanel(node.parentElement);
            if (panel && panel.parentElement && !panel.parentElement.classList.contains('apex-menu-row')) {
                panel.parentElement.classList.add('apex-menu-row');
            }
            if (panel && !_apexProfilePanel) { _apexProfilePanel = panel; _tryAssembleMenuLayout(); }
            break;
        }
        case 'Expand all': {
            const panel = _closestMainPanel(node.parentElement);
            if (panel && panel.parentElement && !panel.parentElement.classList.contains('apex-menu-row')) {
                panel.parentElement.classList.add('apex-menu-row');
            }
            break;
        }
    }
};

const _beautifyTextFilter = {
    acceptNode: function (node) {
        const tag = node.parentElement ? node.parentElement.tagName : '';
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'CANVAS') {
            return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
    }
};

const _beautifyScan = (root) => {
    if (!root) return;
    if (root.nodeType === 3) {
        if (root.isConnected) _beautifyProcessTextNode(root);
        return;
    }
    if (root.nodeType !== 1 || !root.isConnected) return;
    const walker = D.createTreeWalker(root, NodeFilter.SHOW_TEXT, _beautifyTextFilter, false);
    let n;
    while ((n = walker.nextNode())) _beautifyProcessTextNode(n);
};

const _beautifyFullSweep = () => {
    try {
        _pruneBeautifyWatchers();
        _beautifyScan(D.body);
    } catch (_) {}
};

const _beautifyUI = () => {
    try {
        if (_beautifyQueue.size === 0) return;
        const nodes = _beautifyQueue; _beautifyQueue = new Set();
        nodes.forEach(_beautifyScan);
    } catch (_) {}
};

D.addEventListener('DOMContentLoaded', _beautifyFullSweep, OPT_O);

let _beautifyIdlePending = false;
let _beautifyTicks = 0;
const _BEAUTIFY_PRUNE_EVERY_TICKS = 30;
const _scheduleBeautify = () => {
    _beautifyTicks++;
    if (_tabHidden) return;

    _updateInGameState();

    const _forcedSweep = _mutBacklogDropped;

    if (_beautifyTicks % _BEAUTIFY_PRUNE_EVERY_TICKS === 0) {
        _pruneBeautifyWatchers();
    }

    if (_beautifyIdlePending || (_beautifyQueue.size === 0 && !_forcedSweep)) return;
    if (_forcedSweep) { _mutBacklogDropped = false; _beautifyQueue.clear(); }
    const _runner = _forcedSweep ? _beautifyFullSweep : _beautifyUI;
    if (W.requestIdleCallback) {
        _beautifyIdlePending = true;
        W.requestIdleCallback(() => { _beautifyIdlePending = false; _runner(); }, { timeout: 500 });
    } else {
        _runner();
    }
};
setInterval(_scheduleBeautify, 400);

try {
    Object.defineProperty(W, '__GOTA_FUN__', {
        value: Object.freeze({
            version: SCRIPT_VERSION,
            basedOn: '101.10.0',
            mode: DEBUG_FREEZE_LOG ? 'debug' : 'prod',
            loadedAt: Date.now(),
        }),
        writable: false,
        configurable: false,
        enumerable: false,
    });
} catch (_) {}
try {
    if (D.documentElement) D.documentElement.dataset.gotaFunVersion = SCRIPT_VERSION;
} catch (_) {}

})();
