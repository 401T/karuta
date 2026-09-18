/* =========================================================================
   app.js  —  メインアプリケーション v7
   -------------------------------------------------------------------------
   【修正A】CPU戦でカードが1枚も表示されない
     原因: v6 の renderCards が「オフスクリーンで生成したキャッシュHTML」を
           前提にしており、StructureRenderer がオフスクリーン要素に対して
           空を返すとキャッシュが空 → applyTo が空HTMLを注入 → 全札が白紙。
           さらに #preparing-overlay（全画面）が重なり何も見えない状態に。
     対策: ・カード枠＋名前フォールバックを「先に」DOMへ出す（絶対に見える）
           ・キャッシュヒット分だけ同期注入
           ・未取得分は旧来同様“実要素へ直接” StructureRenderer.render
           ・成功した実要素の innerHTML をスナップショットしてキャッシュ化
           ・キャッシュHTMLは img/svg を含まなければ破棄（isValid）
           ・全画面オーバーレイを廃止（描画をブロックしない）
   【修正B】タイトル画面の「構造式キャッシュ」を独立パネル化
           #title-cache-panel（進行率・件数・状態・再構築ボタン）
   【修正C】オンライン対戦（PC）でカードが巨大化
           applyCardGridLayout をオンラインでも必ず通し、
           style.css v7 の max-width / 枚数別列数で抑制
   【修正D】統計の詳細化（内部時計の反応時間など）をグラフ表示
           ProgressManager.records に計測値を蓄積し、
           ヒストグラム / KPI / ドーナツ / ポイント推移SVG /
           勝敗ストリップ / 段位特典リスト を #stats-extra に描画
   【修正E】未解放の分子は「資料」で分子名すら非表示（？？？表示）
   【修正F】アンロック条件＝誤答なしの一発正解（perfect）のみ
   【修正G】アンロック数に応じたポイント＆段位特典（rank privileges）
========================================================================= */

/* =========================================================================
   1) SettingsStore — 設定の正本
========================================================================= */
const SettingsStore = {
    KEY: 'kkaruta_settings_v2',
    DEFAULTS: {
        cardCount: 9, voiceEnabled: true, voiceSpeed: 1.0,
        readerVolume: 0.8, seVolume: 0.7, bgmVolume: 0.5
    },
    data: null,

    init() {
        this.data = Object.assign({}, this.DEFAULTS);
        try {
            if (typeof StorageManager !== 'undefined' && StorageManager.loadSettings) {
                const s = StorageManager.loadSettings();
                if (s && typeof s === 'object') {
                    if (s.cardCount !== undefined) this.data.cardCount = parseInt(s.cardCount, 10) || this.DEFAULTS.cardCount;
                    if (s.voiceEnabled !== undefined) this.data.voiceEnabled = !!s.voiceEnabled;
                    if (s.voiceSpeed !== undefined) this.data.voiceSpeed = parseFloat(s.voiceSpeed) || this.DEFAULTS.voiceSpeed;
                    if (s.readerVolume !== undefined) this.data.readerVolume = this._clamp01(s.readerVolume);
                    if (s.seVolume !== undefined) this.data.seVolume = this._clamp01(s.seVolume);
                    if (s.bgmVolume !== undefined) this.data.bgmVolume = this._clamp01(s.bgmVolume);
                    if (s.volume !== undefined && s.readerVolume === undefined) this.data.readerVolume = this._clamp01(s.volume);
                }
            }
        } catch (e) { console.warn('SettingsStore: StorageManager merge failed', e); }
        try {
            const raw = localStorage.getItem(this.KEY);
            if (raw) {
                const p = JSON.parse(raw);
                if (p && typeof p === 'object') this.data = Object.assign(this.data, p);
            }
        } catch (e) { console.warn('SettingsStore load failed:', e); }
        this.data.cardCount = this.normalizeCardCount(this.data.cardCount);
        this.save();
        return this.data;
    },

    _clamp01(v) { const n = Number(v); return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.8; },

    normalizeCardCount(v) {
        let n = parseInt(v, 10);
        if (!isFinite(n) || n <= 0) n = 9;
        const allowed = [6, 9, 12, 16];
        let best = allowed[0], bd = Infinity;
        allowed.forEach(a => { const d = Math.abs(a - n); if (d < bd) { bd = d; best = a; } });
        return best;
    },

    get(key) { if (!this.data) this.init(); return this.data[key]; },

    set(key, value) {
        if (!this.data) this.init();
        if (key === 'cardCount') value = this.normalizeCardCount(value);
        if (key === 'readerVolume' || key === 'seVolume' || key === 'bgmVolume') value = this._clamp01(value);
        if (key === 'voiceSpeed') value = parseFloat(value) || 1.0;
        if (key === 'voiceEnabled') value = !!value;
        this.data[key] = value;
        this.save();
        try {
            if (typeof StorageManager !== 'undefined' && StorageManager.updateSetting) StorageManager.updateSetting(key, value);
        } catch (e) { }
        return value;
    },

    save() {
        try { localStorage.setItem(this.KEY, JSON.stringify(this.data)); }
        catch (e) { console.warn('SettingsStore save failed:', e); }
    }
};

/* =========================================================================
   2) AudioBridge — 音量を実際に効かせるアダプタ
========================================================================= */
const AudioBridge = {
    patchedSpeak: false,

    applyAll() {
        this.apply({
            reader: SettingsStore.get('readerVolume'),
            se: SettingsStore.get('seVolume'),
            bgm: SettingsStore.get('bgmVolume')
        });
        this.applyVoiceSettings();
        this.patchSpeak();
    },

    applyVoiceSettings() {
        const A = window.AudioManager;
        if (!A) return;
        const enabled = SettingsStore.get('voiceEnabled');
        const rate = SettingsStore.get('voiceSpeed');
        try {
            if (typeof A.updateSettings === 'function') {
                A.updateSettings({ enabled: enabled, voiceEnabled: enabled, rate: rate, speed: rate, voiceSpeed: rate });
            }
        } catch (e) { }
        try { if ('enabled' in A) A.enabled = enabled; } catch (e) { }
        try { if ('rate' in A) A.rate = rate; } catch (e) { }
    },

    apply(vols) {
        const A = window.AudioManager;
        if (!A) return;
        const r = this._n(vols.reader), s = this._n(vols.se), b = this._n(vols.bgm);
        const master = Math.max(r, s, b);
        const payload = {
            readerVolume: r, voiceVolume: r, reader: r, volume: r,
            seVolume: s, sfxVolume: s, se: s, sfx: s,
            bgmVolume: b, bgm: b, musicVolume: b,
            masterVolume: master, volumes: { reader: r, se: s, bgm: b }
        };
        try { if (typeof A.updateSettings === 'function') A.updateSettings(payload); } catch (e) { }
        try {
            if (typeof A.setVolumes === 'function') {
                A.setVolumes({ reader: r, voice: r, se: s, bgm: b, music: b, master: master });
            }
        } catch (e) { }
        try {
            if (typeof A.setVolume === 'function') {
                [['reader', r], ['voice', r], ['se', s], ['sfx', s], ['bgm', b], ['music', b], ['master', master]]
                    .forEach(pair => { try { A.setVolume(pair[0], pair[1]); } catch (e2) { } });
            }
        } catch (e) { }
        try { if (typeof A.setMasterVolume === 'function') A.setMasterVolume(master); } catch (e) { }
        try {
            ['volumes', 'settings', 'config', 'volume', 'state'].forEach(k => {
                const o = A[k];
                if (o && typeof o === 'object') {
                    if ('readerVolume' in o || 'volume' in o || 'reader' in o) { o.readerVolume = r; o.voiceVolume = r; o.reader = r; o.volume = r; }
                    if ('seVolume' in o || 'sfxVolume' in o || 'se' in o) { o.seVolume = s; o.sfxVolume = s; o.se = s; o.sfx = s; }
                    if ('bgmVolume' in o || 'musicVolume' in o || 'bgm' in o) { o.bgmVolume = b; o.musicVolume = b; o.bgm = b; }
                    if ('masterVolume' in o) o.masterVolume = master;
                }
            });
            A.readerVolume = r; A.voiceVolume = r; A.seVolume = s; A.sfxVolume = s;
            A.bgmVolume = b; A.masterVolume = master;
        } catch (e) { }
        try { this._applyGainNodes(A, { reader: r, se: s, bgm: b, master: master }); } catch (e) { }
        try { this._applyAudioElements(A, { se: s, bgm: b, reader: r }); } catch (e) { }
    },

    _n(v) { const n = Number(v); return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; },

    _isGain(node) {
        try {
            return node && typeof node === 'object' && node.gain &&
                typeof node.gain.value === 'number' && typeof node.gain.setValueAtTime === 'function';
        } catch (e) { return false; }
    },

    _setGain(gainNode, value) {
        try {
            const ctx = gainNode.context;
            const now = ctx && ctx.currentTime ? ctx.currentTime : 0;
            gainNode.gain.cancelScheduledValues(now);
            gainNode.gain.setValueAtTime(this._n(value), now);
        } catch (e) {
            try { gainNode.gain.value = this._n(value); } catch (e2) { }
        }
    },

    _applyGainNodes(A, vols) {
        const matchRole = (key) => {
            const k = String(key).toLowerCase();
            if (k.indexOf('read') >= 0 || k.indexOf('voice') >= 0 || k.indexOf('speak') >= 0) return vols.reader;
            if (k.indexOf('bgm') >= 0 || k.indexOf('music') >= 0) return vols.bgm;
            if (k.indexOf('se') >= 0 || k.indexOf('sfx') >= 0 || k.indexOf('sound') >= 0 || k.indexOf('effect') >= 0) return vols.se;
            if (k.indexOf('master') >= 0 || k.indexOf('main') >= 0) return vols.master;
            return null;
        };
        const seen = new Set();
        const walk = (obj, depth) => {
            if (!obj || depth > 3 || seen.has(obj)) return;
            try { if (typeof obj === 'object') seen.add(obj); } catch (e) { }
            let keys = [];
            try { keys = Object.keys(obj); } catch (e) { return; }
            keys.forEach(k => {
                let v;
                try { v = obj[k]; } catch (e) { return; }
                if (!v || typeof v !== 'object') return;
                if (this._isGain(v)) {
                    const role = matchRole(k);
                    if (role !== null) this._setGain(v, role);
                    return;
                }
                if (depth < 3) walk(v, depth + 1);
            });
        };
        walk(A, 0);
    },

    _applyAudioElements(A, vols) {
        const matchRole = (key) => {
            const k = String(key).toLowerCase();
            if (k.indexOf('bgm') >= 0 || k.indexOf('music') >= 0) return vols.bgm;
            if (k.indexOf('read') >= 0 || k.indexOf('voice') >= 0) return vols.reader;
            return vols.se;
        };
        const seen = new Set();
        const walk = (obj, depth) => {
            if (!obj || depth > 3 || seen.has(obj)) return;
            try { if (typeof obj === 'object') seen.add(obj); } catch (e) { }
            let keys = [];
            try { keys = Object.keys(obj); } catch (e) { return; }
            keys.forEach(k => {
                let v;
                try { v = obj[k]; } catch (e) { return; }
                if (!v) return;
                const isAudio = (typeof HTMLAudioElement !== 'undefined' && v instanceof HTMLAudioElement) ||
                    (typeof v === 'object' && typeof v.play === 'function' && 'volume' in v);
                if (isAudio) { try { v.volume = this._n(matchRole(k)); } catch (e2) { } return; }
                if (typeof v === 'object' && depth < 3) walk(v, depth + 1);
            });
        };
        walk(A, 0);
    },

    patchSpeak() {
        const A = window.AudioManager;
        if (!A || this.patchedSpeak) return;
        if (typeof A.speak !== 'function') return;
        const orig = A.speak.bind(A);
        try {
            A.speak = function (text, opts) {
                const o = Object.assign({}, opts || {});
                if (o.volume === undefined) o.volume = SettingsStore.get('readerVolume');
                if (o.rate === undefined) o.rate = SettingsStore.get('voiceSpeed');
                if (!SettingsStore.get('voiceEnabled')) {
                    if (typeof o.onEnd === 'function') setTimeout(o.onEnd, 200);
                    return;
                }
                return orig(text, o);
            };
            this.patchedSpeak = true;
        } catch (e) { console.warn('speak patch failed:', e); }
    }
};

/* =========================================================================
   3) StructureCache — 構造式の事前生成＆シームレス読み出し（v7 堅牢版）
      ★「img / svg を含まないHTMLはキャッシュしない」を徹底し、
        空キャッシュによってカードが白紙になる事故を根絶する
========================================================================= */
const StructureCache = {
    mem: new Map(),
    db: null,
    DB_NAME: 'kkaruta_structure_cache',
    DB_VERSION: 2,
    STORE: 'structures',
    onProgress: null,
    offscreenBroken: false,     // オフスクリーン描画が使えない環境フラグ

    _prefetchList: [],
    _prefetchIndex: 0,
    _prefetchTotal: 0,
    _prefetchRunning: false,
    _paused: false,

    RENDER_W: 240,
    RENDER_H: 300,

    key(compound) { return String((compound && compound.id) || '').trim(); },

    /** キャッシュとして妥当か（画像実体を含むか） */
    isValid(html) {
        if (typeof html !== 'string') return false;
        if (html.length < 20) return false;
        const lower = html.toLowerCase();
        if (lower.indexOf('card-loading') >= 0 || lower.indexOf('loading-spinner') >= 0) return false;
        return lower.indexOf('<img') >= 0 || lower.indexOf('<svg') >= 0 || lower.indexOf('<canvas') >= 0;
    },

    async open() {
        if (this.db !== null) return this.db;
        this.db = await new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (!done) { done = true; resolve(v); } };
            try {
                if (!window.indexedDB) return finish(null);
                const req = window.indexedDB.open(this.DB_NAME, this.DB_VERSION);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(this.STORE)) db.createObjectStore(this.STORE, { keyPath: 'id' });
                };
                req.onsuccess = () => finish(req.result);
                req.onerror = () => finish(null);
                req.onblocked = () => finish(null);
            } catch (e) { finish(null); }
            setTimeout(() => finish(null), 3000);
        });
        return this.db;
    },

    async loadAll() {
        const db = await this.open();
        if (!db) return 0;
        return new Promise((resolve) => {
            let done = false;
            const finish = (n) => { if (!done) { done = true; resolve(n); } };
            try {
                const tx = db.transaction(this.STORE, 'readonly');
                const req = tx.objectStore(this.STORE).getAll();
                req.onsuccess = () => {
                    const rows = req.result || [];
                    let ok = 0;
                    rows.forEach(r => {
                        if (r && r.id && this.isValid(r.html)) { this.mem.set(String(r.id), r.html); ok++; }
                    });
                    finish(ok);
                };
                req.onerror = () => finish(0);
            } catch (e) { finish(0); }
            setTimeout(() => finish(this.mem.size), 4000);
        });
    },

    async save(id, html) {
        const key = String(id || '').trim();
        if (!key || !this.isValid(html)) return false;
        this.mem.set(key, html);
        const db = await this.open();
        if (!db) return true;
        try {
            const tx = db.transaction(this.STORE, 'readwrite');
            tx.objectStore(this.STORE).put({ id: key, html: html, t: Date.now() });
        } catch (e) { }
        return true;
    },

    /** 実際に描画済み要素からスナップショットを採取してキャッシュ化 */
    snapshot(compound, el) {
        if (!compound || !el) return false;
        const key = this.key(compound);
        if (!key || this.mem.has(key)) return false;
        const html = (el.innerHTML || '').trim();
        if (!this.isValid(html)) return false;
        this.save(key, html);
        return true;
    },

    async clearAll() {
        this.mem.clear();
        const db = await this.open();
        if (db) {
            try {
                const tx = db.transaction(this.STORE, 'readwrite');
                tx.objectStore(this.STORE).clear();
            } catch (e) { }
        }
    },

    has(compoundOrId) {
        const id = typeof compoundOrId === 'string' ? compoundOrId : this.key(compoundOrId);
        return this.mem.has(String(id || '').trim());
    },

    getHTML(compoundOrId) {
        const id = typeof compoundOrId === 'string' ? compoundOrId : this.key(compoundOrId);
        const html = this.mem.get(String(id || '').trim());
        if (html === undefined) return null;
        if (!this.isValid(html)) { this.mem.delete(String(id || '').trim()); return null; }
        return html;
    },

    /** 同期的に要素へ注入。成功すれば true（＝待ち時間ゼロ） */
    applyTo(el, compound) {
        if (!el) return false;
        const html = this.getHTML(compound);
        if (html == null) return false;
        el.innerHTML = html;
        return true;
    },

    /** オフスクリーンで1件生成（事前キャッシュ用。失敗しても実害なし） */
    async renderOffscreen(compound) {
        const id = this.key(compound);
        if (!id) return null;
        if (this.mem.has(id)) return this.mem.get(id);
        if (!compound || !compound.smiles) return null;
        if (typeof StructureRenderer === 'undefined' || !StructureRenderer.render) return null;
        if (this.offscreenBroken) return null;

        const box = document.createElement('div');
        box.className = 'card-content';
        box.setAttribute('aria-hidden', 'true');
        box.style.cssText =
            'position:fixed;left:0;top:0;width:' + this.RENDER_W + 'px;height:' + this.RENDER_H + 'px;' +
            'opacity:0;pointer-events:none;z-index:-1;overflow:hidden;';
        document.body.appendChild(box);
        let html = null;
        try {
            await Promise.race([
                Promise.resolve(StructureRenderer.render(box, compound.smiles, 'light', {
                    name: compound.name, name_en: compound.name_en, formula: compound.formula
                })),
                new Promise(res => setTimeout(res, 10000))
            ]);
            const out = (box.innerHTML || '').trim();
            if (this.isValid(out)) html = out;
        } catch (e) {
            // 無視（ゲーム側は実要素への直接描画でフォールバックする）
        } finally {
            try { box.remove(); } catch (e) { }
        }
        if (html) { await this.save(id, html); return html; }
        return null;
    },

    async ensureMany(list, onProgress) {
        const items = (list || []).filter(c => c && this.key(c));
        const missing = items.filter(c => !this.has(c));
        if (missing.length === 0) return { total: items.length, generated: 0 };
        let done = 0;
        for (let i = 0; i < missing.length; i++) {
            await this.renderOffscreen(missing[i]);
            done++;
            if (onProgress) onProgress(done, missing.length);
            await new Promise(r => setTimeout(r, 0));
        }
        return { total: items.length, generated: done };
    },

    /* ---- バックグラウンド事前生成 ---- */
    startPrefetch(list) {
        this._prefetchList = (list || []).slice();
        this._prefetchIndex = 0;
        this._prefetchTotal = this._prefetchList.length;
        this._prefetchRunning = true;
        this._paused = false;
        this._pump();
    },

    prioritize(categories) {
        if (!Array.isArray(categories) || categories.length === 0) return;
        const set = new Set(categories);
        this._prefetchList.sort((a, b) => (set.has(a.category) ? 0 : 1) - (set.has(b.category) ? 0 : 1));
    },

    pause() { this._paused = true; },
    resume() { if (this._paused) { this._paused = false; this._pump(); } },
    stop() { this._prefetchRunning = false; this._paused = false; },
    get running() { return this._prefetchRunning && !this._paused; },

    _schedule(fn) {
        if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 600 });
        else setTimeout(fn, 110);
    },

    _pump() {
        if (!this._prefetchRunning || this._paused) return;
        this._schedule(async () => {
            if (!this._prefetchRunning || this._paused) return;
            if (this._prefetchIndex >= this._prefetchList.length) {
                this._prefetchRunning = false;
                if (this.onProgress) this.onProgress(this._prefetchIndex, this._prefetchTotal, true);
                return;
            }
            const compound = this._prefetchList[this._prefetchIndex++];
            const before = this.mem.size;
            try { await this.renderOffscreen(compound); } catch (e) { }
            if (this.mem.size === before) {
                // オフスクリーン描画が機能していない環境 → 以降の無駄打ちを止める
                this._failCount = (this._failCount || 0) + 1;
                if (this._failCount >= 3) {
                    this.offscreenBroken = true;
                    this._prefetchRunning = false;
                    console.warn('[StructureCache] offscreen rendering unavailable -> prefetch disabled (gameplay uses direct render)');
                    if (this.onProgress) this.onProgress(this._prefetchIndex, this._prefetchTotal, true);
                    return;
                }
            } else {
                this._failCount = 0;
            }
            if (this.onProgress) this.onProgress(this._prefetchIndex, this._prefetchTotal, false);
            this._pump();
        });
    }
};

/* =========================================================================
   4) ProgressManager — ポイント・段位・特典・図鑑アンロック・詳細計測
========================================================================= */
const ProgressManager = {
    KEY: 'kagaku_karuta_progress_v3',
    MAX_RECORDS: 800,
    MAX_MATCHES: 60,

    UNLOCK_POINT: 30,          // 1分子解放
    CATEGORY_BONUS: 250,       // 単元コンプリート
    ALL_BONUS: 2000,           // 図鑑コンプリート
    MILESTONE_EVERY: 10,       // n分子ごとに
    MILESTONE_POINT: 100,

    /* ★G: 段位＝ポイントで昇段、各段位に特典 */
    RANKS: [
        { min: 0,    name: '見習い',   priv: '基本プレイ' },
        { min: 200,  name: '初級者',   priv: 'タイトルに段位バッジ表示' },
        { min: 500,  name: '中級者',   priv: '記録画面の詳細グラフ（反応時間分布ほか）を開放' },
        { min: 900,  name: '上級者',   priv: '結果画面に自分の反応時間(ms)を表示' },
        { min: 1500, name: '達人',     priv: '結果画面にCPUの思考時間(ms)を表示' },
        { min: 2500, name: '名人',     priv: '資料の解説文を全文表示' },
        { min: 4000, name: '王座',     priv: 'タイトルロゴが金色フレーム' },
        { min: 6000, name: '永世名人', priv: '全化合物の構造式を自動解放（図鑑完成特典）' }
    ],
    data: null,

    _default() {
        return {
            points: 0, wins: 0, losses: 0, draws: 0,
            gamesPlayed: 0, unlocked: [], unlockedByCategory: {},
            totalCorrect: 0, bestPoints: 0, lastPlayed: null,
            records: [], matches: []
        };
    },

    init() {
        this.data = this._default();
        try {
            const raw = localStorage.getItem(this.KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') this.data = Object.assign(this._default(), parsed);
            }
        } catch (e) { console.warn('ProgressManager load failed:', e); }
        if (!Array.isArray(this.data.unlocked)) this.data.unlocked = [];
        if (!Array.isArray(this.data.records)) this.data.records = [];
        if (!Array.isArray(this.data.matches)) this.data.matches = [];
        if (!this.data.unlockedByCategory || typeof this.data.unlockedByCategory !== 'object') this.data.unlockedByCategory = {};
        // 旧キー(v2)からの移行
        try {
            const old = localStorage.getItem('kagaku_karuta_progress_v2');
            if (old && this.data.gamesPlayed === 0 && this.data.points === 0) {
                const o = JSON.parse(old);
                if (o && typeof o === 'object') {
                    this.data.points = Number(o.points) || 0;
                    this.data.wins = Number(o.wins) || 0;
                    this.data.losses = Number(o.losses) || 0;
                    this.data.draws = Number(o.draws) || 0;
                    this.data.gamesPlayed = Number(o.gamesPlayed) || 0;
                    this.data.unlocked = Array.isArray(o.unlocked) ? o.unlocked : [];
                    this.save();
                }
            }
        } catch (e) { }
        return this.data;
    },

    save() {
        try { localStorage.setItem(this.KEY, JSON.stringify(this.data)); }
        catch (e) { console.warn('ProgressManager save failed:', e); }
    },

    get points() { return Number(this.data && this.data.points) || 0; },

    _addPoints(n) {
        const v = Math.max(0, Math.round(Number(n) || 0));
        this.data.points += v;
        if (this.data.points > this.data.bestPoints) this.data.bestPoints = this.data.points;
        return v;
    },

    rankOf(points) {
        const p = Number(points) || 0;
        let cur = this.RANKS[0];
        for (let i = 0; i < this.RANKS.length; i++) { if (p >= this.RANKS[i].min) cur = this.RANKS[i]; }
        const idx = this.RANKS.indexOf(cur);
        const next = idx < this.RANKS.length - 1 ? this.RANKS[idx + 1] : null;
        const span = next ? (next.min - cur.min) : 1;
        const prog = next ? Math.max(0, Math.min(1, (p - cur.min) / span)) : 1;
        return {
            name: cur.name, index: idx, current: cur, next: next,
            progress: prog, need: next ? Math.max(0, next.min - p) : 0,
            priv: cur.priv
        };
    },

    get rankIndex() { return this.rankOf(this.points).index; },
    hasPrivilege(index) { return this.rankIndex >= index; },

    /* ---- ★D: 詳細計測レコード（内部時計の反応時間など） ---- */
    addRecord(rec) {
        if (!rec) return;
        this.data.records.push(rec);
        if (this.data.records.length > this.MAX_RECORDS) {
            this.data.records.splice(0, this.data.records.length - this.MAX_RECORDS);
        }
        if (rec.correct) this.data.totalCorrect++;
        this.save();
    },

    addMatch(m) {
        if (!m) return;
        this.data.matches.push(m);
        if (this.data.matches.length > this.MAX_MATCHES) {
            this.data.matches.splice(0, this.data.matches.length - this.MAX_MATCHES);
        }
        this.save();
    },

    /* ---- 試合終了 → ポイント ---- */
    recordGameEnd(info) {
        const opt = info || {};
        const mode = opt.mode || 'cpu';
        const winner = opt.winner || 'draw';
        const diffLevel = Number(opt.difficulty) || 0;
        const correctRounds = Number(opt.correctRounds) || 0;
        const perfectRounds = Number(opt.perfectRounds) || 0;
        const before = this.rankOf(this.points).name;

        let gained = 0;
        if (mode === 'practice') {
            gained = 0;
        } else {
            if (winner === 'player') { gained = 100 + diffLevel * 15; this.data.wins++; }
            else if (winner === 'draw') { gained = 40; this.data.draws++; }
            else { gained = 12; this.data.losses++; }
            if (mode === 'online' && winner === 'player') gained += 60;
            gained += correctRounds * 5 + perfectRounds * 10;   // 一発正解ボーナス
            gained = this._addPoints(gained);
        }

        this.data.gamesPlayed++;
        this.data.lastPlayed = Date.now();
        this.addMatch({
            t: Date.now(), mode: mode, winner: winner,
            difficulty: mode === 'practice' ? 0 : diffLevel,
            points: gained, score: Number(opt.playerScore) || 0,
            oppScore: Number(opt.cpuScore) || 0,
            perfect: perfectRounds
        });

        const after = this.rankOf(this.points);
        this.save();
        return { gained: gained, rankUp: after.name !== before ? after.name : null, rank: after };
    },

    /* ---- ★F/★G: 図鑑アンロック（誤答なし一発正解のみ）＋特典ポイント ---- */
    unlockWithReward(id, category, totalOfCategory) {
        const key = String(id || '').trim();
        if (!key) return null;
        if (this.data.unlocked.includes(key)) return null;

        this.data.unlocked.push(key);
        let gained = this._addPoints(this.UNLOCK_POINT);
        const events = [{ type: 'unlock', point: this.UNLOCK_POINT }];

        // 単元コンプリート
        const cat = String(category || '').trim();
        if (cat) {
            const n = (this.data.unlockedByCategory[cat] || 0) + 1;
            this.data.unlockedByCategory[cat] = n;
            if (totalOfCategory && n >= totalOfCategory) {
                const b = this._addPoints(this.CATEGORY_BONUS);
                gained += b;
                events.push({ type: 'category', point: b, category: cat });
            }
        }

        // n分子ごとマイルストーン
        if (this.data.unlocked.length % this.MILESTONE_EVERY === 0) {
            const b = this._addPoints(this.MILESTONE_POINT);
            gained += b;
            events.push({ type: 'milestone', point: b, count: this.data.unlocked.length });
        }

        const before = this.rankOf(this.points - gained).name;
        const after = this.rankOf(this.points);
        this.data.lastPlayed = Date.now();
        this.save();

        return {
            gained: gained,
            events: events,
            rankUp: after.name !== before ? after.name : null,
            total: this.data.unlocked.length
        };
    },

    /** 図鑑コンプリート特典 */
    completeAllBonus(totalCompounds) {
        if (!totalCompounds) return 0;
        if (this.data.unlocked.length < totalCompounds) return 0;
        if (this.data.allCompleteRewarded) return 0;
        this.data.allCompleteRewarded = true;
        const b = this._addPoints(this.ALL_BONUS);
        this.save();
        return b;
    },

    isUnlocked(id) { return this.data.unlocked.includes(String(id || '').trim()); },

    /** ★G: 永世名人は全解放特典 */
    isEffectivelyUnlocked(id) {
        if (this.hasPrivilege(7)) return true;
        return this.isUnlocked(id);
    },

    unlockedCount() { return this.data.unlocked.length; },

    winRate() {
        const t = this.data.wins + this.data.losses + this.data.draws;
        return t > 0 ? Math.round((this.data.wins / t) * 100) : 0;
    },

    /* ---- 統計計算 ---- */
    stats() {
        const recs = this.data.records || [];
        const answers = recs.filter(r => typeof r.reactionMs === 'number');
        const correct = answers.filter(r => r.correct);
        const times = correct.map(r => r.reactionMs).sort((a, b) => a - b);
        const sum = times.reduce((a, b) => a + b, 0);
        const median = times.length ? times[Math.floor(times.length / 2)] : 0;
        const p90 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.9))] : 0;

        const byStage = {};
        answers.forEach(r => {
            const s = r.stage || 1;
            if (!byStage[s]) byStage[s] = { correct: 0, wrong: 0, time: 0, n: 0 };
            if (r.correct) byStage[s].correct++; else byStage[s].wrong++;
            if (r.correct) { byStage[s].time += r.reactionMs; byStage[s].n++; }
        });

        const byCategory = {};
        answers.forEach(r => {
            const c = r.category || 'other';
            if (!byCategory[c]) byCategory[c] = { correct: 0, wrong: 0 };
            if (r.correct) byCategory[c].correct++; else byCategory[c].wrong++;
        });

        const byDifficulty = {};
        (this.data.matches || []).forEach(m => {
            if (m.mode !== 'cpu') return;
            const d = m.difficulty || 0;
            if (!byDifficulty[d]) byDifficulty[d] = { win: 0, lose: 0, draw: 0 };
            if (m.winner === 'player') byDifficulty[d].win++;
            else if (m.winner === 'cpu') byDifficulty[d].lose++;
            else byDifficulty[d].draw++;
        });

        const perfect = answers.filter(r => r.correct && r.perfect).length;

        return {
            total: answers.length,
            correct: correct.length,
            wrong: answers.length - correct.length,
            accuracy: answers.length ? Math.round((correct.length / answers.length) * 100) : 0,
            avg: times.length ? Math.round(sum / times.length) : 0,
            median: median,
            min: times.length ? times[0] : 0,
            max: times.length ? times[times.length - 1] : 0,
            p90: p90,
            perfect: perfect,
            perfectRate: correct.length ? Math.round((perfect / correct.length) * 100) : 0,
            byStage: byStage,
            byCategory: byCategory,
            byDifficulty: byDifficulty,
            times: times
        };
    },

    reset() { this.data = this._default(); this.save(); }
};

/* =========================================================================
   5) フォールバック用スタイル注入（style.css 未更新環境向け）
========================================================================= */
function injectExtraStyles() {
    if (document.getElementById('app-extra-styles')) return;
    const css = [
        ':root{--card-max:150px;}',
        '@media (min-width:600px){:root{--card-max:175px;}}',
        '@media (min-width:900px){:root{--card-max:195px;}}',
        '@media (min-width:1200px){:root{--card-max:210px;}}',
        '.card{width:100%;max-width:var(--card-max);justify-self:center;}',
        '.card-field{max-width:1180px;margin:0 auto;justify-content:center;align-content:start;}',
        '#card-grid.cards-6{grid-template-columns:repeat(3,1fr);gap:12px;}',
        '#card-grid.cards-9{grid-template-columns:repeat(3,1fr);gap:10px;}',
        '#card-grid.cards-12{grid-template-columns:repeat(4,1fr);gap:8px;}',
        '#card-grid.cards-16{grid-template-columns:repeat(4,1fr);gap:7px;}',
        '@media (min-width:900px){#card-grid.cards-6{grid-template-columns:repeat(3,1fr);}',
        '#card-grid.cards-9{grid-template-columns:repeat(5,1fr);}',
        '#card-grid.cards-12{grid-template-columns:repeat(6,1fr);}',
        '#card-grid.cards-16{grid-template-columns:repeat(8,1fr);}}',
        '@media (max-height:500px) and (orientation:landscape){:root{--card-max:120px;}',
        '#card-grid.cards-9{grid-template-columns:repeat(9,1fr);}}',
        '.next-btn{display:flex;align-items:center;justify-content:center;text-align:center;letter-spacing:.2em;text-indent:.2em;line-height:1;padding:0 20px;min-height:52px;}',
        '.menu-text{letter-spacing:.3em;text-indent:.3em;line-height:1;}',
        '.footer-btn{display:flex;align-items:center;justify-content:center;letter-spacing:.15em;text-indent:.15em;line-height:1;padding:0 12px;}',
        '.footer-btn:disabled,.clue-btn:disabled,.next-btn:disabled,.menu-btn:disabled{opacity:.4;cursor:not-allowed;transform:none !important;}',
        '.card-content svg,.card-content img,.reference-item-structure svg,.reference-item-structure img,',
        '.reference-detail-structure svg,.reference-detail-structure img,#modal-structure svg,#modal-structure img{',
        'max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block;}',
        '#title-cache-panel{width:100%;max-width:320px;background:rgba(0,0,0,.55);border:1px solid var(--card-border);',
        'border-left:4px solid var(--accent-gold);border-radius:2px;padding:10px 14px;}',
        '.tcp-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px;}',
        '.tcp-title{font-family:var(--font-display);font-size:.78rem;font-weight:700;color:var(--accent-gold);letter-spacing:.16em;}',
        '.tcp-pct{font-family:var(--font-display);font-size:.95rem;font-weight:900;color:var(--card-bg);font-variant-numeric:tabular-nums;}',
        '.tcp-track{height:8px;background:rgba(255,255,255,.14);border-radius:4px;overflow:hidden;}',
        '.tcp-fill{height:100%;width:0%;background:linear-gradient(90deg,var(--accent-green),var(--accent-gold));transition:width .3s ease-out;}',
        '.tcp-fill.done{background:linear-gradient(90deg,var(--accent-gold),#e8d49a);}',
        '.tcp-meta{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:7px;',
        'font-family:var(--font-main);font-size:.7rem;color:rgba(255,255,255,.62);}',
        '.tcp-dot{width:7px;height:7px;border-radius:50%;background:var(--accent-gold);display:inline-block;margin-right:5px;animation:tcpBlink 1.1s infinite;}',
        '.tcp-dot.done{background:#22c55e;animation:none;}',
        '@keyframes tcpBlink{0%,100%{opacity:1;}50%{opacity:.25;}}',
        '.tcp-btn{background:transparent;border:1px solid var(--card-border-light);color:var(--card-bg);border-radius:2px;',
        'padding:3px 9px;font-family:var(--font-display);font-size:.68rem;cursor:pointer;}',
        '#title-rank-panel{width:100%;max-width:320px;background:rgba(0,0,0,.55);border:1px solid var(--card-border);',
        'border-radius:2px;padding:10px 14px;text-align:center;}',
        '.trp-rank{font-family:var(--font-display);font-size:1.05rem;font-weight:900;color:var(--accent-gold);letter-spacing:.18em;text-indent:.18em;}',
        '.trp-sub{font-family:var(--font-main);font-size:.72rem;color:rgba(255,255,255,.65);margin-top:4px;}',
        '.trp-track{height:6px;background:rgba(255,255,255,.14);border-radius:3px;overflow:hidden;margin-top:8px;}',
        '.trp-fill{height:100%;width:0%;background:linear-gradient(90deg,var(--accent-green),var(--accent-gold));transition:width .6s ease-out;}',
        '.title-logo.rank-gold{border-color:var(--accent-gold);box-shadow:0 0 26px rgba(201,169,97,.45);}',
        '#stats-extra{margin-bottom:26px;}',
        '.chart-block{background:rgba(0,0,0,.3);border:1px solid var(--card-border);border-radius:4px;padding:14px;margin-bottom:16px;}',
        '.chart-title{font-family:var(--font-display);font-size:.95rem;font-weight:700;color:var(--accent-gold);letter-spacing:.12em;margin-bottom:4px;}',
        '.chart-sub{font-family:var(--font-main);font-size:.72rem;color:rgba(255,255,255,.55);margin-bottom:12px;}',
        '.chart-empty{text-align:center;color:rgba(255,255,255,.45);font-size:.8rem;padding:18px 6px;}',
        '.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}',
        '@media (max-width:480px){.kpi-grid{grid-template-columns:repeat(2,1fr);}}',
        '.kpi-item{background:var(--card-bg);border-radius:4px;padding:10px 6px;text-align:center;border-bottom:3px solid var(--accent-green);}',
        '.kpi-item.gold{border-bottom-color:var(--accent-gold);}.kpi-item.red{border-bottom-color:var(--accent-red);}',
        '.kpi-label{font-size:.68rem;color:var(--text-light);margin-bottom:4px;}',
        '.kpi-value{font-family:var(--font-display);font-size:1.15rem;font-weight:900;color:var(--text-dark);font-variant-numeric:tabular-nums;}',
        '.kpi-unit{font-size:.7rem;color:var(--text-light);margin-left:2px;}',
        '.hist{display:flex;align-items:flex-end;gap:4px;height:130px;padding-top:6px;}',
        '.hist-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:5px;min-width:0;height:100%;}',
        '.hist-bar{width:100%;min-height:2px;border-radius:2px 2px 0 0;background:linear-gradient(180deg,var(--accent-gold),var(--accent-green));}',
        '.hist-count{font-family:var(--font-display);font-size:.62rem;color:var(--card-bg);}',
        '.hist-label{font-family:var(--font-main);font-size:.6rem;color:rgba(255,255,255,.6);white-space:nowrap;}',
        '.donut-wrap{display:flex;align-items:center;gap:18px;flex-wrap:wrap;justify-content:center;}',
        '.donut{width:124px;height:124px;border-radius:50%;position:relative;flex-shrink:0;display:flex;align-items:center;justify-content:center;}',
        '.donut::after{content:"";position:absolute;inset:17px;background:#14181c;border-radius:50%;}',
        '.donut-center{position:relative;z-index:1;text-align:center;}',
        '.donut-value{font-family:var(--font-display);font-size:1.5rem;font-weight:900;color:var(--accent-gold);line-height:1;}',
        '.donut-label{font-family:var(--font-main);font-size:.68rem;color:rgba(255,255,255,.65);margin-top:4px;}',
        '.legend{display:flex;flex-direction:column;gap:7px;}',
        '.legend-item{display:flex;align-items:center;gap:8px;font-size:.78rem;color:var(--card-bg);}',
        '.legend-swatch{width:12px;height:12px;border-radius:2px;flex-shrink:0;}',
        '.svgchart{width:100%;height:120px;display:block;overflow:visible;}',
        '.svg-axis{display:flex;justify-content:space-between;font-size:.62rem;color:rgba(255,255,255,.45);margin-top:4px;}',
        '.match-strip{display:flex;gap:3px;align-items:flex-end;height:46px;}',
        '.match-cell{flex:1;min-width:6px;border-radius:2px;}',
        '.match-cell.win{background:var(--accent-green);}.match-cell.lose{background:var(--accent-red);}.match-cell.draw{background:var(--text-light);}',
        '.match-legend{display:flex;gap:14px;margin-top:8px;font-size:.68rem;color:rgba(255,255,255,.6);}',
        '.match-legend span{display:inline-flex;align-items:center;gap:5px;}',
        '.match-legend i{width:10px;height:10px;border-radius:2px;display:inline-block;}',
        '.priv-list{display:flex;flex-direction:column;gap:7px;}',
        '.priv-item{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.05);',
        'border-left:3px solid var(--text-light);padding:8px 11px;border-radius:2px;}',
        '.priv-item.owned{border-left-color:var(--accent-gold);background:rgba(201,169,97,.12);}',
        '.priv-rank{font-family:var(--font-display);font-size:.72rem;font-weight:700;color:var(--accent-gold);letter-spacing:.1em;min-width:74px;}',
        '.priv-name{font-family:var(--font-main);font-size:.8rem;color:var(--card-bg);flex:1;line-height:1.4;}',
        '.priv-item.locked .priv-name{color:rgba(255,255,255,.4);}',
        '.priv-mark{font-size:.72rem;font-family:var(--font-display);color:rgba(255,255,255,.5);}',
        '.priv-item.owned .priv-mark{color:#22c55e;}',
        '.locked-feature{text-align:center;padding:22px 12px;border:1px dashed rgba(255,255,255,.25);border-radius:4px;}',
        '.locked-feature .lf-icon{font-size:1.6rem;margin-bottom:8px;opacity:.8;}',
        '.locked-feature .lf-text{font-family:var(--font-main);font-size:.8rem;color:rgba(255,255,255,.6);line-height:1.7;}',
        '.locked-feature .lf-need{font-family:var(--font-display);font-size:.85rem;color:var(--accent-gold);margin-top:8px;letter-spacing:.1em;}',
        '.timing-row{display:flex;justify-content:center;gap:18px;margin:0 0 14px;font-family:var(--font-display);',
        'font-size:.75rem;color:var(--text-light);letter-spacing:.08em;}',
        '.timing-row b{color:var(--accent-green);font-size:.95rem;font-variant-numeric:tabular-nums;}',
        '.reference-item.locked{background:repeating-linear-gradient(45deg,#dedbd0 0 9px,#d3d0c3 9px 18px);border-color:#9a968a;}',
        '.reference-item.locked .reference-item-name{color:#6f6b5e;letter-spacing:.35em;text-indent:.35em;font-weight:900;}',
        '.reference-item.locked .reference-item-formula{color:#8b8676;letter-spacing:.2em;}',
        '.reference-item-structure.locked{background:rgba(0,0,0,.06);}',
        '.ref-secret-note{background:var(--tatami-light);border-left:4px solid var(--accent-red);padding:12px 14px;',
        'border-radius:2px;font-family:var(--font-main);font-size:.85rem;line-height:1.7;color:var(--text-dark);}',
        '.ref-secret-note b{color:var(--accent-red);}',
        '.explanation-lock-note{margin-top:8px;font-size:.72rem;color:var(--accent-red);font-family:var(--font-display);letter-spacing:.08em;}',
        '.unlock-toast-point{font-family:var(--font-display);font-size:.78rem;color:var(--accent-gold);font-weight:900;margin-top:3px;letter-spacing:.08em;}',
        '.final-countdown{position:sticky;bottom:0;margin-top:10px;background:rgba(139,32,32,.94);border:1px solid var(--accent-gold);',
        'border-radius:2px;padding:7px 11px;color:#fff;font-family:var(--font-display);z-index:6;}',
        '.final-countdown .fc-row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;}',
        '.final-countdown .fc-label{font-size:.7rem;letter-spacing:.15em;opacity:.9;}',
        '.final-countdown .fc-time{font-size:1.05rem;font-weight:900;font-variant-numeric:tabular-nums;}',
        '.final-countdown .fc-bar{height:4px;background:rgba(255,255,255,.25);border-radius:2px;overflow:hidden;margin-top:5px;}',
        '.final-countdown .fc-bar>i{display:block;height:100%;background:var(--accent-gold);width:100%;}',
        '.final-countdown.urgent{animation:fcBlink .7s infinite;}',
        '@keyframes fcBlink{0%,100%{background:rgba(139,32,32,.94);}50%{background:rgba(190,40,40,.98);}}',
        '.unlock-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,24px);opacity:0;display:flex;align-items:center;',
        'gap:12px;background:var(--card-bg);border:2px solid var(--accent-gold);border-left:6px solid var(--accent-green);',
        'border-radius:2px;padding:12px 18px;z-index:3000;box-shadow:0 8px 26px rgba(0,0,0,.45);',
        'transition:all .35s cubic-bezier(.2,.8,.3,1);max-width:88vw;pointer-events:none;}',
        '.unlock-toast.show{opacity:1;transform:translate(-50%,0);}',
        '.unlock-toast-icon{font-size:1.5rem;line-height:1;}',
        '.unlock-toast-title{font-family:var(--font-display);font-size:.72rem;color:var(--accent-green);letter-spacing:.15em;font-weight:700;}',
        '.unlock-toast-name{font-family:var(--font-main);font-size:.95rem;color:var(--text-dark);font-weight:700;margin-top:2px;}',
        '.unlock-panel{background:rgba(0,0,0,.55);border:1px solid var(--card-border);border-radius:2px;padding:8px 12px;margin-bottom:10px;flex-shrink:0;}',
        '.unlock-panel-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;}',
        '.unlock-panel-title{font-family:var(--font-display);font-size:.78rem;color:var(--accent-gold);letter-spacing:.15em;}',
        '.unlock-panel-value{font-family:var(--font-display);font-size:.85rem;color:var(--card-bg);font-weight:700;}',
        '.unlock-track{height:6px;background:rgba(255,255,255,.12);border-radius:3px;overflow:hidden;}',
        '.unlock-fill{height:100%;background:linear-gradient(90deg,var(--accent-green),var(--accent-gold));border-radius:3px;transition:width .5s ease-out;width:0%;}',
        '.unlock-hint{font-size:.68rem;color:rgba(255,255,255,.55);margin-top:5px;line-height:1.5;}',
        '.rank-progress{margin-top:14px;text-align:left;}',
        '.rank-progress-row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px;gap:8px;}',
        '.rank-progress-label{font-family:var(--font-display);font-size:.7rem;color:var(--text-light);letter-spacing:.12em;}',
        '.rank-progress-next{font-family:var(--font-main);font-size:.72rem;color:var(--accent-green);font-weight:700;text-align:right;}',
        '.rank-track{height:8px;background:rgba(90,122,74,.18);border-radius:4px;overflow:hidden;}',
        '.rank-fill{height:100%;background:linear-gradient(90deg,var(--accent-green),var(--accent-gold));border-radius:4px;transition:width .6s ease-out;}',
        '.profile-unlock{margin-top:10px;font-family:var(--font-main);font-size:.82rem;color:var(--text-light);}',
        '.points-gained{font-family:var(--font-display);font-size:1.15rem;font-weight:900;color:var(--accent-gold);letter-spacing:.1em;margin-bottom:8px;}',
        '.rankup-banner{background:var(--accent-gold);color:#1a1a1a;font-family:var(--font-display);font-weight:900;',
        'letter-spacing:.2em;text-indent:.2em;padding:8px;border-radius:2px;margin-bottom:14px;font-size:1rem;}',
        '.lock-badge,.unlock-badge{display:inline-flex;align-items:center;gap:5px;color:#fff;font-family:var(--font-display);',
        'font-size:.7rem;letter-spacing:.1em;padding:3px 10px;border-radius:10px;margin-top:2px;}',
        '.lock-badge{background:var(--accent-red);}.unlock-badge{background:var(--accent-green);}',
        '.diff-desc{display:block;font-family:var(--font-main);font-size:.72rem;color:var(--text-light);margin-top:4px;line-height:1.45;}',
        '.diff-btn.selected .diff-desc{color:var(--accent-green);opacity:.85;}',
        '.diff-text-wrap{display:flex;flex-direction:column;min-width:0;}'
    ].join('\n');
    const styleEl = document.createElement('style');
    styleEl.id = 'app-extra-styles';
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
}

/* =========================================================================
   6) App 本体
========================================================================= */
class App {
    constructor() {
        this.engine = new GameEngine();
        this.currentMode = 'cpu';
        this.selectedDifficulty = 3;
        this.selectedCategories = [];
        this.allCategoriesSelected = true;
        this.isPracticeMode = false;
        this.isOnlineMode = false;
        this.isHost = false;
        this.referenceCurrentCategory = 'all';

        this.onlineGameState = null;
        this.onlineGameStarted = false;
        this.onlineRound = -1;
        this.renderedRound = -1;
        this.processedTaps = {};
        this.tapSeq = 0;
        this.gameEndShown = false;
        this.leftHandled = false;
        this.syncSeq = 0;
        this._onlineWatchdog = null;
        this.scoredRemoteRound = -1;

        this.hasShownResult = false;
        this.roundResultModal = null;
        this.historyTargetId = null;
        this._finalCountdownTimer = null;
        this._gameEndResult = null;

        // ★A: 描画状態
        this._dealing = false;
        this._dealSeq = 0;
        this._dealingRound = -1;
        this._guestRoundStart = 0;
        this._guestStageStart = 0;

        this.init();
    }

    /* ========================= 初期化 ========================= */
    async init() {
        console.log('App initializing (v7)...');
        try {
            injectExtraStyles();
            SettingsStore.init();
            ProgressManager.init();

            const loaded = await this.engine.loadData();
            if (!loaded) { this.showError('データ読み込み失敗'); return; }

            StructureRenderer.init();
            AudioManager.init();
            try { StorageManager.init(); } catch (e) { }

            AudioBridge.applyAll();

            if (typeof OnlineManager !== 'undefined') {
                const onlineReady = OnlineManager.init();
                if (!onlineReady) console.warn('Online mode is disabled due to configuration.');
            }

            this.loadSettings();

            this.engine.onUpdate = (data) => this.updateGameUI(data);
            this.engine.onRoundEnd = (data) => this.showRoundResult(data);
            this.engine.onGameEnd = (data) => this.showGameEnd(data);
            this.engine.onCorrectAnswer = (compound, meta) => this.handleCorrectAnswer(compound, meta);
            this.engine.onAnswerRecord = (rec) => this.handleAnswerRecord(rec);   // ★D

            this.bindEvents();
            this.syncSettingsUI();
            this.renderCategoryGrid();
            this.decorateDifficultyButtons();
            this.normalizeStartButton();

            await this.initStructureCache();

            setTimeout(() => {
                const ls = document.getElementById('loading-screen');
                if (ls) ls.classList.remove('active');
                this.showScreen('screen-title');
                StructureCache.resume();
            }, 900);
        } catch (e) {
            console.error('Initialization error:', e);
            this.showError('初期化エラー: ' + e.message);
        }
    }

    async initStructureCache() {
        this.showCacheProgress(0, this.engine.compounds.length);
        try {
            const restored = await StructureCache.loadAll();
            console.log('[StructureCache] restored ' + restored + ' entries');
        } catch (e) { console.warn('[StructureCache] idb load failed', e); }

        StructureCache.onProgress = (done, total, finished) => {
            this.showCacheProgress(done, total);
            this.renderTitleCachePanel();
            if (finished) console.log('[StructureCache] prefetch finished');
        };

        const pending = this.engine.compounds.filter(c => c && c.smiles && !StructureCache.has(c));
        StructureCache.startPrefetch(pending);
        this.renderTitleCachePanel();
    }

    showCacheProgress(done, total) {
        const host = document.querySelector('#loading-screen .loading-content');
        if (!host) return;
        let box = document.getElementById('cache-progress');
        if (!box) {
            box = document.createElement('div');
            box.id = 'cache-progress';
            box.className = 'cache-progress';
            box.innerHTML =
                '<div class="cache-progress-label">構造式を準備中… <span class="cpv">0 / 0</span></div>' +
                '<div class="cache-progress-track"><div class="cache-progress-fill"></div></div>';
            host.appendChild(box);
        }
        const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
        const v = box.querySelector('.cpv');
        const f = box.querySelector('.cache-progress-fill');
        if (v) v.textContent = done + ' / ' + total;
        if (f) f.style.width = pct + '%';
    }

    showError(message) {
        const loadingScreen = document.getElementById('loading-screen');
        if (!loadingScreen) return;
        loadingScreen.innerHTML =
            '<div class="loading-content">' +
            '<h1 style="color:var(--accent-red);font-size:1.5rem;margin-bottom:20px;">エラー</h1>' +
            '<p style="color:var(--card-bg);margin-bottom:20px;">' + message + '</p>' +
            '<p style="color:rgba(255,255,255,0.6);font-size:0.9rem;">コンソール(F12)で詳細を確認</p>' +
            '</div>';
    }

    /* ========================= 開始ボタン正規化 ========================= */
    normalizeStartButton() {
        const btn = document.getElementById('btn-start-difficulty');
        if (!btn) return;
        const svg = btn.querySelector('svg');
        const text = (btn.textContent || '').replace(/\s+/g, '').trim() || '開始';
        btn.innerHTML = '';
        if (svg) btn.appendChild(svg);
        const label = document.createElement('span');
        label.className = 'btn-label';
        label.textContent = text;
        btn.appendChild(label);
        btn.style.textAlign = 'center';
    }

    /* ========================= ★D: 計測レコード ========================= */
    handleAnswerRecord(rec) {
        try { ProgressManager.addRecord(rec); } catch (e) { console.warn(e); }
    }

    /* ========================= ★F/★G: アンロック ========================= */
    handleCorrectAnswer(compound, meta) {
        if (!compound) return;
        if (this.isOnlineMode) return;
        const mode = (meta && meta.mode) || this.engine.mode;
        if (mode !== 'cpu') return;                 // CPU戦のみ
        if (!meta || meta.perfect !== true) return; // ★ 誤答なしの一発正解のみ

        const id = String(compound.id || '').trim();
        if (!id || ProgressManager.isUnlocked(id)) return;

        const cat = compound.category || '';
        const totalOfCategory = this.engine.compounds.filter(c => (c.category || '') === cat).length;
        const result = ProgressManager.unlockWithReward(id, cat, totalOfCategory);
        if (!result) return;

        this.showUnlockToast(compound, result);

        // 図鑑コンプリート特典
        const allBonus = ProgressManager.completeAllBonus(this.engine.compounds.length);
        if (allBonus > 0) {
            setTimeout(() => this.showBonusToast('図鑑コンプリート！', '全構造式を解放 +' + allBonus + ' pt'), 2900);
        }
        try { AudioManager.playSound('combo'); } catch (e) { }
        this.renderTitleCachePanel();
    }

    showUnlockToast(compound, result) {
        const toast = document.createElement('div');
        toast.className = 'unlock-toast';
        const rankUp = result && result.rankUp
            ? '<div class="unlock-toast-point">昇段：' + result.rankUp + '</div>' : '';
        toast.innerHTML =
            '<div class="unlock-toast-icon">🔓</div>' +
            '<div><div class="unlock-toast-title">一発正解 ・ 資料を解放</div>' +
            '<div class="unlock-toast-name">' + (compound.name || '') + '</div>' +
            '<div class="unlock-toast-point">+' + ((result && result.gained) || 0) + ' pt</div>' +
            rankUp + '</div>';
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => { try { toast.remove(); } catch (e) { } }, 400);
        }, 2800);
    }

    showBonusToast(title, text) {
        const toast = document.createElement('div');
        toast.className = 'unlock-toast';
        toast.innerHTML =
            '<div class="unlock-toast-icon">🏅</div>' +
            '<div><div class="unlock-toast-title">' + title + '</div>' +
            '<div class="unlock-toast-point">' + text + '</div></div>';
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => { try { toast.remove(); } catch (e) { } }, 400);
        }, 3000);
    }

    /* ========================= イベント ========================= */
    bindEvents() {
        document.querySelectorAll('[data-next]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const nextScreen = e.currentTarget.dataset.next;
                const mode = e.currentTarget.dataset.mode;
                if (mode) this.currentMode = mode;
                if (nextScreen === 'screen-difficulty') {
                    this.updateDifficultySelection();
                    StructureCache.prioritize(this.selectedCategories);
                }
                else if (nextScreen === 'screen-stats') this.updateStats();
                else if (nextScreen === 'screen-reference') this.renderReference();
                else if (nextScreen === 'screen-settings') this.syncSettingsUI();
                this.showScreen(nextScreen);
            });
        });

        document.querySelectorAll('[data-back]').forEach(btn => {
            btn.addEventListener('click', (e) => this.showScreen(e.currentTarget.dataset.back));
        });

        document.querySelectorAll('.diff-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('selected'));
                e.currentTarget.classList.add('selected');
                this.selectedDifficulty = parseInt(e.currentTarget.dataset.level, 10);
            });
        });

        const startBtn = document.getElementById('btn-start-difficulty');
        if (startBtn) startBtn.addEventListener('click', () => this.startGame());

        const selectAllBtn = document.getElementById('btn-select-all');
        if (selectAllBtn) selectAllBtn.addEventListener('click', () => this.toggleSelectAllCategories());

        const cardGrid = document.getElementById('card-grid');
        if (cardGrid) {
            cardGrid.addEventListener('click', (e) => {
                const card = e.target.closest('.card');
                if (!card) return;
                if (card.classList.contains('correct')) return;
                if (this.hasShownResult) return;
                if (this._dealing) return;
                if (!this.engine.cardsReady) return;
                this.handleCardTap(card.dataset.id, card);
            });
        }

        const skipBtn = document.getElementById('btn-skip');
        if (skipBtn) {
            skipBtn.addEventListener('click', () => {
                if (this.hasShownResult) return;
                if (!this.isOnlineMode || this.isHost) this.engine.skipRound();
            });
        }

        const pauseBtn = document.getElementById('btn-pause');
        if (pauseBtn) {
            pauseBtn.addEventListener('click', async () => {
                if (this.isOnlineMode && typeof OnlineManager !== 'undefined') {
                    try { await OnlineManager.leaveRoom(); } catch (e) { }
                }
                this.engine.pause();
                this.stopFinalCountdown();
                this.resetOnlineState();
                this.showScreen('screen-title');
                StructureCache.resume();
            });
        }

        const hintBtn = document.getElementById('btn-hint');
        if (hintBtn) hintBtn.addEventListener('click', () => this.showHint());

        const nextClueBtn = document.getElementById('btn-next-clue');
        if (nextClueBtn) {
            nextClueBtn.addEventListener('click', () => {
                if (this.hasShownResult) return;
                if (!this.isOnlineMode || this.isHost) {
                    this.engine.nextClue();
                    this.updateFooterState();
                }
            });
        }

        const modalCloseBtn = document.getElementById('modal-close-btn');
        if (modalCloseBtn) {
            modalCloseBtn.addEventListener('click', () => {
                const m = document.getElementById('reference-detail-modal');
                if (m) m.classList.remove('active');
            });
        }
        const modalOverlay = document.getElementById('reference-detail-modal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) modalOverlay.classList.remove('active');
            });
        }

        const onlineBtn = document.getElementById('btn-online');
        if (onlineBtn) onlineBtn.addEventListener('click', () => this.showOnlineMenu());

        this.bindSettingsControls();

        const resetBtn = document.getElementById('btn-reset-stats');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (confirm('統計・ポイント・段位・アンロックデータをすべて初期化しますか？')) {
                    try { StorageManager.resetAll(); } catch (e) { }
                    ProgressManager.reset();
                    alert('初期化しました。');
                    this.updateStats();
                    this.renderTitleCachePanel();
                }
            });
        }
    }

    bindSettingsControls() {
        const screen = document.getElementById('screen-settings') || document;

        const voiceToggle = document.getElementById('setting-voice');
        if (voiceToggle) {
            voiceToggle.addEventListener('change', (e) => {
                SettingsStore.set('voiceEnabled', e.target.checked);
                AudioBridge.applyVoiceSettings();
                AudioBridge.applyAll();
            });
        }

        const voiceSpeed = document.getElementById('setting-voice-speed');
        if (voiceSpeed) {
            voiceSpeed.addEventListener('change', (e) => {
                SettingsStore.set('voiceSpeed', parseFloat(e.target.value));
                AudioBridge.applyVoiceSettings();
            });
        }

        const cardCount = document.getElementById('setting-card-count');
        if (cardCount) {
            const handler = (e) => {
                const n = SettingsStore.set('cardCount', parseInt(e.target.value, 10));
                this.engine.settings.cardCount = n;
                this.applyCardGridLayout(n);
                e.target.value = String(n);
            };
            cardCount.addEventListener('change', handler);
            cardCount.addEventListener('input', handler);
        }

        this.volumeInputs = [];
        const ranges = Array.from(screen.querySelectorAll('input[type="range"]'));
        ranges.forEach((input, index) => {
            const role = this._detectVolumeRole(input, index, ranges.length);
            this.volumeInputs.push({ input: input, role: role });
            const onInput = () => {
                const max = parseFloat(input.max) || 100;
                const min = parseFloat(input.min) || 0;
                const raw = parseFloat(input.value);
                const norm = max > min ? (raw - min) / (max - min) : raw;
                SettingsStore.set(role + 'Volume', Math.max(0, Math.min(1, norm)));
                AudioBridge.apply({
                    reader: SettingsStore.get('readerVolume'),
                    se: SettingsStore.get('seVolume'),
                    bgm: SettingsStore.get('bgmVolume')
                });
                this._updateVolumeIndicator(input, raw, max);
            };
            input.addEventListener('input', onInput);
            input.addEventListener('change', onInput);
        });

        Array.from(screen.querySelectorAll('select')).forEach(sel => {
            if (sel.id === 'setting-voice-speed' || sel.id === 'setting-card-count') return;
            const role = this._detectVolumeRole(sel, -1, 0);
            if (!role) return;
            sel.addEventListener('change', () => {
                const v = parseFloat(sel.value);
                if (!isFinite(v)) return;
                const last = parseFloat(sel.options[sel.options.length - 1].value) || 5;
                const norm = v > 1 ? v / last : v;
                SettingsStore.set(role + 'Volume', Math.max(0, Math.min(1, norm)));
                AudioBridge.apply({
                    reader: SettingsStore.get('readerVolume'),
                    se: SettingsStore.get('seVolume'),
                    bgm: SettingsStore.get('bgmVolume')
                });
            });
        });
    }

    _detectVolumeRole(el, index, total) {
        const id = String(el.id || '').toLowerCase();
        const name = String(el.name || '').toLowerCase();
        const item = el.closest ? el.closest('.setting-item') : null;
        const labelText = item ? (item.textContent || '') : '';
        const hay = (id + ' ' + name + ' ' + labelText).toLowerCase();
        if (hay.indexOf('読手') >= 0 || hay.indexOf('reader') >= 0 || hay.indexOf('voice') >= 0 || hay.indexOf('speak') >= 0) return 'reader';
        if (hay.indexOf('bgm') >= 0 || hay.indexOf('music') >= 0) return 'bgm';
        if (hay.indexOf('se') >= 0 || hay.indexOf('sfx') >= 0 || hay.indexOf('効果音') >= 0) return 'se';
        const order = ['reader', 'se', 'bgm'];
        if (index >= 0 && index < order.length && total >= 2) return order[index];
        return 'reader';
    }

    _updateVolumeIndicator(input, rawValue, max) {
        const item = input.closest ? input.closest('.setting-item') : null;
        if (!item) return;
        const valueEl = item.querySelector('.volume-value');
        if (valueEl) valueEl.textContent = String(rawValue);
        const barEl = item.querySelector('.volume-bar');
        if (barEl) barEl.style.width = Math.round((rawValue / (max || 1)) * 100) + '%';
    }

    syncSettingsUI() {
        const voiceToggle = document.getElementById('setting-voice');
        if (voiceToggle) voiceToggle.checked = !!SettingsStore.get('voiceEnabled');
        const voiceSpeed = document.getElementById('setting-voice-speed');
        if (voiceSpeed) voiceSpeed.value = String(SettingsStore.get('voiceSpeed'));
        const cardCount = document.getElementById('setting-card-count');
        if (cardCount) cardCount.value = String(SettingsStore.get('cardCount'));
        (this.volumeInputs || []).forEach(entry => {
            const input = entry.input;
            const norm = SettingsStore.get(entry.role + 'Volume');
            const max = parseFloat(input.max) || 100;
            const min = parseFloat(input.min) || 0;
            const raw = Math.round(min + norm * (max - min));
            input.value = String(raw);
            this._updateVolumeIndicator(input, raw, max);
        });
        this.applyCardGridLayout(SettingsStore.get('cardCount'));
    }

    decorateDifficultyButtons() {
        const desc = {
            0: 'CPUなし。読み札と構造式の確認用（解放対象外）',
            1: 'CPUは後半の札で気づく。取りやすい相手',
            3: 'あなたと互角の取り合いになる標準バランス',
            7: 'CPUが序盤の札から仕掛けてくる強敵'
        };
        document.querySelectorAll('.diff-btn').forEach(btn => {
            if (btn.querySelector('.diff-desc')) return;
            const lv = parseInt(btn.dataset.level, 10);
            const textEl = btn.querySelector('.diff-text');
            if (!textEl) return;
            const wrap = document.createElement('div');
            wrap.className = 'diff-text-wrap';
            const d = document.createElement('span');
            d.className = 'diff-desc';
            d.textContent = desc[lv] || '';
            btn.insertBefore(wrap, textEl);
            wrap.appendChild(textEl);
            wrap.appendChild(d);
        });
    }

    /* ========================= オンライン ========================= */
    showOnlineMenu() {
        if (typeof OnlineManager === 'undefined' || !OnlineManager.init()) {
            alert('オンライン機能が利用できません。Firebaseの設定を確認してください。');
            return;
        }
        this.resetOnlineState();
        document.querySelectorAll('.modal-screen').forEach(m => m.remove());

        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.id = 'online-menu-modal';
        modal.innerHTML =
            '<div class="modal-content" style="background:var(--card-bg);border:3px solid var(--accent-gold);border-radius:2px;padding:25px 20px;max-width:420px;width:92%;text-align:center;">' +
            '<h2 style="font-size:1.5rem;margin-bottom:20px;color:var(--accent-gold);font-family:var(--font-display);letter-spacing:.15em;text-indent:.15em;">オンライン対戦</h2>' +
            '<div style="margin-bottom:20px;">' +
            '<button class="btn btn-primary" id="btn-create-room" style="width:100%;margin-bottom:10px;min-height:48px;">ルーム作成</button>' +
            '<p style="font-size:0.8rem;color:var(--text-light);">対戦相手とルームを共有</p></div>' +
            '<div style="margin-bottom:20px;">' +
            '<input type="text" id="room-id-input" placeholder="ルームID（6桁）" maxlength="6" style="width:100%;padding:10px;border:2px solid var(--card-border);border-radius:2px;text-align:center;font-size:1.2rem;letter-spacing:.3em;text-transform:uppercase;min-height:44px;box-sizing:border-box;">' +
            '<button class="btn btn-secondary" id="btn-join-room" style="width:100%;margin-top:10px;min-height:48px;">ルーム参加</button></div>' +
            '<button class="btn btn-danger" id="btn-cancel-online" style="width:100%;min-height:44px;margin-top:0;">キャンセル</button>' +
            '</div>';
        document.body.appendChild(modal);

        document.getElementById('btn-create-room').addEventListener('click', () => this.createOnlineRoom());
        document.getElementById('btn-join-room').addEventListener('click', () => this.joinOnlineRoom());
        document.getElementById('btn-cancel-online').addEventListener('click', () => modal.remove());
    }

    async createOnlineRoom() {
        try {
            this.resetOnlineState();
            const settings = {
                mode: 'online',
                cardCount: SettingsStore.get('cardCount'),
                categories: this.selectedCategories.length > 0 ? this.selectedCategories : [],
                difficulty: this.selectedDifficulty
            };
            const roomId = await OnlineManager.createRoom(settings);
            this.isHost = true;
            this.isOnlineMode = true;

            const onlineMenu = document.getElementById('online-menu-modal');
            if (onlineMenu) onlineMenu.remove();
            this.showWaitingRoom(roomId);

            OnlineManager.onRoomUpdate((roomData) => {
                if (!roomData) return;
                if (this.onlineGameStarted) return;
                const statusEl = document.getElementById('waiting-opponent-status');
                const startBtnEl = document.getElementById('btn-start-game');
                if (roomData.guest) {
                    if (statusEl) { statusEl.textContent = '対戦相手が参加しました'; statusEl.style.color = 'var(--accent-green)'; }
                    if (startBtnEl) { startBtnEl.disabled = false; startBtnEl.style.opacity = '1'; }
                } else {
                    if (statusEl) { statusEl.textContent = '対戦相手を待っています...'; statusEl.style.color = 'var(--text-light)'; }
                    if (startBtnEl) { startBtnEl.disabled = true; startBtnEl.style.opacity = '0.5'; }
                }
                const phase = roomData.gameState ? roomData.gameState.phase : 'waiting';
                if (phase === 'starting') this.startOnlineGameAsHost(roomData);
            });
        } catch (e) {
            console.error('Failed to create room:', e);
            alert('ルーム作成に失敗しました: ' + e.message);
        }
    }

    async joinOnlineRoom() {
        try {
            const roomIdInput = document.getElementById('room-id-input');
            const roomId = roomIdInput ? roomIdInput.value.trim().toUpperCase() : '';
            if (!roomId || roomId.length !== 6) { alert('6桁のルームIDを入力してください'); return; }

            this.resetOnlineState();
            await OnlineManager.joinRoom(roomId);
            this.isHost = false;
            this.isOnlineMode = true;

            const onlineMenu = document.getElementById('online-menu-modal');
            if (onlineMenu) onlineMenu.remove();
            this.showWaitingRoomForGuest(roomId);

            OnlineManager.onRoomUpdate((roomData) => {
                if (!roomData) {
                    if (this.onlineGameStarted && !this.leftHandled) {
                        this.leftHandled = true;
                        this.handleOpponentLeft('ホストが退出しました');
                    }
                    return;
                }
                if (this.onlineGameStarted) return;
                const phase = roomData.gameState ? roomData.gameState.phase : 'waiting';
                if (phase !== 'waiting') this.startOnlineGameAsGuest(roomData);
            });
        } catch (e) {
            console.error('Failed to join room:', e);
            alert('ルーム参加に失敗しました: ' + e.message);
        }
    }

    _waitingRoomShell(inner) {
        const existing = document.getElementById('waiting-room-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.id = 'waiting-room-modal';
        modal.innerHTML =
            '<div class="modal-content" style="background:var(--card-bg);border:3px solid var(--accent-gold);border-radius:2px;padding:25px 20px;max-width:420px;width:92%;text-align:center;">' +
            inner + '</div>';
        document.body.appendChild(modal);
        return modal;
    }

    showWaitingRoom(roomId) {
        this._waitingRoomShell(
            '<h2 id="waiting-opponent-status" style="font-size:1.3rem;margin-bottom:20px;color:var(--text-light);font-family:var(--font-display);">対戦相手を待っています...</h2>' +
            '<div style="background:var(--tatami-light);padding:20px;border-radius:2px;border:2px solid var(--card-border);margin-bottom:20px;">' +
            '<div style="font-size:0.9rem;color:var(--text-light);margin-bottom:10px;">ルームID</div>' +
            '<div style="font-size:2rem;font-weight:900;color:var(--accent-green);letter-spacing:.3em;text-indent:.3em;font-family:var(--font-display);">' + roomId + '</div></div>' +
            '<p style="font-size:0.85rem;color:var(--text-light);margin-bottom:20px;">上記のルームIDを対戦相手に共有してください</p>' +
            '<button class="btn btn-primary" id="btn-start-game" disabled style="width:100%;margin-bottom:15px;min-height:48px;opacity:0.5;">ゲーム開始</button>' +
            '<div class="loading-spinner" style="margin:20px auto;"></div>' +
            '<button class="btn btn-danger" id="btn-cancel-waiting" style="width:100%;min-height:44px;margin-top:0;">キャンセル</button>');

        document.getElementById('btn-start-game').addEventListener('click', () => {
            OnlineManager.updateGameState({ phase: 'starting' });
        });
        document.getElementById('btn-cancel-waiting').addEventListener('click', async () => {
            if (typeof OnlineManager !== 'undefined') { try { await OnlineManager.leaveRoom(); } catch (e) { } }
            this.resetOnlineState();
        });
    }

    showWaitingRoomForGuest(roomId) {
        this._waitingRoomShell(
            '<h2 style="font-size:1.3rem;margin-bottom:20px;color:var(--accent-gold);font-family:var(--font-display);">ホストの開始を待っています...</h2>' +
            '<div style="background:var(--tatami-light);padding:20px;border-radius:2px;border:2px solid var(--card-border);margin-bottom:20px;">' +
            '<div style="font-size:0.9rem;color:var(--text-light);margin-bottom:10px;">ルームID</div>' +
            '<div style="font-size:2rem;font-weight:900;color:var(--accent-green);letter-spacing:.3em;text-indent:.3em;font-family:var(--font-display);">' + roomId + '</div></div>' +
            '<p style="font-size:0.85rem;color:var(--text-light);margin-bottom:20px;">ホストがゲームを開始するまでお待ちください</p>' +
            '<div class="loading-spinner" style="margin:20px auto;"></div>' +
            '<button class="btn btn-danger" id="btn-cancel-waiting" style="width:100%;min-height:44px;margin-top:0;">キャンセル</button>');

        document.getElementById('btn-cancel-waiting').addEventListener('click', async () => {
            if (typeof OnlineManager !== 'undefined') { try { await OnlineManager.leaveRoom(); } catch (e) { } }
            this.resetOnlineState();
        });
    }

    startOnlineGameAsHost(roomData) {
        if (this.onlineGameStarted) return;
        this.onlineGameStarted = true;
        const waitingModal = document.getElementById('waiting-room-modal');
        if (waitingModal) waitingModal.remove();

        this.isOnlineMode = true;
        this.isHost = true;
        this.isPracticeMode = false;
        this.resetRoundUIState();

        const gameScreen = document.getElementById('screen-game');
        if (gameScreen) gameScreen.classList.remove('practice-mode');
        this.setText('player-score-label', 'あなた');
        this.setText('cpu-score-label', '相手');

        const settings = (roomData && roomData.settings) || {};
        const cardCount = SettingsStore.normalizeCardCount(settings.cardCount || SettingsStore.get('cardCount'));
        this.engine.configure({
            mode: 'online', isOnline: true, isHost: true, cpuLevel: 0,
            cardCount: cardCount, categories: settings.categories || []
        });
        this.applyCardGridLayout(cardCount);           // ★C
        this.engine.onOnlineStateChange = (state) => this.handleOnlineStateChange(state);
        this.setupOnlineSync();
        this.showScreen('screen-game');
        StructureCache.pause();
        this.engine.startGame(10);
        this.startOnlineWatchdog();
    }

    startOnlineGameAsGuest(roomData) {
        if (this.onlineGameStarted) return;
        this.onlineGameStarted = true;
        const waitingModal = document.getElementById('waiting-room-modal');
        if (waitingModal) waitingModal.remove();

        this.isOnlineMode = true;
        this.isHost = false;
        this.isPracticeMode = false;
        this.resetRoundUIState();

        const gameScreen = document.getElementById('screen-game');
        if (gameScreen) gameScreen.classList.remove('practice-mode');
        this.setText('player-score-label', 'あなた');
        this.setText('cpu-score-label', '相手');

        const settings = (roomData && roomData.settings) || {};
        const cardCount = SettingsStore.normalizeCardCount(settings.cardCount || SettingsStore.get('cardCount'));
        this.engine.configure({
            mode: 'online', isOnline: true, isHost: false, cpuLevel: 0,
            cardCount: cardCount, categories: settings.categories || []
        });
        this.applyCardGridLayout(cardCount);           // ★C
        this.setupOnlineSync();
        if (roomData && roomData.gameState) this.syncOnlineGameState(roomData.gameState, roomData);
        this.showScreen('screen-game');
        StructureCache.pause();
        this.startOnlineWatchdog();
    }

    resetRoundUIState() {
        this.syncSeq++;
        this.hasShownResult = false;
        this.onlineGameState = null;
        this.onlineRound = -1;
        this.renderedRound = -1;
        this.processedTaps = {};
        this.tapSeq = 0;
        this.gameEndShown = false;
        this.leftHandled = false;
        this.historyTargetId = null;
        this.scoredRemoteRound = -1;
        this._dealing = false;
        this._dealingRound = -1;
        this.stopFinalCountdown();
        this.closeRoundResultModal();
    }

    resetOnlineState() {
        this.engine.pause();
        this.stopOnlineWatchdog();
        this.stopFinalCountdown();
        this.isOnlineMode = false;
        this.isHost = false;
        this.onlineGameStarted = false;
        this.resetRoundUIState();
        const wm = document.getElementById('waiting-room-modal');
        if (wm) wm.remove();
        const om = document.getElementById('online-menu-modal');
        if (om) om.remove();
    }

    async handleOnlineStateChange(state) {
        if (!this.isOnlineMode || !this.isHost || !state) return;
        try {
            switch (state.type) {
                case 'round_start':
                    await OnlineManager.setRoundData(state.cards, state.target, state.round, state.totalRounds, 0);
                    await OnlineManager.updateScores(this.engine.getAuthoritativeScores());
                    break;
                case 'stage_update':
                    await OnlineManager.updateStage(state.currentStage, state.round);
                    break;
                case 'player_tap':
                    await OnlineManager.updateScores(this.engine.getAuthoritativeScores());
                    break;
                case 'round_end':
                    await OnlineManager.finishRound(
                        state.playerWon ? 'player' : 'opponent',
                        state.round || this.engine.roundNumber,
                        this.engine.getAuthoritativeScores());
                    break;
                case 'game_end':
                    await OnlineManager.finishGame(this.engine.getAuthoritativeScores());
                    break;
            }
        } catch (e) { console.error('handleOnlineStateChange error:', e); }
    }

    syncScoresToRoom() {
        if (!this.isOnlineMode || !this.isHost) return Promise.resolve();
        if (typeof OnlineManager === 'undefined') return Promise.resolve();
        return OnlineManager.updateScores(this.engine.getAuthoritativeScores())
            .catch(e => console.error('syncScoresToRoom error:', e));
    }

    setupOnlineSync() {
        OnlineManager.onRoomUpdate((roomData) => {
            if (!roomData) {
                if (this.onlineGameStarted && !this.leftHandled) {
                    this.leftHandled = true;
                    this.handleOpponentLeft('対戦相手が退出しました');
                }
                return;
            }
            if (this.isHost && this.onlineGameStarted && !this.leftHandled &&
                !roomData.guest && this.onlineRound > 0) {
                this.leftHandled = true;
                this.handleOpponentLeft('対戦相手が退出しました');
                return;
            }
            if (roomData.gameState) this.syncOnlineGameState(roomData.gameState, roomData);
        });
        OnlineManager.onTaps((taps) => this.handleRemoteTaps(taps));
    }

    handleOpponentLeft(message) {
        this.engine.pause();
        if (typeof OnlineManager !== 'undefined') { try { OnlineManager.leaveRoom(); } catch (e) { } }
        this.resetOnlineState();
        this.showScreen('screen-title');
        StructureCache.resume();
        alert(message || '対戦相手が退出しました');
    }

    startOnlineWatchdog() {
        this.stopOnlineWatchdog();
        this._onlineWatchdog = setInterval(() => this.onlineWatchdogTick(), 3000);
    }
    stopOnlineWatchdog() {
        if (this._onlineWatchdog) { clearInterval(this._onlineWatchdog); this._onlineWatchdog = null; }
    }

    async onlineWatchdogTick() {
        if (!this.isOnlineMode || !this.onlineGameStarted) { this.stopOnlineWatchdog(); return; }
        if (typeof OnlineManager === 'undefined' || !OnlineManager.roomRef) return;
        try {
            const room = await OnlineManager.getRoom();
            if (!room || !room.gameState) return;
            const gs = room.gameState;
            const dbRound = Number(gs.round) || 0;

            if (this.isHost) {
                const r = this.engine.currentRound;
                if (!r || !r.isActive || r.settled) return;
                const myRound = this.engine.roundNumber;
                const myStage = Number(r.currentStage) || 0;

                if (dbRound !== myRound) {
                    await OnlineManager.setRoundData(r.cards, r.target, myRound, this.engine.totalRounds, myStage);
                    await OnlineManager.updateScores(this.engine.getAuthoritativeScores());
                    return;
                }
                if (myStage > 0 && gs.phase !== 'reading' && gs.phase !== 'finished') {
                    await OnlineManager.updateStage(myStage, myRound);
                    return;
                }
                const dbScores = gs.scores || {};
                const mine = this.engine.getAuthoritativeScores();
                if (this.num(dbScores.player) !== mine.player || this.num(dbScores.opponent) !== mine.opponent) {
                    await OnlineManager.updateScores(mine);
                    return;
                }
                this.engine.ensureReading();
            } else {
                this.onlineGameState = gs;
                if (gs.phase === 'reading') this.updateOnlineClue(gs);
            }
        } catch (e) { console.error('onlineWatchdogTick error:', e); }
    }

    async syncOnlineGameState(gameState, roomData) {
        if (!gameState) return;
        const mySeq = ++this.syncSeq;
        this.onlineGameState = gameState;

        const round = Number(gameState.round) || 0;
        const phase = gameState.phase || 'waiting';
        const roundChanged = (round !== this.onlineRound);

        if (roundChanged) {
            this.onlineRound = round;
            this.hasShownResult = false;
            this.renderedRound = -1;
            this.processedTaps = {};
            this.historyTargetId = null;
            this.scoredRemoteRound = -1;
            this._guestRoundStart = Date.now();
            this.stopFinalCountdown();
            this.closeRoundResultModal();
        }

        const scores = gameState.scores || {};
        let myScore, oppScore;
        if (this.isHost) {
            const mine = this.engine.getAuthoritativeScores();
            myScore = mine.player; oppScore = mine.opponent;
        } else {
            myScore = this.num(scores.opponent); oppScore = this.num(scores.player);
        }
        this.setText('score-player', myScore);
        this.setText('score-cpu', oppScore);

        const total = this.num(gameState.totalRounds) || this.engine.totalRounds || 10;
        this.setText('round-display', round + ' / ' + total);

        const cards = gameState.cards;
        if (!this.isHost && Array.isArray(cards) && cards.length > 0 && this.renderedRound !== round) {
            this.renderedRound = round;
            this.resetClueDisplay();
            this.applyCardGridLayout(cards.length);       // ★C
            this.renderCards(cards, false).catch(() => { });
        }

        if (phase === 'reading') {
            if (!this.isHost) this._guestStageStart = this._guestStageStart || Date.now();
            this.updateOnlineClue(gameState);
        }
        else if (phase === 'dealing' && roundChanged && !this.isHost) {
            this._guestStageStart = 0;
            this.resetClueDisplay();
        }

        if (phase === 'result' && !this.hasShownResult) {
            const resultRound = (gameState.resultRound === undefined || gameState.resultRound === null)
                ? round : Number(gameState.resultRound);
            if (resultRound === round) {
                const winner = gameState.roundWinner;
                if (this.isHost) {
                    if (resultRound !== this.engine.roundNumber && this.engine.currentRound.isActive) {
                        const r = this.engine.currentRound;
                        OnlineManager.setRoundData(r.cards, r.target, this.engine.roundNumber,
                            this.engine.totalRounds, Number(r.currentStage) || 0);
                        this.syncScoresToRoom();
                        return;
                    }
                    this.hasShownResult = true;
                    if (this.engine.currentRound.isActive && !this.engine.currentRound.settled) {
                        this.engine.forceRoundEndLocal(resultRound);
                    }
                    if (winner === 'opponent' && this.scoredRemoteRound !== resultRound) {
                        this.creditOpponentFromRoom(resultRound, gameState.target || null);
                    }
                    this.syncScoresToRoom();
                } else {
                    this.hasShownResult = true;
                }
                if (mySeq !== this.syncSeq) return;
                const target = gameState.target;
                if (target) {
                    const clueData = this.engine.clues[String(target.id || '').trim()];
                    const explanation = (clueData && clueData.explanation) ? clueData.explanation : '解説データなし';
                    this.showRoundResult({
                        playerWon: this.isHost ? (winner === 'player') : (winner === 'opponent'),
                        target: target, explanation: explanation
                    });
                }
            }
        }

        if (phase === 'finished' && !this.gameEndShown) {
            this.gameEndShown = true;
            const s = gameState.scores || {};
            let mine, other;
            if (this.isHost) {
                const a = this.engine.getAuthoritativeScores();
                mine = a.player; other = a.opponent;
            } else {
                mine = this.num(s.opponent); other = this.num(s.player);
            }
            this.showGameEnd({
                playerScore: mine, cpuScore: other, maxCombo: this.engine.maxCombo,
                winner: mine > other ? 'player' : (mine < other ? 'cpu' : 'draw')
            });
        }
        this.updateFooterState();
    }

    creditOpponentFromRoom(resultRound) {
        if (!this.isHost || !this.isOnlineMode) return;
        if (this.scoredRemoteRound === resultRound) return;
        if (this.engine.roundNumber !== resultRound) return;
        const stage = (this.onlineGameState && Number(this.onlineGameState.currentStage)) ||
            (this.engine.currentRound && this.engine.currentRound.currentStage) || 1;
        const scored = this.engine.scoreOpponentCorrect(stage);
        this.scoredRemoteRound = resultRound;
        if (scored) this.syncScoresToRoom();
    }

    num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

    resetClueDisplay() {
        const historyEl = document.getElementById('clue-history');
        if (historyEl) historyEl.innerHTML = '';
        const stageEl = document.getElementById('clue-stage');
        if (stageEl) stageEl.textContent = 'STAGE 1';
        const textEl = document.getElementById('clue-text');
        if (textEl) textEl.textContent = '読み札がここに表示されます';
        this.historyTargetId = null;
        this.removeFinalCountdown();
        const cluePanel = document.querySelector('.clue-display');
        if (cluePanel) cluePanel.scrollTop = 0;
    }

    /* ========================= タップ処理 ========================= */
    handleCardTap(id, element) {
        if (this.hasShownResult) return;
        if (this.isOnlineMode) { this.handleOnlineCardTap(id, element); return; }
        this.engine.handlePlayerTap(id);
        const target = this.engine.currentRound.target;
        const targetId = String(target ? target.id : '').trim();
        if (String(id || '').trim() === targetId && element) element.classList.add('correct');
        this.updateFooterState();
    }

    async handleOnlineCardTap(id, element) {
        if (!this.isOnlineMode) return;
        const gs = this.onlineGameState;
        if (!gs || !gs.target) return;
        if (this.hasShownResult) return;
        if (gs.phase !== 'dealing' && gs.phase !== 'reading') return;

        const tapId = String(id || '').trim();
        const targetId = String(gs.target.id || '').trim();
        const isCorrect = (tapId === targetId);
        const round = Number(gs.round) || 0;
        const stage = Number(gs.currentStage) || 0;
        this.tapSeq++;
        const meta = { round: round, stage: stage, seq: this.tapSeq };

        // ★D: ゲスト側の反応時間も内部時計で計測して記録
        if (!this.isHost) this.recordGuestAnswer(isCorrect, stage, gs.target);

        if (this.isHost) {
            this.engine.handlePlayerTap(tapId);
            if (isCorrect && element) element.classList.add('correct');
            this.syncScoresToRoom();
            try { await OnlineManager.recordTap(tapId, meta); } catch (e) { }
            return;
        }

        if (isCorrect) {
            if (element) element.classList.add('correct');
            this.hasShownResult = true;
            try { AudioManager.playSound('correct'); } catch (e) { }
            const clueData = this.engine.clues[targetId];
            const explanation = (clueData && clueData.explanation) ? clueData.explanation : '解説データなし';
            this.showRoundResult({ playerWon: true, target: gs.target, explanation: explanation });
            try { await OnlineManager.recordTap(tapId, meta); } catch (e) { }
            try {
                await OnlineManager.updateGameState({ phase: 'result', roundWinner: 'opponent', resultRound: round });
            } catch (e) { console.error(e); }
            return;
        }

        if (element) {
            element.classList.add('wrong');
            setTimeout(() => element.classList.remove('wrong'), 600);
        }
        try { AudioManager.playSound('wrong'); } catch (e) { }
        try { await OnlineManager.recordTap(tapId, meta); } catch (e) { }
    }

    recordGuestAnswer(isCorrect, stage, target) {
        const now = Date.now();
        const base = this._guestStageStart || this._guestRoundStart || now;
        const rec = {
            t: now, mode: 'online', difficulty: 0,
            compoundId: target ? String(target.id || '').trim() : '',
            compoundName: target ? (target.name || '') : '',
            category: target ? (target.category || '') : '',
            correct: !!isCorrect,
            stage: Number(stage) || 0,
            maxStage: 4,
            reactionMs: Math.max(0, Math.round(now - base)),
            stageReactionMs: Math.max(0, Math.round(now - base)),
            combo: 0, missesBefore: isCorrect ? 0 : 1,
            cardCount: SettingsStore.get('cardCount'),
            round: this.onlineRound, perfect: !!isCorrect
        };
        try { ProgressManager.addRecord(rec); } catch (e) { }
        if (!isCorrect) this._guestStageStart = now;
    }

    handleRemoteTaps(taps) {
        if (!this.isOnlineMode || !taps) return;

        if (!this.isHost) {
            Object.keys(taps).forEach(pid => {
                const tap = taps[pid];
                if (!tap || !tap.cardId) return;
                const key = (tap.round || 0) + '_' + (tap.seq || tap.timestamp || 0) + '_' + tap.cardId;
                if (this.processedTaps[pid] === key) return;
                this.processedTaps[pid] = key;
                const gs = this.onlineGameState;
                if (gs && tap.round && Number(tap.round) !== Number(gs.round || 0)) return;
                const tapId = String(tap.cardId).trim();
                const cardEl = this.findCardElement(tapId);
                if (!cardEl) return;
                const targetId = gs && gs.target ? String(gs.target.id || '').trim() : '';
                if (tapId === targetId) cardEl.classList.add('correct');
                else { cardEl.classList.add('wrong'); setTimeout(() => cardEl.classList.remove('wrong'), 600); }
            });
            return;
        }

        const round = this.engine.currentRound;
        if (!round || !round.target) return;
        const targetId = String(round.target.id || '').trim();
        const currentRoundNo = this.engine.roundNumber;

        Object.keys(taps).forEach(pid => {
            const tap = taps[pid];
            if (!tap || !tap.cardId) return;
            const tapRound = Number(tap.round) || 0;
            if (tapRound && tapRound !== currentRoundNo) return;
            const key = tapRound + '_' + (tap.seq || tap.timestamp || 0) + '_' + tap.cardId;
            if (this.processedTaps[pid] === key) return;
            this.processedTaps[pid] = key;

            const tapId = String(tap.cardId).trim();
            const cardEl = this.findCardElement(tapId);
            const isCorrect = (tapId === targetId);

            if (isCorrect) {
                if (cardEl) cardEl.classList.add('correct');
                const stage = Number(tap.stage) || round.currentStage || 1;
                const scored = this.engine.scoreOpponentCorrect(stage);
                this.scoredRemoteRound = currentRoundNo;
                if (!scored) return;
                if (round.isActive && !round.settled) this.engine._finishRound(false, 'opponent');
                else {
                    this.syncScoresToRoom();
                    if (!this.hasShownResult) {
                        this.hasShownResult = true;
                        const clueData = this.engine.clues[targetId];
                        this.showRoundResult({
                            playerWon: false, target: round.target,
                            explanation: (clueData && clueData.explanation) ? clueData.explanation : '解説データなし',
                            reason: 'opponent'
                        });
                    }
                }
            } else {
                if (cardEl) { cardEl.classList.add('wrong'); setTimeout(() => cardEl.classList.remove('wrong'), 600); }
                if (this.engine.scoreOpponentWrong()) this.syncScoresToRoom();
            }
        });
    }

    findCardElement(id) {
        const grid = document.getElementById('card-grid');
        if (!grid) return null;
        const safeId = (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id);
        try { return grid.querySelector('.card[data-id="' + safeId + '"]'); }
        catch (e) {
            return Array.from(grid.querySelectorAll('.card')).find(c => c.dataset.id === String(id)) || null;
        }
    }

    flashCard(id, type) {
        const card = this.findCardElement(id);
        if (card) { card.classList.add(type); setTimeout(() => card.classList.remove(type), 600); }
    }

    /* ========================= ゲームUI ========================= */
    async updateGameUI(data) {
        if (!data) return;

        const scores = data.scores || { player: 0, opponent: 0 };
        this.setText('score-player', scores.player || 0);
        this.setText('score-cpu', scores.opponent || 0);
        this.setText('round-display', data.roundNumber + ' / ' + data.totalRounds);

        switch (data.state) {
            case 'DEAL':
                if (this._dealing && this._dealingRound === data.roundNumber) break;  // 二重描画防止
                this.hasShownResult = false;
                this.historyTargetId = null;
                this.scoredRemoteRound = -1;
                this.stopFinalCountdown();
                this.closeRoundResultModal();
                if (this.isOnlineMode) {
                    this.onlineRound = data.roundNumber;
                    this.renderedRound = data.roundNumber;
                    this.processedTaps = {};
                    if (this.isHost) {
                        this.resetClueDisplay();
                        await this.renderCards(data.round.cards, true);
                    }
                } else {
                    this.resetClueDisplay();
                    await this.renderCards(data.round.cards, true);
                }
                break;
            case 'READING':
                this.updateClueWithHistory(data.round);
                break;
            case 'RESULT':
                this.stopFinalCountdown();
                break;
        }

        if (data.type === 'final_stage') this.startFinalCountdown();
        if (data.type === 'wrong' || data.type === 'cpu_wrong') this.flashCard(data.id, 'wrong');
        this.updateFooterState();
    }

    updateFooterState() {
        const canNext = this.engine.canNextClue ? this.engine.canNextClue() : false;
        const isFinal = this.engine.isFinalStage ? this.engine.isFinalStage() : false;
        const guestTurn = this.isOnlineMode && !this.isHost;

        const nextBtn = document.getElementById('btn-next-clue');
        if (nextBtn) {
            nextBtn.disabled = !canNext || guestTurn || this.hasShownResult || this._dealing;
            nextBtn.textContent = isFinal ? '最終札' : '次の札';
            nextBtn.title = isFinal ? '読み札はすべて読み終えました' : '次の読み札へ';
        }
        const skipBtn = document.getElementById('btn-skip');
        if (skipBtn) skipBtn.disabled = guestTurn || this.hasShownResult || this._dealing;
        const hintBtn = document.getElementById('btn-hint');
        if (hintBtn) hintBtn.disabled = this.hasShownResult;

        if (isFinal && !document.getElementById('final-countdown') && !this.hasShownResult &&
            this.engine.finalDeadline > Date.now()) {
            this.startFinalCountdown();
        }
    }

    startFinalCountdown() {
        this.stopFinalCountdown(false);
        const host = document.querySelector('#screen-game .clue-display') || document.getElementById('screen-game');
        if (!host) return;

        let el = document.getElementById('final-countdown');
        if (!el) {
            el = document.createElement('div');
            el.id = 'final-countdown';
            el.className = 'final-countdown';
            host.appendChild(el);
        }
        el.innerHTML =
            '<div class="fc-row"><span class="fc-label">読み札終了 ・ 時間切れで終了</span><span class="fc-time">--</span></div>' +
            '<div class="fc-bar"><i></i></div>';

        const tick = () => {
            const dl = this.engine.finalDeadline || 0;
            if (!dl) return;
            const remain = Math.max(0, dl - Date.now());
            const total = this.engine.FINAL_ANSWER_WINDOW || 10000;
            const timeEl = el.querySelector('.fc-time');
            const barEl = el.querySelector('.fc-bar > i');
            if (timeEl) timeEl.textContent = (remain / 1000).toFixed(1) + ' 秒';
            if (barEl) barEl.style.width = Math.max(0, Math.min(100, (remain / total) * 100)) + '%';
            el.classList.toggle('urgent', remain < 3000);
        };
        tick();
        this._finalCountdownTimer = setInterval(tick, 100);
        this.updateFooterState();
    }

    stopFinalCountdown(remove = true) {
        if (this._finalCountdownTimer) { clearInterval(this._finalCountdownTimer); this._finalCountdownTimer = null; }
        if (remove) this.removeFinalCountdown();
    }

    removeFinalCountdown() {
        if (this._finalCountdownTimer) { clearInterval(this._finalCountdownTimer); this._finalCountdownTimer = null; }
        const el = document.getElementById('final-countdown');
        if (el) el.remove();
    }

    /* ========================= ★A: カード描画（堅牢版） ========================= */
    applyCardGridLayout(count) {
        const grid = document.getElementById('card-grid');
        if (!grid) return;
        grid.classList.remove('cards-6', 'cards-9', 'cards-12', 'cards-16');
        grid.classList.add('cards-' + SettingsStore.normalizeCardCount(count));
    }

    _cardFallbackHTML(compound) {
        return '<div class="card-fallback">' +
            '<div class="compound-name">' + (compound.name || '') + '</div>' +
            '<div class="compound-formula">' + (compound.formula || '') + '</div></div>';
    }

    /**
     * カードを描画する。
     * ★ 修正A:
     *   1) まず全札の「枠＋スピナー」を DOM に出す（何があっても札は見える）
     *   2) キャッシュヒット分は同期注入（待ち時間ゼロ）
     *   3) 未取得分は“実要素へ直接” StructureRenderer.render（旧来動いていた経路）
     *   4) 描画成功分をスナップショットして次回以降キャッシュ化
     *   5) 全部終わってから engine.setCardsReady(true) → 読み上げ開始
     */
    async renderCards(cards, startReading) {
        const grid = document.getElementById('card-grid');
        if (!grid) return;

        const list = (cards || []).filter(c => c);
        const dealId = ++this._dealSeq;
        this._dealing = true;
        this._dealingRound = this.engine.roundNumber;
        this.engine.cardsReady = false;
        this.applyCardGridLayout(list.length);
        this.updateFooterState();

        grid.innerHTML = '';

        // 1) 枠を先に生成（可視性を保証）
        const entries = list.map(compound => {
            const div = document.createElement('div');
            div.className = 'card loading-card';
            div.dataset.id = String(compound.id || '').trim();
            const contentDiv = document.createElement('div');
            contentDiv.className = 'card-content';
            contentDiv.innerHTML = '<div class="card-loading"><div class="loading-spinner"></div></div>';
            div.appendChild(contentDiv);
            grid.appendChild(div);
            return { compound: compound, div: div, contentDiv: contentDiv, done: false };
        });

        if (list.length === 0) {
            this._dealing = false;
            this.engine.setCardsReady(true);
            if (startReading) this.engine.startReading(true);
            return;
        }

        // 2) キャッシュヒット分を同期注入
        const misses = [];
        entries.forEach(e => {
            if (StructureCache.applyTo(e.contentDiv, e.compound)) {
                e.div.classList.remove('loading-card');
                e.done = true;
            } else {
                misses.push(e);
            }
        });

        // 3) 未取得分は実要素へ直接描画
        if (misses.length > 0) {
            await Promise.race([
                Promise.all(misses.map((e, i) => this._renderOneCard(e, i, dealId))),
                new Promise(res => setTimeout(res, 15000))
            ]);
        }

        // 4) 未描画の札は名前フォールバック（絶対に空白にしない）
        entries.forEach(e => {
            if (dealId !== this._dealSeq) return;
            e.div.classList.remove('loading-card');
            if (!e.contentDiv.querySelector('img, svg, canvas')) {
                e.contentDiv.innerHTML = this._cardFallbackHTML(e.compound);
            }
            e.done = true;
        });

        if (dealId !== this._dealSeq) return;   // 別ラウンドが始まっていたら触らない

        await new Promise(r => requestAnimationFrame(() => r()));
        this._dealing = false;
        this.engine.setCardsReady(true);        // ★ 修正3: 全札描画後に読み上げ許可
        if (startReading) this.engine.startReading(true);
        this.updateFooterState();
        if (!this.isOnlineMode) StructureCache.resume();
    }

    async _renderOneCard(entry, index, dealId) {
        await new Promise(r => setTimeout(r, Math.min(index * 40, 400)));
        if (dealId !== this._dealSeq) return;
        const compound = entry.compound;
        const contentDiv = entry.contentDiv;
        try {
            if (compound.smiles && typeof StructureRenderer !== 'undefined') {
                await StructureRenderer.render(contentDiv, compound.smiles, 'light', {
                    name: compound.name, name_en: compound.name_en, formula: compound.formula
                });
            }
            if (!contentDiv.querySelector('img, svg, canvas')) {
                contentDiv.innerHTML = this._cardFallbackHTML(compound);
            } else {
                StructureCache.snapshot(compound, contentDiv);   // ★ 実要素から採取
            }
        } catch (e) {
            contentDiv.innerHTML = this._cardFallbackHTML(compound);
        } finally {
            entry.done = true;
            if (dealId === this._dealSeq) entry.div.classList.remove('loading-card');
        }
    }

    updateClueWithHistory(round) {
        if (!round || !round.target) return;
        const targetId = String(round.target.id || '').trim();
        const clueData = this.engine.clues[targetId];
        if (!clueData || !Array.isArray(clueData.stages)) return;

        const currentStage = Number(round.currentStage) || 0;
        if (currentStage < 1) return;
        const currentStageData = clueData.stages.find(s => s.stage === currentStage);
        if (!currentStageData) return;

        const stageEl = document.getElementById('clue-stage');
        const textEl = document.getElementById('clue-text');
        if (stageEl) stageEl.textContent = 'STAGE ' + currentStage;
        if (textEl) textEl.textContent = currentStageData.text;

        const historyDiv = document.getElementById('clue-history');
        if (!historyDiv) return;
        if (this.historyTargetId !== targetId) { historyDiv.innerHTML = ''; this.historyTargetId = targetId; }

        const existing = new Set();
        historyDiv.querySelectorAll('.clue-history-item').forEach(item => existing.add(String(item.dataset.stage)));

        let added = false;
        for (let s = 1; s < currentStage; s++) {
            if (existing.has(String(s))) continue;
            const prevData = clueData.stages.find(x => x.stage === s);
            if (!prevData) continue;
            const historyItem = document.createElement('div');
            historyItem.className = 'clue-history-item';
            historyItem.dataset.stage = String(s);
            const label = document.createElement('span');
            label.className = 'stage-label';
            label.textContent = 'STAGE ' + s;
            const body = document.createElement('div');
            body.textContent = prevData.text;
            historyItem.appendChild(label);
            historyItem.appendChild(body);
            historyDiv.appendChild(historyItem);
            existing.add(String(s));
            added = true;
        }
        if (added) {
            requestAnimationFrame(() => {
                const cluePanel = document.querySelector('.clue-display');
                if (cluePanel) cluePanel.scrollTo({ top: cluePanel.scrollHeight, behavior: 'smooth' });
            });
        }
        if (currentStage === 1) {
            const cluePanel = document.querySelector('.clue-display');
            if (cluePanel) cluePanel.scrollTop = 0;
        }
    }

    /* ========================= モーダル ========================= */
    closeRoundResultModal() {
        if (this.roundResultModal) {
            try { this.roundResultModal.remove(); } catch (e) { }
            this.roundResultModal = null;
        }
        const legacy = document.getElementById('round-result-modal');
        if (legacy) legacy.remove();
    }

    closeAllModals() {
        this.stopFinalCountdown();
        this.closeRoundResultModal();
        document.querySelectorAll('.modal-screen').forEach(m => { try { m.remove(); } catch (e) { } });
        const ge = document.getElementById('game-end-modal');
        if (ge) ge.remove();
        const rd = document.getElementById('reference-detail-modal');
        if (rd) rd.classList.remove('active');
    }

    showRoundResult(data) {
        if (!data) return;
        if (this.roundResultModal && !document.body.contains(this.roundResultModal)) this.roundResultModal = null;
        if (this.roundResultModal) return;
        this.closeRoundResultModal();

        this.hasShownResult = true;
        this.stopFinalCountdown();
        this._dealing = false;
        this.updateFooterState();

        const playerWon = !!data.playerWon;
        const reason = data.reason || null;
        const compound = data.target || {};
        const explanation = data.explanation || '解説はありません。';
        const perfect = !!data.perfect;
        const rankIdx = ProgressManager.rankIndex;

        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.id = 'round-result-modal';

        let resultTitle, resultColor;
        if (this.isPracticeMode) {
            resultTitle = playerWon ? '正解' : '確認';
            resultColor = playerWon ? '#22c55e' : 'var(--accent-gold)';
        } else if (reason === 'timeout') {
            resultTitle = '時間切れ'; resultColor = 'var(--accent-gold)';
        } else if (reason === 'skip') {
            resultTitle = 'スキップ'; resultColor = 'var(--accent-gold)';
        } else {
            resultTitle = playerWon ? (perfect ? '一発正解' : '正解') : (this.isOnlineMode ? '相手の取りです' : '不正解');
            resultColor = playerWon ? '#22c55e' : 'var(--accent-red)';
        }

        const sc = (this.isHost || !this.isOnlineMode)
            ? this.engine.getAuthoritativeScores()
            : (() => { const s = (this.onlineGameState && this.onlineGameState.scores) || {}; return { player: this.num(s.player), opponent: this.num(s.opponent) }; })();
        const myNow = (this.isHost || !this.isOnlineMode) ? sc.player : sc.opponent;
        const oppNow = (this.isHost || !this.isOnlineMode) ? sc.opponent : sc.player;

        // ★G: 段位特典（反応時間の表示）
        let timingHtml = '';
        const recs = ProgressManager.data.records || [];
        const lastRec = recs.length ? recs[recs.length - 1] : null;
        if (rankIdx >= 3 && lastRec) {
            timingHtml += '<span>あなたの反応 <b>' + lastRec.reactionMs + '</b> ms</span>';
        }
        if (rankIdx >= 4 && this.engine.lastCpuReactionMs > 0 && !this.isOnlineMode) {
            timingHtml += '<span>CPUの思考 <b>' + this.engine.lastCpuReactionMs + '</b> ms</span>';
        }
        if (timingHtml) timingHtml = '<div class="timing-row">' + timingHtml + '</div>';

        const targetId = String(compound.id || '').trim();
        const unlockedNow = targetId && ProgressManager.isUnlocked(targetId);
        let lockBadge = '';
        if (!this.isOnlineMode) {
            if (unlockedNow) lockBadge = '<div class="unlock-badge">🔓 資料解放済み</div>';
            else if (this.isPracticeMode) lockBadge = '<div class="lock-badge">練習モードは解放対象外</div>';
            else if (playerWon && !perfect) lockBadge = '<div class="lock-badge">🔒 誤答あり → 解放されません</div>';
            else lockBadge = '<div class="lock-badge">🔒 誤答なしの一発正解で解放</div>';
        }

        modal.innerHTML =
            '<div class="modal-content" style="background:var(--card-bg);border:3px solid ' + resultColor + ';border-radius:2px;padding:25px 20px;max-width:420px;width:92%;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,0.5);">' +
            '<h2 style="font-size:1.8rem;margin-bottom:15px;color:' + resultColor + ';font-family:var(--font-display);letter-spacing:.15em;text-indent:.15em;">' + resultTitle + '</h2>' +
            '<div style="background:var(--tatami-light);border-radius:2px;padding:15px;margin-bottom:15px;min-height:130px;border:2px solid var(--card-border);">' +
            '<div id="modal-structure" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;"></div></div>' +
            '<div class="modal-name"></div>' +
            '<div class="modal-formula" style="font-size:0.9rem;color:var(--text-light);margin-bottom:8px;"></div>' +
            lockBadge +
            '<div style="display:flex;justify-content:space-around;gap:10px;margin:15px 0;">' +
            '<div style="flex:1;background:var(--tatami-light);border:2px solid var(--card-border);border-radius:2px;padding:8px 4px;">' +
            '<div style="font-size:0.7rem;color:var(--text-light);letter-spacing:.1em;font-family:var(--font-display);">あなた</div>' +
            '<div class="modal-my-score" style="font-size:1.4rem;font-weight:900;color:var(--accent-green);font-family:var(--font-display);">' + myNow + '</div></div>' +
            '<div style="flex:1;background:var(--tatami-light);border:2px solid var(--card-border);border-radius:2px;padding:8px 4px;">' +
            '<div style="font-size:0.7rem;color:var(--text-light);letter-spacing:.1em;font-family:var(--font-display);">' + (this.isOnlineMode ? '相手' : 'CPU') + '</div>' +
            '<div class="modal-opp-score" style="font-size:1.4rem;font-weight:900;color:var(--accent-red);font-family:var(--font-display);">' + oppNow + '</div></div></div>' +
            timingHtml +
            '<div style="font-size:0.85rem;color:var(--text-dark);line-height:1.7;margin-bottom:20px;text-align:left;background:var(--tatami-light);padding:12px 14px;border-radius:2px;border-left:4px solid var(--accent-gold);font-family:var(--font-main);">' +
            '<div style="font-size:0.75rem;font-weight:700;color:var(--accent-green);letter-spacing:.1em;margin-bottom:4px;font-family:var(--font-display);">解説</div>' +
            '<div class="modal-explanation"></div></div>' +
            '<button class="btn btn-primary" id="modal-next-btn" style="width:100%;">次の問題へ</button>' +
            '</div>';
        document.body.appendChild(modal);
        this.roundResultModal = modal;

        const nameEl = modal.querySelector('.modal-name');
        if (nameEl) nameEl.textContent = compound.name || '';
        const formulaEl = modal.querySelector('.modal-formula');
        if (formulaEl) formulaEl.textContent = compound.formula || '';
        const expEl = modal.querySelector('.modal-explanation');
        if (expEl) expEl.textContent = explanation;

        const structureDiv = document.getElementById('modal-structure');
        if (structureDiv) {
            if (!StructureCache.applyTo(structureDiv, compound)) {
                if (compound.smiles) {
                    StructureRenderer.render(structureDiv, compound.smiles, 'light', {
                        name: compound.name, name_en: compound.name_en, formula: compound.formula
                    }).then(() => { StructureCache.snapshot(compound, structureDiv); }).catch(() => { });
                }
            }
        }

        const nextBtn = document.getElementById('modal-next-btn');
        if (nextBtn) {
            if (this.isOnlineMode && !this.isHost) {
                nextBtn.textContent = '相手の進行を待っています…';
                nextBtn.disabled = true;
                nextBtn.style.opacity = '0.6';
            } else {
                nextBtn.addEventListener('click', () => {
                    this.closeRoundResultModal();
                    this.hasShownResult = false;
                    this.removeFinalCountdown();
                    this.engine.startNewRound();
                    this.updateFooterState();
                });
            }
        }

        if (this.isOnlineMode) {
            this._refreshModalScores = () => {
                if (!this.roundResultModal) return;
                let m, o;
                if (this.isHost) { const a = this.engine.getAuthoritativeScores(); m = a.player; o = a.opponent; }
                else {
                    const s = (this.onlineGameState && this.onlineGameState.scores) || {};
                    m = this.num(s.opponent); o = this.num(s.player);
                }
                const mEl = this.roundResultModal.querySelector('.modal-my-score');
                const oEl = this.roundResultModal.querySelector('.modal-opp-score');
                if (mEl) mEl.textContent = m;
                if (oEl) oEl.textContent = o;
            };
            setTimeout(() => { if (this._refreshModalScores) this._refreshModalScores(); }, 700);
            setTimeout(() => { if (this._refreshModalScores) this._refreshModalScores(); }, 1800);
        }
    }

    showGameEnd(data) {
        if (!data) return;
        if (this.gameEndShown && this.isOnlineMode) return;
        this.gameEndShown = true;
        this.stopOnlineWatchdog();
        this.stopFinalCountdown();
        this._dealing = false;
        try { StorageManager.recordCpuResult(data.winner); } catch (e) { }

        const mode = this.isPracticeMode ? 'practice' : (this.isOnlineMode ? 'online' : 'cpu');
        const rw = this.engine.roundWins || {};
        const progress = ProgressManager.recordGameEnd({
            mode: mode,
            winner: data.winner,
            difficulty: this.isPracticeMode ? 0 : (this.selectedDifficulty || 0),
            correctRounds: rw.player || 0,
            perfectRounds: rw.perfect || 0,
            playerScore: data.playerScore || 0,
            cpuScore: data.cpuScore || 0
        });
        this._gameEndResult = progress;

        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.id = 'game-end-modal';

        const rankUpHtml = progress.rankUp ? '<div class="rankup-banner">昇段 ／ ' + progress.rankUp + '</div>' : '';
        const pointsHtml = progress.gained > 0 ? '<div class="points-gained">+' + progress.gained + ' pt 獲得</div>' : '';
        const newPriv = progress.rankUp ? '<p style="font-size:.75rem;color:var(--text-light);margin:-4px 0 14px;line-height:1.6;">特典解放：' + progress.rank.priv + '</p>' : '';

        if (this.isPracticeMode) {
            modal.innerHTML =
                '<div class="modal-content" style="background:var(--card-bg);border:3px solid var(--accent-gold);border-radius:2px;padding:25px 20px;max-width:420px;width:92%;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,0.5);">' +
                '<h2 style="font-size:1.8rem;margin-bottom:15px;color:var(--accent-gold);font-family:var(--font-display);letter-spacing:.2em;text-indent:.2em;">練習終了</h2>' +
                '<div style="background:var(--tatami-light);padding:20px;border-radius:2px;border:2px solid var(--card-border);margin-bottom:18px;">' +
                '<div style="font-size:0.85rem;color:var(--text-light);margin-bottom:8px;letter-spacing:.1em;font-family:var(--font-display);">TOTAL SCORE</div>' +
                '<div style="font-size:2.5rem;color:var(--accent-green);font-family:var(--font-display);font-weight:900;">' + (data.playerScore || 0) + '</div></div>' +
                '<p style="font-size:0.8rem;color:var(--text-light);margin-bottom:18px;line-height:1.6;">練習モードはポイント・解放の対象外です。<br>CPU戦で「誤答なしの一発正解」をすると資料が解放されます。</p>' +
                '<button class="btn btn-primary" id="modal-finish-btn" style="width:100%;">タイトルへ戻る</button></div>';
        } else {
            const playerLabel = this.isOnlineMode ? 'あなた' : 'PLAYER';
            const opponentLabel = this.isOnlineMode ? '相手' : 'CPU';
            const message = data.winner === 'player' ? '勝利' : (data.winner === 'cpu' ? '敗北' : '引き分け');
            modal.innerHTML =
                '<div class="modal-content" style="background:var(--card-bg);border:3px solid var(--accent-gold);border-radius:2px;padding:25px 20px;max-width:420px;width:92%;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,0.5);">' +
                '<h2 style="font-size:1.8rem;margin-bottom:15px;color:var(--accent-gold);font-family:var(--font-display);letter-spacing:.2em;text-indent:.2em;">ゲーム終了</h2>' +
                '<div style="font-size:1.4rem;margin-bottom:14px;color:var(--text-dark);font-family:var(--font-display);font-weight:700;letter-spacing:.1em;">' + message + '</div>' +
                rankUpHtml + pointsHtml + newPriv +
                '<div style="display:flex;justify-content:space-around;margin-bottom:14px;gap:15px;">' +
                '<div style="text-align:center;flex:1;background:var(--tatami-light);padding:12px 8px;border-radius:2px;border:2px solid var(--card-border);">' +
                '<div style="font-size:0.8rem;color:var(--text-light);margin-bottom:5px;letter-spacing:.1em;font-family:var(--font-display);">' + playerLabel + '</div>' +
                '<div style="font-size:1.8rem;color:var(--accent-green);font-family:var(--font-display);font-weight:900;">' + (data.playerScore || 0) + '</div></div>' +
                '<div style="text-align:center;flex:1;background:var(--tatami-light);padding:12px 8px;border-radius:2px;border:2px solid var(--card-border);">' +
                '<div style="font-size:0.8rem;color:var(--text-light);margin-bottom:5px;letter-spacing:.1em;font-family:var(--font-display);">' + opponentLabel + '</div>' +
                '<div style="font-size:1.8rem;color:var(--accent-red);font-family:var(--font-display);font-weight:900;">' + (data.cpuScore || 0) + '</div></div></div>' +
                '<div style="background:var(--tatami-light);border:2px solid var(--card-border);border-radius:2px;padding:10px;margin-bottom:12px;font-family:var(--font-display);">' +
                '<div style="font-size:0.72rem;color:var(--text-light);letter-spacing:.12em;margin-bottom:4px;">現在の段位</div>' +
                '<div style="font-size:1.15rem;font-weight:900;color:var(--accent-green);letter-spacing:.1em;">' + progress.rank.name + '</div>' +
                '<div style="font-size:0.85rem;color:var(--text-dark);margin-top:4px;">' + ProgressManager.points + ' pt ／ 通算 ' + ProgressManager.data.wins + ' 勝</div>' +
                '<div style="font-size:0.72rem;color:var(--text-light);margin-top:6px;line-height:1.5;">取った札 ' + (rw.player || 0) + ' ／ 一発正解 ' + (rw.perfect || 0) + ' ／ 時間切れ ' + (rw.timeout || 0) + '</div></div>' +
                '<div style="font-size:0.75rem;color:var(--text-light);margin-bottom:18px;line-height:1.6;">図鑑解放 ' + ProgressManager.unlockedCount() + ' / ' + (this.engine.compounds.length || 0) + '</div>' +
                '<button class="btn btn-primary" id="modal-finish-btn" style="width:100%;">タイトルへ戻る</button></div>';
        }
        document.body.appendChild(modal);

        const finishBtn = document.getElementById('modal-finish-btn');
        if (finishBtn) {
            finishBtn.addEventListener('click', async () => {
                modal.remove();
                if (this.isOnlineMode && typeof OnlineManager !== 'undefined') {
                    try { await OnlineManager.leaveRoom(); } catch (e) { }
                }
                this.resetOnlineState();
                this.showScreen('screen-title');
                StructureCache.resume();
            });
        }
    }

    /* ========================= 難易度・単元 ========================= */
    renderCategoryGrid() {
        const grid = document.getElementById('category-grid');
        if (!grid) return;
        grid.innerHTML = '';
        const categories = this.engine.getCategories();
        this.selectedCategories = categories.slice();
        this.allCategoriesSelected = true;

        categories.forEach(cat => {
            const tag = document.createElement('button');
            tag.className = 'category-tag selected';
            tag.textContent = this.getCategoryDisplayName(cat);
            tag.dataset.category = cat;
            tag.addEventListener('click', () => {
                tag.classList.toggle('selected');
                if (tag.classList.contains('selected')) {
                    if (!this.selectedCategories.includes(cat)) this.selectedCategories.push(cat);
                } else {
                    this.selectedCategories = this.selectedCategories.filter(c => c !== cat);
                }
                this.allCategoriesSelected = (this.selectedCategories.length === categories.length);
                this.updateSelectAllButtonText();
                StructureCache.prioritize(this.selectedCategories);
            });
            grid.appendChild(tag);
        });
        this.updateSelectAllButtonText();
    }

    updateSelectAllButtonText() {
        const btn = document.getElementById('btn-select-all');
        if (btn) btn.textContent = this.allCategoriesSelected ? 'すべて解除' : 'すべて選択';
    }

    toggleSelectAllCategories() {
        const tags = document.querySelectorAll('.category-tag');
        const shouldSelect = !this.allCategoriesSelected;
        tags.forEach(tag => tag.classList.toggle('selected', shouldSelect));
        this.selectedCategories = shouldSelect ? this.engine.getCategories() : [];
        this.allCategoriesSelected = shouldSelect;
        this.updateSelectAllButtonText();
        StructureCache.prioritize(this.selectedCategories);
    }

    updateDifficultySelection() {
        document.querySelectorAll('.diff-btn').forEach(btn => {
            btn.classList.remove('selected');
            if (parseInt(btn.dataset.level, 10) === this.selectedDifficulty) btn.classList.add('selected');
        });
    }

    startGame() {
        this.isPracticeMode = (this.selectedDifficulty === 0);
        this.isOnlineMode = false;
        this.isHost = false;
        this.onlineGameStarted = false;
        this.gameEndShown = false;
        this.hasShownResult = false;
        this.historyTargetId = null;
        this.renderedRound = -1;
        this.onlineRound = -1;
        this.scoredRemoteRound = -1;
        this._dealing = false;
        this._dealingRound = -1;
        this.stopOnlineWatchdog();
        this.stopFinalCountdown();
        this.closeRoundResultModal();

        const cardCount = SettingsStore.get('cardCount');
        const settings = {
            mode: this.isPracticeMode ? 'practice' : 'cpu',
            isOnline: false, isHost: false,
            cpuLevel: this.isPracticeMode ? 0 : this.selectedDifficulty,
            cardCount: cardCount,
            categories: this.selectedCategories.length > 0 ? this.selectedCategories : []
        };
        this.engine.configure(settings);
        this.engine.onOnlineStateChange = null;
        this.applyCardGridLayout(cardCount);

        const gameScreen = document.getElementById('screen-game');
        if (gameScreen) {
            if (this.isPracticeMode) gameScreen.classList.add('practice-mode');
            else gameScreen.classList.remove('practice-mode');
        }
        this.setText('player-score-label', '得点');
        this.setText('cpu-score-label', this.isPracticeMode ? '' : 'CPU');

        StructureCache.pause();
        StructureCache.prioritize(this.selectedCategories);

        this.showScreen('screen-game');
        this.engine.startGame(10);
        this.updateFooterState();
    }

    showHint() {
        let target = this.engine.currentRound ? this.engine.currentRound.target : null;
        if (!target && this.onlineGameState) target = this.onlineGameState.target;
        if (!target) return;
        alert('ヒント: ' + this.getCategoryDisplayName(target.category) + ' / 分子式: ' + target.formula);
    }

    /* ========================= ★D: 統計（詳細グラフ） ========================= */
    updateStats() {
        let summary = null;
        try { summary = StorageManager.getSummary(); } catch (e) { summary = null; }
        const p = ProgressManager.data;
        const st = ProgressManager.stats();

        this.setText('stat-games', p.gamesPlayed || (summary ? summary.totalGames : 0));
        this.setText('stat-accuracy', (st.total ? st.accuracy : (summary ? summary.accuracy : 0)) + '%');
        this.setText('stat-max-combo', summary ? summary.maxCombo : 0);
        this.setText('stat-cpu-wins', p.wins);
        this.setText('stat-cpu-losses', p.losses);
        this.setText('stat-cpu-draws', p.draws);
        this.setText('stat-cpu-winrate', ProgressManager.winRate() + '%');
        this.setText('profile-total-score', ProgressManager.points + ' pt');
        this.renderRankPanel();
        this.renderDetailedStats();

        if (summary) {
            const diffNames = { 0: '練習', 1: '易しい', 3: '普通', 7: '難しい' };
            this.renderBarGraph('category-bars', st.total ? st.byCategory : summary.byCategory, (cat) => this.getCategoryDisplayName(cat));
            this.renderBarGraph('difficulty-bars', summary.byDifficulty, (d) => diffNames[d] || ('Lv.' + d));
            this.renderBarGraph('stage-bars', st.total ? this._stageAccuracy(st.byStage) : summary.byStage, (s) => 'STAGE ' + s);
            this.renderHistory(summary.history);
        } else {
            this.renderBarGraph('category-bars', st.byCategory, (cat) => this.getCategoryDisplayName(cat));
            this.renderBarGraph('stage-bars', this._stageAccuracy(st.byStage), (s) => 'STAGE ' + s);
        }
    }

    _stageAccuracy(byStage) {
        const out = {};
        Object.keys(byStage || {}).forEach(k => {
            out[k] = { correct: byStage[k].correct, wrong: byStage[k].wrong };
        });
        return out;
    }

    /** 詳細統計（グラフ）を .stats-container に注入 */
    renderDetailedStats() {
        const container = document.querySelector('.stats-container');
        if (!container) return;
        let host = document.getElementById('stats-extra');
        if (!host) {
            host = document.createElement('div');
            host.id = 'stats-extra';
            const profile = container.querySelector('.profile-card');
            if (profile && profile.nextSibling) container.insertBefore(host, profile.nextSibling);
            else container.appendChild(host);
        }

        const rankIdx = ProgressManager.rankIndex;
        const st = ProgressManager.stats();
        const matches = ProgressManager.data.matches || [];

        // ★特典: 中級者(index2)未満は詳細グラフをロック
        if (rankIdx < 2) {
            host.innerHTML =
                '<div class="chart-block"><div class="chart-title">詳細分析</div>' +
                '<div class="locked-feature"><div class="lf-icon">🔒</div>' +
                '<div class="lf-text">反応時間分布・ポイント推移などの詳細グラフは<br>段位「中級者」以上で開放されます。</div>' +
                '<div class="lf-need">あと ' + ProgressManager.rankOf(ProgressManager.points).need + ' pt で開放</div></div></div>' +
                this._privilegeBlock(rankIdx);
            return;
        }

        if (st.total === 0) {
            host.innerHTML =
                '<div class="chart-block"><div class="chart-title">詳細分析</div>' +
                '<div class="chart-empty">対戦データがありません。CPU戦をプレイすると計測されます。</div></div>' +
                this._privilegeBlock(rankIdx);
            return;
        }

        // --- 反応時間ヒストグラム ---
        const buckets = [
            { label: '0-1s', min: 0, max: 1000 }, { label: '1-2s', min: 1000, max: 2000 },
            { label: '2-3s', min: 2000, max: 3000 }, { label: '3-4s', min: 3000, max: 4000 },
            { label: '4-5s', min: 4000, max: 5000 }, { label: '5-6s', min: 5000, max: 6000 },
            { label: '6-8s', min: 6000, max: 8000 }, { label: '8s+', min: 8000, max: Infinity }
        ];
        buckets.forEach(b => { b.count = st.times.filter(t => t >= b.min && t < b.max).length; });
        const maxCount = Math.max(1, ...buckets.map(b => b.count));
        const histHtml = buckets.map(b => {
            const h = Math.round((b.count / maxCount) * 100);
            return '<div class="hist-col"><div class="hist-count">' + (b.count || '') + '</div>' +
                '<div class="hist-bar" style="height:' + Math.max(2, h) + '%"></div>' +
                '<div class="hist-label">' + b.label + '</div></div>';
        }).join('');

        // --- STAGE別（正答率＋平均反応） ---
        const stageKeys = Object.keys(st.byStage).sort((a, b) => Number(a) - Number(b));
        const stageRows = stageKeys.map(k => {
            const s = st.byStage[k];
            const total = s.correct + s.wrong;
            const rate = total ? Math.round((s.correct / total) * 100) : 0;
            const avg = s.n ? Math.round(s.time / s.n) : 0;
            return '<div class="bar-item"><div class="bar-label">STAGE ' + k + '</div>' +
                '<div class="bar-track"><div class="bar-fill ' + (rate < 50 ? 'low' : '') + '" style="width:' + rate + '%"></div></div>' +
                '<div class="bar-value">' + rate + '%</div>' +
                '<div class="bar-value" style="width:62px;color:var(--card-bg);">' + (avg ? (avg / 1000).toFixed(2) + 's' : '-') + '</div></div>';
        }).join('');

        // --- ポイント推移 ---
        const pointSeries = [];
        let acc = 0;
        matches.slice(-30).forEach(m => { acc += (m.points || 0); pointSeries.push(acc); });
        const basePoints = ProgressManager.points - acc;
        const lineValues = pointSeries.map(v => v + basePoints);

        // --- 直近の勝敗 ---
        const strip = matches.slice(-20).map(m => {
            const cls = m.winner === 'player' ? 'win' : (m.winner === 'cpu' ? 'lose' : 'draw');
            const h = m.winner === 'player' ? 100 : (m.winner === 'cpu' ? 45 : 70);
            return '<div class="match-cell ' + cls + '" style="height:' + h + '%" title="' +
                new Date(m.t).toLocaleDateString() + ' ' + (m.winner === 'player' ? '勝利' : m.winner === 'cpu' ? '敗北' : '引分') + '"></div>';
        }).join('');

        const diff = ProgressManager.data;
        const accPct = st.accuracy;

        host.innerHTML =
            // KPI
            '<div class="chart-block">' +
            '<div class="chart-title">反応時間（内部時計計測）</div>' +
            '<div class="chart-sub">正解 ' + st.correct + ' 件 / 全 ' + st.total + ' 件のタップを計測</div>' +
            '<div class="kpi-grid">' +
            '<div class="kpi-item"><div class="kpi-label">平均</div><div class="kpi-value">' + (st.avg / 1000).toFixed(2) + '<span class="kpi-unit">s</span></div></div>' +
            '<div class="kpi-item gold"><div class="kpi-label">中央値</div><div class="kpi-value">' + (st.median / 1000).toFixed(2) + '<span class="kpi-unit">s</span></div></div>' +
            '<div class="kpi-item"><div class="kpi-label">最速</div><div class="kpi-value">' + (st.min / 1000).toFixed(2) + '<span class="kpi-unit">s</span></div></div>' +
            '<div class="kpi-item red"><div class="kpi-label">90%線</div><div class="kpi-value">' + (st.p90 / 1000).toFixed(2) + '<span class="kpi-unit">s</span></div></div>' +
            '</div></div>' +

            // ヒストグラム
            '<div class="chart-block">' +
            '<div class="chart-title">反応時間分布</div>' +
            '<div class="chart-sub">読み札開始から正解タップまでの時間（正解のみ）</div>' +
            '<div class="hist">' + histHtml + '</div>' +
            '</div>' +

            // ドーナツ
            '<div class="chart-block">' +
            '<div class="chart-title">正答 / 誤答 / 一発正解</div>' +
            '<div class="chart-sub">誤答なしで取り切った比率が高いほど資料が早く解放されます</div>' +
            '<div class="donut-wrap">' +
            '<div class="donut" style="background:conic-gradient(var(--accent-green) 0 ' + accPct + '%, var(--accent-red) ' + accPct + '% 100%)">' +
            '<div class="donut-center"><div><div class="donut-value">' + accPct + '%</div><div class="donut-label">正答率</div></div></div></div>' +
            '<div class="legend">' +
            '<div class="legend-item"><span class="legend-swatch" style="background:var(--accent-green)"></span>正解 ' + st.correct + '</div>' +
            '<div class="legend-item"><span class="legend-swatch" style="background:var(--accent-red)"></span>誤答 ' + st.wrong + '</div>' +
            '<div class="legend-item"><span class="legend-swatch" style="background:var(--accent-gold)"></span>一発正解 ' + st.perfect + '（' + st.perfectRate + '%）</div>' +
            '<div class="legend-item"><span class="legend-swatch" style="background:#6a4a6a"></span>最長コンボ ' + (this.engine.maxCombo || 0) + '</div>' +
            '</div></div></div>' +

            // STAGE別
            '<div class="chart-block">' +
            '<div class="chart-title">読み札ステージ別 正答率 / 平均反応</div>' +
            '<div class="chart-sub">早いステージで取れているほど高得点・解放に有利</div>' +
            (stageRows || '<div class="chart-empty">データなし</div>') +
            '</div>' +

            // ポイント推移
            '<div class="chart-block">' +
            '<div class="chart-title">ポイント推移（直近 ' + lineValues.length + ' 戦）</div>' +
            '<div class="chart-sub">現在の累計 ' + ProgressManager.points + ' pt</div>' +
            (lineValues.length >= 2 ? this._svgLineChart(lineValues) : '<div class="chart-empty">対戦が2回以上必要です</div>') +
            '</div>' +

            // 勝敗ストリップ
            '<div class="chart-block">' +
            '<div class="chart-title">直近 ' + Math.min(20, matches.length) + ' 戦の勝敗</div>' +
            '<div class="chart-sub">' + diff.wins + ' 勝 ' + diff.losses + ' 敗 ' + diff.draws + ' 分（勝率 ' + ProgressManager.winRate() + '%）</div>' +
            (strip ? '<div class="match-strip">' + strip + '</div>' +
                '<div class="match-legend"><span><i style="background:var(--accent-green)"></i>勝利</span>' +
                '<span><i style="background:var(--accent-red)"></i>敗北</span>' +
                '<span><i style="background:var(--text-light)"></i>引分</span></div>'
                : '<div class="chart-empty">対戦データがありません</div>') +
            '</div>' +

            // 難易度別戦績
            '<div class="chart-block">' +
            '<div class="chart-title">CPU難易度別 戦績</div>' +
            '<div class="chart-sub">難しいほど獲得ポイントが増えます</div>' +
            this._difficultyTable(st.byDifficulty) +
            '</div>' +

            this._privilegeBlock(rankIdx);
    }

    _difficultyTable(byDifficulty) {
        const names = { 0: '練習', 1: '易しい', 2: '初級', 3: '普通', 4: '上位', 5: '難関', 6: '上級', 7: '難しい' };
        const keys = Object.keys(byDifficulty || {});
        if (keys.length === 0) return '<div class="chart-empty">CPU戦の記録がありません</div>';
        return '<div class="category-bars">' + keys.sort((a, b) => a - b).map(k => {
            const d = byDifficulty[k];
            const total = d.win + d.lose + d.draw;
            const rate = total ? Math.round((d.win / total) * 100) : 0;
            return '<div class="bar-item"><div class="bar-label">' + (names[k] || ('Lv.' + k)) + '</div>' +
                '<div class="bar-track"><div class="bar-fill ' + (rate < 50 ? 'low' : '') + '" style="width:' + rate + '%"></div></div>' +
                '<div class="bar-value">' + rate + '%</div>' +
                '<div class="bar-value" style="width:70px;color:var(--card-bg);font-size:.7rem;">' + d.win + '勝' + d.lose + '敗</div></div>';
        }).join('') + '</div>';
    }

    _privilegeBlock(rankIdx) {
        const items = ProgressManager.RANKS.map((r, i) => {
            const owned = rankIdx >= i;
            return '<div class="priv-item ' + (owned ? 'owned' : 'locked') + '">' +
                '<div class="priv-rank">' + r.name + '</div>' +
                '<div class="priv-name">' + r.priv + '</div>' +
                '<div class="priv-mark">' + (owned ? '✓' : r.min + 'pt') + '</div></div>';
        }).join('');
        return '<div class="chart-block">' +
            '<div class="chart-title">段位特典</div>' +
            '<div class="chart-sub">ポイントと分子解放数で段位が上がり、特典が増えます</div>' +
            '<div class="priv-list">' + items + '</div></div>';
    }

    _svgLineChart(values) {
        const w = 300, h = 110, pad = 8;
        const min = Math.min(...values), max = Math.max(...values);
        const span = (max - min) || 1;
        const pts = values.map((v, i) => {
            const x = pad + (i * (w - pad * 2)) / Math.max(1, values.length - 1);
            const y = h - pad - ((v - min) / span) * (h - pad * 2);
            return x.toFixed(1) + ',' + y.toFixed(1);
        });
        const gridLines = [0.25, 0.5, 0.75].map(f =>
            '<line class="grid-line" x1="' + pad + '" y1="' + (h * f) + '" x2="' + (w - pad) + '" y2="' + (h * f) + '"/>').join('');
        return '<svg class="svgchart" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
            gridLines +
            '<polygon points="' + pad + ',' + (h - pad) + ' ' + pts.join(' ') + ' ' + (w - pad) + ',' + (h - pad) + '" fill="rgba(74,106,58,.22)" stroke="none"/>' +
            '<polyline points="' + pts.join(' ') + '" fill="none" stroke="var(--accent-gold)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>' +
            '</svg>' +
            '<div class="svg-axis"><span>' + min + ' pt</span><span>' + Math.round((min + max) / 2) + ' pt</span><span>' + max + ' pt</span></div>';
    }

    renderRankPanel() {
        const card = document.querySelector('.profile-card');
        if (!card) return;
        const rank = ProgressManager.rankOf(ProgressManager.points);
        this.setText('profile-rank', '段位: ' + rank.name);

        let panel = document.getElementById('rank-progress');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'rank-progress';
            panel.className = 'rank-progress';
            card.appendChild(panel);
        }
        const totalCompounds = this.engine.compounds.length || 0;
        const unlocked = ProgressManager.unlockedCount();
        panel.innerHTML =
            '<div class="rank-progress-row">' +
            '<span class="rank-progress-label">' + (rank.next ? '次の段位まで' : '最高段位') + '</span>' +
            '<span class="rank-progress-next">' + (rank.next ? ('あと ' + rank.need + ' pt で「' + rank.next.name + '」') : '―') + '</span>' +
            '</div>' +
            '<div class="rank-track"><div class="rank-fill" style="width:' + Math.round(rank.progress * 100) + '%"></div></div>' +
            '<div class="profile-unlock">図鑑解放: <strong style="color:var(--accent-green);">' + unlocked + '</strong> / ' + totalCompounds +
            ' 化合物（1分子 +' + ProgressManager.UNLOCK_POINT + ' pt）</div>' +
            '<div class="profile-unlock" style="margin-top:4px;color:var(--accent-gold);">現在の特典: ' + rank.priv + '</div>';
    }

    renderBarGraph(containerId, data, labelFunc) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        if (!data || Object.keys(data).length === 0) {
            container.innerHTML = '<div class="history-empty">データがありません</div>';
            return;
        }
        const entries = Object.entries(data).map(([key, val]) => {
            const total = (val.correct || 0) + (val.wrong || 0);
            const rate = total > 0 ? Math.round(((val.correct || 0) / total) * 100) : 0;
            return { key: key, rate: rate, total: total };
        }).sort((a, b) => a.rate - b.rate);

        entries.forEach(item => {
            const row = document.createElement('div');
            row.className = 'bar-item';
            const isLow = item.rate < 50;
            const label = labelFunc(item.key);
            row.innerHTML =
                '<div class="bar-label" title="' + label + '">' + label + '</div>' +
                '<div class="bar-track"><div class="bar-fill ' + (isLow ? 'low' : '') + '" style="width:' + item.rate + '%"></div></div>' +
                '<div class="bar-value">' + item.rate + '%</div>';
            container.appendChild(row);
        });
    }

    renderHistory(history) {
        const container = document.getElementById('history-list');
        if (!container) return;
        container.innerHTML = '';
        const recs = (ProgressManager.data.records || []).slice(-14).reverse();
        if (recs.length > 0) {
            recs.forEach(h => {
                const date = new Date(h.t);
                const dateStr = (date.getMonth() + 1) + '/' + date.getDate() + ' ' + date.getHours() + ':' + String(date.getMinutes()).padStart(2, '0');
                const item = document.createElement('div');
                item.className = 'history-item ' + (h.correct ? 'correct' : 'wrong');
                item.innerHTML =
                    '<div class="history-date">' + dateStr + '</div>' +
                    '<div class="history-name">' + (h.compoundName || h.compoundId || '') + '</div>' +
                    '<div class="history-result">' + (h.correct ? ((h.reactionMs / 1000).toFixed(2) + 's') : '誤答') + '</div>';
                container.appendChild(item);
            });
            return;
        }
        if (!history || history.length === 0) {
            container.innerHTML = '<div class="history-empty">プレイ履歴がありません</div>';
            return;
        }
        history.forEach(h => {
            const date = new Date(h.date);
            const dateStr = (date.getMonth() + 1) + '/' + date.getDate() + ' ' + date.getHours() + ':' + String(date.getMinutes()).padStart(2, '0');
            let compoundName = h.compoundId;
            const compound = this.engine.compounds.find(c => String(c.id || '').trim() === h.compoundId);
            if (compound) compoundName = compound.name;
            const item = document.createElement('div');
            item.className = 'history-item ' + h.result;
            item.innerHTML =
                '<div class="history-date">' + dateStr + '</div>' +
                '<div class="history-name">' + compoundName + '</div>' +
                '<div class="history-result">' + (h.result === 'correct' ? '正解' : '不正解') + '</div>';
            container.appendChild(item);
        });
    }

    setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    /* ========================= ★E: 資料（未解放は分子名も隠す） ========================= */
    _lockSvg() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="4" y="10" width="16" height="11" rx="2"></rect>' +
            '<path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>';
    }

    renderUnlockBar() {
        const container = document.querySelector('.reference-container');
        if (!container) return;
        const tabs = document.getElementById('reference-tabs');
        let panel = document.getElementById('reference-unlock-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'reference-unlock-panel';
            panel.className = 'unlock-panel';
            if (tabs) container.insertBefore(panel, tabs);
            else container.appendChild(panel);
        }
        const total = this.engine.compounds.length || 0;
        const unlocked = ProgressManager.unlockedCount();
        const pct = total > 0 ? Math.round((unlocked / total) * 100) : 0;
        const allFree = ProgressManager.hasPrivilege(7);
        panel.innerHTML =
            '<div class="unlock-panel-row">' +
            '<span class="unlock-panel-title">図鑑解放</span>' +
            '<span class="unlock-panel-value">' + (allFree ? total + ' / ' + total + '（永世名人特典）' : unlocked + ' / ' + total + '（' + pct + '%）') + '</span></div>' +
            '<div class="unlock-track"><div class="unlock-fill" style="width:' + (allFree ? 100 : pct) + '%"></div></div>' +
            '<div class="unlock-hint">CPU戦で「誤答なしの一発正解」をした化合物だけが解放されます（1分子 +' +
            ProgressManager.UNLOCK_POINT + ' pt）。未解放の分子は名前も含めて秘匿されます。</div>';
    }

    renderReference() {
        const tabsContainer = document.getElementById('reference-tabs');
        const listContainer = document.getElementById('reference-list');
        if (!tabsContainer || !listContainer) return;

        this.renderUnlockBar();

        const categories = this.engine.getCategories();
        tabsContainer.innerHTML = '';
        const allTab = document.createElement('button');
        allTab.className = 'reference-tab' + (this.referenceCurrentCategory === 'all' ? ' selected' : '');
        allTab.textContent = 'すべて';
        allTab.dataset.category = 'all';
        allTab.addEventListener('click', () => { this.referenceCurrentCategory = 'all'; this.renderReference(); });
        tabsContainer.appendChild(allTab);

        categories.forEach(cat => {
            const tab = document.createElement('button');
            tab.className = 'reference-tab' + (this.referenceCurrentCategory === cat ? ' selected' : '');
            tab.textContent = this.getCategoryDisplayName(cat);
            tab.dataset.category = cat;
            tab.addEventListener('click', () => { this.referenceCurrentCategory = cat; this.renderReference(); });
            tabsContainer.appendChild(tab);
        });

        listContainer.innerHTML = '';
        let filtered = this.engine.compounds;
        if (this.referenceCurrentCategory !== 'all') {
            filtered = filtered.filter(c => c.category === this.referenceCurrentCategory);
        }
        if (filtered.length === 0) {
            listContainer.innerHTML = '<div class="reference-empty">この単元には化合物がありません</div>';
            return;
        }

        const grouped = {};
        filtered.forEach(c => {
            const cat = c.category || 'other';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(c);
        });

        const renderQueue = [];
        Object.keys(grouped).sort().forEach(cat => {
            const section = document.createElement('div');
            section.className = 'reference-category-section';
            const header = document.createElement('div');
            header.className = 'reference-category-header';
            const unlockedInCat = grouped[cat].filter(c => ProgressManager.isEffectivelyUnlocked(c.id)).length;
            header.textContent = this.getCategoryDisplayName(cat) + '（' + unlockedInCat + ' / ' + grouped[cat].length + '）';
            section.appendChild(header);

            const grid = document.createElement('div');
            grid.className = 'reference-grid';
            grouped[cat].forEach(compound => {
                const unlocked = ProgressManager.isEffectivelyUnlocked(compound.id);
                const item = document.createElement('div');
                item.className = 'reference-item' + (unlocked ? '' : ' locked');
                item.dataset.id = String(compound.id || '').trim();
                // ★E: 未解放は構造式・分子名・分子式すべて秘匿
                const structInner = unlocked ? '' : ('<div class="ref-lock">' + this._lockSvg() + '<span>未解放</span></div>');
                item.innerHTML =
                    '<div class="reference-item-structure ' + (unlocked ? '' : 'locked') + '">' + structInner + '</div>' +
                    '<div class="reference-item-name">' + (unlocked ? (compound.name || '') : '？？？') + '</div>' +
                    '<div class="reference-item-formula">' + (unlocked ? (compound.formula || '') : '―――') + '</div>';
                item.addEventListener('click', () => this.showReferenceDetail(compound));
                grid.appendChild(item);
                if (unlocked) renderQueue.push({ el: item.querySelector('.reference-item-structure'), compound: compound });
            });
            section.appendChild(grid);
            listContainer.appendChild(section);
        });

        requestAnimationFrame(() => {
            renderQueue.forEach(entry => {
                if (!entry.el) return;
                if (StructureCache.applyTo(entry.el, entry.compound)) return;
                StructureRenderer.render(entry.el, entry.compound.smiles, 'light', {})
                    .then(() => { StructureCache.snapshot(entry.compound, entry.el); })
                    .catch(() => { });
            });
        });
    }

    showReferenceDetail(compound) {
        const modal = document.getElementById('reference-detail-modal');
        if (!modal) return;
        const compoundId = String(compound.id || '').trim();
        const unlocked = ProgressManager.isEffectivelyUnlocked(compoundId);

        // ★E: 未解放なら詳細も完全に秘匿
        if (!unlocked) {
            this.setText('detail-name', '？？？');
            this.setText('detail-formula', '未解放の化合物');
            const structureDiv = document.getElementById('detail-structure');
            if (structureDiv) {
                structureDiv.classList.add('locked');
                structureDiv.innerHTML =
                    '<div class="ref-lock" style="color:#8b8676;">' + this._lockSvg() +
                    '<span>この分子はまだ解放されていません</span></div>';
            }
            const stagesDiv = document.getElementById('detail-stages');
            if (stagesDiv) {
                stagesDiv.innerHTML =
                    '<div class="reference-detail-stages-title">読み札</div>' +
                    '<div class="ref-secret-note">未解放のため読み札・解説は表示されません。<br>' +
                    'CPU戦で <b>誤答せずに一発正解</b> すると、この分子の構造式・名前・読み札が解放されます。</div>';
            }
            const explanationDiv = document.getElementById('detail-explanation');
            if (explanationDiv) {
                explanationDiv.innerHTML =
                    '<div class="reference-detail-explanation-title">構造決定のポイント</div>' +
                    '<div class="ref-secret-note">解放後に表示されます。</div>';
            }
            modal.classList.add('active');
            return;
        }

        const clueData = this.engine.clues[compoundId];
        this.setText('detail-name', compound.name || '');
        this.setText('detail-formula', compound.formula || '');

        const structureDiv = document.getElementById('detail-structure');
        if (structureDiv) {
            structureDiv.innerHTML = '';
            structureDiv.classList.remove('locked');
            if (!StructureCache.applyTo(structureDiv, compound)) {
                StructureRenderer.render(structureDiv, compound.smiles, 'light', {
                    name: compound.name, name_en: compound.name_en, formula: compound.formula
                }).then(() => { StructureCache.snapshot(compound, structureDiv); }).catch(() => { });
            }
        }

        const stagesDiv = document.getElementById('detail-stages');
        if (stagesDiv) {
            stagesDiv.innerHTML = '';
            if (clueData && clueData.stages && clueData.stages.length > 0) {
                const title = document.createElement('div');
                title.className = 'reference-detail-stages-title';
                title.textContent = '読み札';
                stagesDiv.appendChild(title);
                clueData.stages.forEach(stage => {
                    const item = document.createElement('div');
                    item.className = 'reference-stage-item';
                    const num = document.createElement('span');
                    num.className = 'stage-num';
                    num.textContent = 'STEP ' + stage.stage;
                    item.appendChild(num);
                    item.appendChild(document.createTextNode(stage.text));
                    stagesDiv.appendChild(item);
                });
                const playBtn = document.createElement('button');
                playBtn.className = 'btn btn-primary';
                playBtn.style.cssText = 'width:100%;margin-top:12px;font-size:0.9rem;padding:10px;';
                playBtn.textContent = '読み上げる';
                playBtn.addEventListener('click', () => this.playAllStages(clueData.stages));
                stagesDiv.appendChild(playBtn);
            } else {
                stagesDiv.innerHTML = '<div style="color:var(--text-light);font-size:0.85rem;padding:10px;">読み札データがありません</div>';
            }
        }

        const explanationDiv = document.getElementById('detail-explanation');
        if (explanationDiv) {
            explanationDiv.innerHTML = '';
            if (clueData && clueData.explanation) {
                const title = document.createElement('div');
                title.className = 'reference-detail-explanation-title';
                title.textContent = '構造決定のポイント';
                explanationDiv.appendChild(title);

                // ★特典: 名人(index5)以上で全文表示
                const full = ProgressManager.hasPrivilege(5);
                const text = String(clueData.explanation);
                const content = document.createElement('div');
                content.textContent = full ? text : (text.slice(0, 60) + '…');
                explanationDiv.appendChild(content);
                if (!full) {
                    const note = document.createElement('div');
                    note.className = 'explanation-lock-note';
                    note.textContent = '🔒 全文は段位「名人」で開放（あと ' + ProgressManager.rankOf(ProgressManager.points).need + ' pt）';
                    explanationDiv.appendChild(note);
                }
            } else {
                explanationDiv.innerHTML = '<div style="color:var(--text-light);font-size:0.85rem;">解説データがありません</div>';
            }
        }

        modal.classList.add('active');
    }

    playAllStages(stages) {
        if (!stages || stages.length === 0) return;
        let index = 0;
        const playNext = () => {
            if (index >= stages.length) return;
            const stage = stages[index];
            AudioManager.speak(stage.text, {
                onEnd: () => { index++; if (index < stages.length) setTimeout(playNext, 500); }
            });
        };
        playNext();
    }

    /* ========================= ★B: タイトル画面パネル ========================= */
    showScreen(screenId) {
        if (screenId !== 'screen-game') this.closeAllModals();
        else { this.closeRoundResultModal(); this.removeFinalCountdown(); }

        document.querySelectorAll('.screen').forEach(s => {
            if (!s.classList.contains('modal-screen')) s.classList.remove('active');
        });
        const target = document.getElementById(screenId);
        if (target) {
            target.classList.add('active');
            const scrollables = target.querySelectorAll('.clue-display, .card-field, .settings-container, .stats-container, .difficulty-container, .title-container, .reference-list');
            scrollables.forEach(el => { el.scrollTop = 0; });
        }
        if (screenId === 'screen-title') {
            this.renderTitleRankPanel();
            this.renderTitleCachePanel();
            StructureCache.resume();
        }
        if (screenId === 'screen-settings') this.syncSettingsUI();
        this.updateFooterState();
    }

    renderTitleRankPanel() {
        const container = document.querySelector('.title-container');
        if (!container) return;
        const rank = ProgressManager.rankOf(ProgressManager.points);

        const logo = document.querySelector('.title-logo');
        if (logo) logo.classList.toggle('rank-gold', ProgressManager.hasPrivilege(6));

        let panel = document.getElementById('title-rank-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'title-rank-panel';
            const menu = container.querySelector('.title-menu');
            if (menu && menu.nextSibling) container.insertBefore(panel, menu.nextSibling);
            else container.appendChild(panel);
        }
        const badge = ProgressManager.hasPrivilege(1)
            ? '<div class="trp-rank">' + rank.name + '</div>'
            : '<div class="trp-rank" style="opacity:.55;">段位 未定</div>';
        panel.innerHTML = badge +
            '<div class="trp-sub">' + ProgressManager.points + ' pt ／ ' + ProgressManager.data.wins + ' 勝 ' +
            ProgressManager.data.losses + ' 敗 ／ 図鑑 ' + ProgressManager.unlockedCount() + '・' + (this.engine.compounds.length || 0) + '</div>' +
            '<div class="trp-track"><div class="trp-fill" style="width:' + Math.round(rank.progress * 100) + '%"></div></div>' +
            '<div class="trp-sub" style="margin-top:6px;color:var(--accent-gold);">' +
            (rank.next ? ('あと ' + rank.need + ' pt で「' + rank.next.name + '」・特典: ' + rank.next.priv) : '最高段位・全特典解放済み') + '</div>';
    }

    /** ★B: 構造式キャッシュの独立パネル */
    renderTitleCachePanel() {
        const container = document.querySelector('.title-container');
        if (!container) return;
        const total = this.engine.compounds.length || 0;
        const cached = Math.min(StructureCache.mem.size, total);
        const pct = total > 0 ? Math.round((cached / total) * 100) : 0;
        const done = total > 0 && cached >= total;
        const broken = StructureCache.offscreenBroken;

        let panel = document.getElementById('title-cache-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'title-cache-panel';
            const rankPanel = document.getElementById('title-rank-panel');
            if (rankPanel && rankPanel.nextSibling) container.insertBefore(panel, rankPanel.nextSibling);
            else container.appendChild(panel);
        }

        let stateText, dotClass = '';
        if (done) { stateText = '準備完了（即時展開）'; dotClass = 'done'; }
        else if (broken) { stateText = '対戦時に逐次生成'; dotClass = 'done'; }
        else if (StructureCache.running) { stateText = 'バックグラウンド生成中'; }
        else { stateText = '待機中'; }

        panel.innerHTML =
            '<div class="tcp-head"><span class="tcp-title">構造式キャッシュ</span><span class="tcp-pct">' + pct + '%</span></div>' +
            '<div class="tcp-track"><div class="tcp-fill' + (done ? ' done' : '') + '" style="width:' + pct + '%"></div></div>' +
            '<div class="tcp-meta">' +
            '<span class="tcp-state"><i class="tcp-dot' + dotClass + '"></i>' + stateText + '</span>' +
            '<span>' + cached + ' / ' + total + ' 枚</span>' +
            '</div>' +
            '<div class="tcp-meta" style="margin-top:8px;">' +
            '<span style="opacity:.75;">事前生成済みだと札の展開が即時になります</span>' +
            '<button class="tcp-btn" id="btn-rebuild-cache"' + (broken ? ' disabled' : '') + '>再構築</button>' +
            '</div>';

        const btn = document.getElementById('btn-rebuild-cache');
        if (btn && !btn.dataset.bound) {
            btn.dataset.bound = '1';
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = '消去中…';
                StructureCache.stop();
                await StructureCache.clearAll();
                this.renderTitleCachePanel();
                const pending = this.engine.compounds.filter(c => c && c.smiles);
                StructureCache.offscreenBroken = false;
                StructureCache._failCount = 0;
                StructureCache.startPrefetch(pending);
            });
        }
    }

    getCategoryDisplayName(category) {
        const names = {
            hydrocarbon: '炭化水素', aromatic: '芳香族', alcohol: 'アルコール',
            phenol: 'フェノール', carbonyl: 'カルボニル', acid: 'カルボン酸',
            ester: 'エステル', ether: 'エーテル', amine: 'アミン', nitro: 'ニトロ',
            halide: 'ハロゲン', amino_acid: 'アミノ酸', sugar: '糖',
            fatty_acid: '脂肪酸', fat: '油脂', amide: 'アミド',
            heterocycle: '複素環', nucleobase: '核酸塩基', nitrile: 'ニトリル',
            peptide: 'ペプチド', nitrate: '硝酸エステル', indicator: '指示薬',
            soap: '石鹸', surfactant: '界面活性剤', pharmaceutical: '医薬品',
            alkaloid: 'アルカロイド', polysaccharide: '多糖類'
        };
        return names[category] || category;
    }

    loadSettings() {
        try {
            const legacy = StorageManager.loadSettings();
            if (legacy) {
                if (legacy.voiceEnabled !== undefined) SettingsStore.set('voiceEnabled', legacy.voiceEnabled);
                if (legacy.voiceSpeed !== undefined) SettingsStore.set('voiceSpeed', legacy.voiceSpeed);
                if (legacy.cardCount !== undefined) SettingsStore.set('cardCount', legacy.cardCount);
            }
        } catch (e) { }
        AudioBridge.applyAll();
    }
}

window.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, starting app...');
    window.app = new App();
});