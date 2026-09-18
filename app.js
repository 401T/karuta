/* =========================================================================
   app.js  —  メインアプリケーション v6
   -------------------------------------------------------------------------
   【修正1】「開始」ボタンの文字位置ずれ
      → style.css 側で text-indent 相殺 + flex 完全センタリング。
        本ファイルでは .next-btn の中身を <span class="btn-label"> に
        正規化して二重のズレ要因（アイコン/改行）を排除。
   【修正2】設定画面の音量が実際に反映されない
      → SettingsStore（自作の確実な永続化）+ AudioBridge を新設。
        AudioManager の API 形状が不明でも効くよう
        setVolume / setVolumes / updateSettings / gain ノード / Audio要素 /
        speak の volume オプション注入 を総当たりで適用する。
   【修正3】取り札が揃う前に読み上げが始まる
      → StructureCache で全札を事前生成 → renderCards は
        「全カード描画完了」を await してから engine.setCardsReady(true)
        → engine.startReading(true)。engine 側も cardsReady でゲート。
   【修正4】カード枚数が反映されない
      → SettingsStore を正本化。startGame / オンライン部屋設定の両方で
        ここから読み、#card-grid に cards-6/9/12/16 クラスを付与して
        レイアウトも枚数に応じて変化させる。
   【新規】StructureCache（構造式の事前生成＋IndexedDB永続キャッシュ）
      → プレイ中は RDKit 描画を待たず、キャッシュHTMLを同期注入するだけ。
        待ち時間をほぼゼロにする。
   ※ index.html は変更不要（新規ファイル追加なし・既存IDのみ使用）
========================================================================= */

/* =========================================================================
   1) SettingsStore — 設定の正本（StorageManager が壊れていても動く）
========================================================================= */
const SettingsStore = {
    KEY: 'kkaruta_settings_v2',
    DEFAULTS: {
        cardCount: 9,
        voiceEnabled: true,
        voiceSpeed: 1.0,
        readerVolume: 0.8,
        seVolume: 0.7,
        bgmVolume: 0.5
    },
    data: null,

    init() {
        this.data = Object.assign({}, this.DEFAULTS);
        // 既存 StorageManager から引き継ぎ
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
        // ローカル保存分
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
        // 允许値にスナップ（近いもの）
        let best = allowed[0], bd = Infinity;
        allowed.forEach(a => { const d = Math.abs(a - n); if (d < bd) { bd = d; best = a; } });
        return best;
    },

    get(key) {
        if (!this.data) this.init();
        return this.data[key];
    },

    set(key, value) {
        if (!this.data) this.init();
        if (key === 'cardCount') value = this.normalizeCardCount(value);
        if (key === 'readerVolume' || key === 'seVolume' || key === 'bgmVolume') value = this._clamp01(value);
        if (key === 'voiceSpeed') value = parseFloat(value) || 1.0;
        if (key === 'voiceEnabled') value = !!value;
        this.data[key] = value;
        this.save();
        // StorageManager にも書き通す（既存の統計・設定機構との互換）
        try {
            if (typeof StorageManager !== 'undefined' && StorageManager.updateSetting) {
                StorageManager.updateSetting(key, value);
            }
        } catch (e) { }
        return value;
    },

    save() {
        try { localStorage.setItem(this.KEY, JSON.stringify(this.data)); }
        catch (e) { console.warn('SettingsStore save failed:', e); }
    }
};

/* =========================================================================
   2) AudioBridge — ★修正2: 音量を実際に効かせるアダプタ
      AudioManager の実装形状が不明でも効くように多段で適用する
========================================================================= */
const AudioBridge = {
    patchedSpeak: false,

    /** 現在の設定を全て適用（初期化時・変更時に呼ぶ） */
    applyAll() {
        const r = SettingsStore.get('readerVolume');
        const s = SettingsStore.get('seVolume');
        const b = SettingsStore.get('bgmVolume');
        this.apply({ reader: r, se: s, bgm: b });
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

    /** 音量を実際に反映させる（考えうる全経路を叩く） */
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

        // (a) updateSettings
        try { if (typeof A.updateSettings === 'function') A.updateSettings(payload); } catch (e) { }
        // (b) setVolumes(obj)
        try {
            if (typeof A.setVolumes === 'function') {
                A.setVolumes({ reader: r, voice: r, se: s, sfx: s, bgm: b, music: b, master: master });
            }
        } catch (e) { }
        // (c) setVolume(type, value)
        try {
            if (typeof A.setVolume === 'function') {
                [['reader', r], ['voice', r], ['se', s], ['sfx', s], ['bgm', b], ['music', b], ['master', master]]
                    .forEach(pair => { try { A.setVolume(pair[0], pair[1]); } catch (e2) { } });
            }
        } catch (e) { }
        // (d) setMasterVolume
        try { if (typeof A.setMasterVolume === 'function') A.setMasterVolume(master); } catch (e) { }
        // (e) 直接プロパティ／入れ子オブジェクト
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
        // (f) WebAudio GainNode を走査して反映
        try { this._applyGainNodes(A, { reader: r, se: s, bgm: b, master: master }); } catch (e) { }
        // (g) HTMLAudioElement を走査して反映
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

    /** speak(text, opts) に volume オプションを必ず載せる */
    patchSpeak() {
        const A = window.AudioManager;
        if (!A || this.patchedSpeak) return;
        if (typeof A.speak !== 'function') return;
        const orig = A.speak.bind(A);
        const self = this;
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
   3) StructureCache — ★構造式の事前生成＆シームレス読み出し
      ・RDKit(StructureRenderer) の出力HTMLを id ごとに缓存
      ・メモリ Map + IndexedDB で永続化（2回目以降は起動直後から即時）
      ・空き時間にバックグラウンドで全化合物を生成
      ・描画時は innerHTML を同期注入するだけ（待ち時間ほぼ0）
========================================================================= */
const StructureCache = {
    mem: new Map(),
    db: null,
    DB_NAME: 'kkaruta_structure_cache',
    STORE: 'structures',
    ready: false,
    onProgress: null,

    _prefetchList: [],
    _prefetchIndex: 0,
    _prefetchRunning: false,
    _paused: false,

    RENDER_W: 260,
    RENDER_H: 320,

    key(compound) { return String((compound && compound.id) || '').trim(); },

    /* ---- IndexedDB ---- */
    async open() {
        if (this.db !== null) return this.db;
        this.db = await new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (!done) { done = true; resolve(v); } };
            try {
                if (!window.indexedDB) return finish(null);
                const req = window.indexedDB.open(this.DB_NAME, 1);
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
                const st = tx.objectStore(this.STORE);
                const req = st.getAll();
                req.onsuccess = () => {
                    const rows = req.result || [];
                    rows.forEach(r => { if (r && r.id && r.html) this.mem.set(String(r.id), r.html); });
                    finish(rows.length);
                };
                req.onerror = () => finish(0);
            } catch (e) { finish(0); }
            setTimeout(() => finish(this.mem.size), 4000);
        });
    },

    async save(id, html) {
        this.mem.set(String(id), html);
        const db = await this.open();
        if (!db) return;
        try {
            const tx = db.transaction(this.STORE, 'readwrite');
            tx.objectStore(this.STORE).put({ id: String(id), html: html, t: Date.now() });
        } catch (e) { }
    },

    has(compoundOrId) {
        const id = typeof compoundOrId === 'string' ? compoundOrId : this.key(compoundOrId);
        return this.mem.has(String(id || '').trim());
    },

    getHTML(compoundOrId) {
        const id = typeof compoundOrId === 'string' ? compoundOrId : this.key(compoundOrId);
        return this.mem.get(String(id || '').trim()) || null;
    },

    /** 同期的に要素へ注入。成功すれば true（＝待ち時間ゼロ） */
    applyTo(el, compound) {
        if (!el) return false;
        const html = this.getHTML(compound);
        if (html == null) return false;
        el.innerHTML = html;
        return true;
    },

    /** 1件生成（RDKit → offscreen → HTML 取り出し → 保存） */
    async render(compound) {
        const id = this.key(compound);
        if (!id) return null;
        if (this.mem.has(id)) return this.mem.get(id);
        if (!compound || !compound.smiles) return null;
        if (typeof StructureRenderer === 'undefined' || !StructureRenderer.render) return null;

        const box = document.createElement('div');
        box.className = 'card-content';
        box.style.cssText = 'position:fixed;left:-99999px;top:0;opacity:0;pointer-events:none;' +
            'width:' + this.RENDER_W + 'px;height:' + this.RENDER_H + 'px;';
        document.body.appendChild(box);
        let html = null;
        try {
            await Promise.race([
                Promise.resolve(StructureRenderer.render(box, compound.smiles, 'light', {
                    name: compound.name, name_en: compound.name_en, formula: compound.formula
                })),
                new Promise(res => setTimeout(res, 12000))
            ]);
            const out = (box.innerHTML || '').trim();
            if (out && out.length > 10) html = out;
        } catch (e) {
            console.warn('[StructureCache] render failed:', id, e);
        } finally {
            try { box.remove(); } catch (e) { }
        }
        if (html) { await this.save(id, html); return html; }
        return null;
    },

    /** 指定リストを必ず揃える（ゲーム開始前の同期点） */
    async ensureMany(list, onProgress) {
        const items = (list || []).filter(c => c && this.key(c));
        const missing = items.filter(c => !this.has(c));
        if (missing.length === 0) return { total: items.length, generated: 0 };
        let done = 0;
        for (let i = 0; i < missing.length; i++) {
            await this.render(missing[i]);
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
        this._prefetchRunning = true;
        this._paused = false;
        this._pump();
    },

    /** 選択単元を優先させる（並び替え） */
    prioritize(categories) {
        if (!Array.isArray(categories) || categories.length === 0) return;
        const set = new Set(categories);
        this._prefetchList.sort((a, b) => {
            const an = set.has(a.category) ? 0 : 1;
            const bn = set.has(b.category) ? 0 : 1;
            return an - bn;
        });
    },

    pause() { this._paused = true; },
    resume() { if (this._paused) { this._paused = false; this._pump(); } },
    stop() { this._prefetchRunning = false; this._paused = false; },

    _schedule(fn) {
        if (window.requestIdleCallback) {
            window.requestIdleCallback(fn, { timeout: 500 });
        } else {
            setTimeout(fn, 90);
        }
    },

    _pump() {
        if (!this._prefetchRunning || this._paused) return;
        this._schedule(async () => {
            if (!this._prefetchRunning || this._paused) return;
            if (this._prefetchIndex >= this._prefetchList.length) {
                this._prefetchRunning = false;
                if (this.onProgress) this.onProgress(this.mem.size, this._prefetchList.length, true);
                return;
            }
            const compound = this._prefetchList[this._prefetchIndex++];
            try { await this.render(compound); } catch (e) { }
            if (this.onProgress) this.onProgress(this._prefetchIndex, this._prefetchList.length, false);
            this._pump();
        });
    },

    coverage(total) {
        if (!total) return 0;
        return Math.min(1, this.mem.size / total);
    }
};

/* =========================================================================
   4) ProgressManager — ポイント・段位・図鑑アンロック
========================================================================= */
const ProgressManager = {
    KEY: 'kagaku_karuta_progress_v2',
    RANKS: [
        { min: 0,    name: '見習い' },
        { min: 200,  name: '初級者' },
        { min: 500,  name: '中級者' },
        { min: 900,  name: '上級者' },
        { min: 1500, name: '達人' },
        { min: 2500, name: '名人' },
        { min: 4000, name: '王座' },
        { min: 6000, name: '永世名人' }
    ],
    data: null,

    _default() {
        return {
            points: 0, wins: 0, losses: 0, draws: 0,
            gamesPlayed: 0, unlocked: [], totalCorrect: 0,
            bestPoints: 0, lastPlayed: null
        };
    },

    init() {
        this.data = this._default();
        try {
            const raw = localStorage.getItem(this.KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') this.data = Object.assign(this._default(), parsed);
                if (!Array.isArray(this.data.unlocked)) this.data.unlocked = [];
            }
        } catch (e) { console.warn('ProgressManager load failed:', e); }
        return this.data;
    },

    save() {
        try { localStorage.setItem(this.KEY, JSON.stringify(this.data)); }
        catch (e) { console.warn('ProgressManager save failed:', e); }
    },

    get points() { return Number(this.data && this.data.points) || 0; },

    rankOf(points) {
        const p = Number(points) || 0;
        let cur = this.RANKS[0];
        for (let i = 0; i < this.RANKS.length; i++) { if (p >= this.RANKS[i].min) cur = this.RANKS[i]; }
        const idx = this.RANKS.indexOf(cur);
        const next = idx < this.RANKS.length - 1 ? this.RANKS[idx + 1] : null;
        const span = next ? (next.min - cur.min) : 1;
        const prog = next ? Math.max(0, Math.min(1, (p - cur.min) / span)) : 1;
        return { name: cur.name, index: idx, current: cur, next: next, progress: prog, need: next ? Math.max(0, next.min - p) : 0 };
    },

    recordGameEnd(info) {
        const opt = info || {};
        const mode = opt.mode || 'cpu';
        const winner = opt.winner || 'draw';
        const diffLevel = Number(opt.difficulty) || 0;
        const correctRounds = Number(opt.correctRounds) || 0;

        if (mode === 'practice') {
            this.data.gamesPlayed++;
            this.data.totalCorrect += correctRounds;
            this.data.lastPlayed = Date.now();
            this.save();
            return { gained: 0, rankUp: null, rank: this.rankOf(this.points) };
        }

        const before = this.rankOf(this.points).name;
        let gained = 0;
        if (winner === 'player') { gained = 100 + diffLevel * 15; this.data.wins++; }
        else if (winner === 'draw') { gained = 40; this.data.draws++; }
        else { gained = 12; this.data.losses++; }
        if (mode === 'online' && winner === 'player') gained += 60;
        gained += correctRounds * 5;

        this.data.points += gained;
        this.data.gamesPlayed++;
        this.data.totalCorrect += correctRounds;
        this.data.lastPlayed = Date.now();
        if (this.data.points > this.data.bestPoints) this.data.bestPoints = this.data.points;
        this.save();

        const after = this.rankOf(this.points);
        return { gained: gained, rankUp: after.name !== before ? after.name : null, rank: after };
    },

    unlock(id) {
        const key = String(id || '').trim();
        if (!key) return false;
        if (this.data.unlocked.includes(key)) return false;
        this.data.unlocked.push(key);
        this.save();
        return true;
    },
    isUnlocked(id) { return this.data.unlocked.includes(String(id || '').trim()); },
    unlockedCount() { return this.data.unlocked.length; },

    winRate() {
        const t = this.data.wins + this.data.losses + this.data.draws;
        return t > 0 ? Math.round((this.data.wins / t) * 100) : 0;
    },

    reset() { this.data = this._default(); this.save(); }
};

/* =========================================================================
   5) フォールバック用スタイル注入（style.css 未更新環境でも動く）
========================================================================= */
function injectExtraStyles() {
    if (document.getElementById('app-extra-styles')) return;
    const css = [
        '.next-btn{display:flex;align-items:center;justify-content:center;text-align:center;',
        'letter-spacing:.2em;text-indent:.2em;line-height:1;padding:0 20px;min-height:52px;}',
        '.menu-text{letter-spacing:.3em;text-indent:.3em;line-height:1;}',
        '.footer-btn{display:flex;align-items:center;justify-content:center;letter-spacing:.15em;text-indent:.15em;line-height:1;padding:0 12px;}',
        '.section-title{letter-spacing:.3em;text-indent:.3em;}',
        '.title-sub{letter-spacing:.5em;text-indent:.5em;}',
        '.btn{letter-spacing:.15em;text-indent:.15em;line-height:1;}',
        '#card-grid.cards-6{grid-template-columns:repeat(3,1fr);gap:12px;}',
        '#card-grid.cards-9{grid-template-columns:repeat(3,1fr);gap:8px;}',
        '#card-grid.cards-12{grid-template-columns:repeat(4,1fr);gap:8px;}',
        '#card-grid.cards-16{grid-template-columns:repeat(4,1fr);gap:6px;}',
        '@media (min-width:900px){#card-grid.cards-12{grid-template-columns:repeat(6,1fr);}#card-grid.cards-16{grid-template-columns:repeat(8,1fr);}}',
        '.card-content svg,.card-content img,.reference-item-structure svg,.reference-item-structure img,',
        '.reference-detail-structure svg,.reference-detail-structure img,#modal-structure svg,#modal-structure img{',
        'max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block;}',
        '.footer-btn:disabled,.clue-btn:disabled,.next-btn:disabled,.menu-btn:disabled{opacity:.4;cursor:not-allowed;transform:none !important;}',
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
        '.reference-item.locked{background:#eceadf;}',
        '.reference-item-structure.locked{background:repeating-linear-gradient(45deg,#e6e4d8 0 8px,#dcd9cb 8px 16px);}',
        '.ref-lock{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:#8b8676;',
        'font-family:var(--font-display);font-size:.68rem;letter-spacing:.12em;text-align:center;padding:4px;}',
        '.ref-lock svg{width:26px;height:26px;opacity:.75;}',
        '.reference-detail-structure.locked{background:repeating-linear-gradient(45deg,#e6e4d8 0 10px,#dcd9cb 10px 20px);}',
        '.unlock-panel{background:rgba(0,0,0,.55);border:1px solid var(--card-border);border-radius:2px;padding:8px 12px;margin-bottom:10px;flex-shrink:0;}',
        '.unlock-panel-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;}',
        '.unlock-panel-title{font-family:var(--font-display);font-size:.78rem;color:var(--accent-gold);letter-spacing:.15em;}',
        '.unlock-panel-value{font-family:var(--font-display);font-size:.85rem;color:var(--card-bg);font-weight:700;}',
        '.unlock-track{height:6px;background:rgba(255,255,255,.12);border-radius:3px;overflow:hidden;}',
        '.unlock-fill{height:100%;background:linear-gradient(90deg,var(--accent-green),var(--accent-gold));border-radius:3px;transition:width .5s ease-out;width:0%;}',
        '.unlock-hint{font-size:.68rem;color:rgba(255,255,255,.55);margin-top:5px;font-family:var(--font-main);line-height:1.5;}',
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
        '.diff-text-wrap{display:flex;flex-direction:column;min-width:0;}',
        '#preparing-overlay{position:fixed;inset:0;background:rgba(10,15,20,.82);backdrop-filter:blur(4px);z-index:1500;',
        'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;}',
        '#preparing-overlay .prep-text{font-family:var(--font-display);color:var(--card-bg);letter-spacing:.2em;text-indent:.2em;font-size:1rem;}',
        '#preparing-overlay .prep-sub{font-family:var(--font-main);color:rgba(255,255,255,.65);font-size:.8rem;}'
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

        // オンライン同期状態
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

        // UI状態
        this.hasShownResult = false;
        this.roundResultModal = null;
        this.historyTargetId = null;
        this._finalCountdownTimer = null;
        this._gameEndResult = null;
        this._dealing = false;

        this.init();
    }

    /* ========================= 初期化 ========================= */
    async init() {
        console.log('App initializing...');
        try {
            injectExtraStyles();
            SettingsStore.init();
            ProgressManager.init();

            const loaded = await this.engine.loadData();
            if (!loaded) { this.showError('データ読み込み失敗'); return; }

            StructureRenderer.init();
            AudioManager.init();
            try { StorageManager.init(); } catch (e) { }

            // ★修正2: 音量・音声設定を実際に適用
            AudioBridge.applyAll();

            if (typeof OnlineManager !== 'undefined') {
                const onlineReady = OnlineManager.init();
                if (!onlineReady) console.warn('Online mode is disabled due to configuration.');
            }

            this.loadSettings();
            this.syncSettingsUI();
            this.bindEvents();
            this.renderCategoryGrid();
            this.decorateDifficultyButtons();
            this.normalizeStartButton();

            // ★構造式キャッシュ: 永続分を読み込み → バックグラウンドで全件生成
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

    /** 構造式キャッシュの初期化と事前生成 */
    async initStructureCache() {
        this.showCacheProgress(0, this.engine.compounds.length);
        try {
            const restored = await StructureCache.loadAll();
            console.log('[StructureCache] restored ' + restored + ' entries');
        } catch (e) { console.warn('[StructureCache] idb load failed', e); }

        StructureCache.onProgress = (done, total, finished) => {
            this.showCacheProgress(done, total);
            this.refreshTitleProgress();
            if (finished) console.log('[StructureCache] prefetch complete');
        };

        // まだ無い分だけ事前生成キューに積む
        const pending = this.engine.compounds.filter(c => c && c.smiles && !StructureCache.has(c));
        StructureCache.startPrefetch(pending);
        this.showCacheProgress(StructureCache.mem.size, this.engine.compounds.length);
    }

    /** ローディング画面内のキャッシュ進捗表示 */
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

    /* ========================= ★修正1: 開始ボタンの正規化 ========================= */
    normalizeStartButton() {
        const btn = document.getElementById('btn-start-difficulty');
        if (!btn) return;
        // 中のテキストを単一の span にまとめ、余計な空白/改行を除去
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

    /* ========================= アンロック処理 ========================= */
    handleCorrectAnswer(compound, meta) {
        if (!compound) return;
        if (this.isOnlineMode) return;
        const mode = (meta && meta.mode) || this.engine.mode;
        if (mode !== 'cpu') return;
        const id = String(compound.id || '').trim();
        if (!id) return;
        if (ProgressManager.unlock(id)) {
            this.showUnlockToast(compound);
            try { AudioManager.playSound('combo'); } catch (e) { }
        }
    }

    showUnlockToast(compound) {
        const toast = document.createElement('div');
        toast.className = 'unlock-toast';
        toast.innerHTML =
            '<div class="unlock-toast-icon">🔓</div>' +
            '<div><div class="unlock-toast-title">資料をアンロック</div>' +
            '<div class="unlock-toast-name">' + (compound.name || '') + '</div></div>';
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => { try { toast.remove(); } catch (e) { } }, 400);
        }, 2600);
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
                if (this._dealing) return;                 // 描画中のタップは無視
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
                this.hidePreparing();
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

        /* ---------- ★修正2: 設定画面（音量・音声・枚数） ---------- */
        this.bindSettingsControls();

        const resetBtn = document.getElementById('btn-reset-stats');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (confirm('統計・ポイント・アンロックデータをすべて初期化しますか？')) {
                    try { StorageManager.resetAll(); } catch (e) { }
                    ProgressManager.reset();
                    alert('初期化しました。');
                    this.updateStats();
                }
            });
        }
    }

    /** 設定画面の全コントロールを束縛（ID が未知でも動くよう総当たり） */
    bindSettingsControls() {
        const screen = document.getElementById('screen-settings') || document;

        // --- 音声読み上げ ON/OFF ---
        const voiceToggle = document.getElementById('setting-voice');
        if (voiceToggle) {
            voiceToggle.addEventListener('change', (e) => {
                SettingsStore.set('voiceEnabled', e.target.checked);
                AudioBridge.applyVoiceSettings();
                AudioBridge.applyAll();
            });
        }

        // --- 音声速度 ---
        const voiceSpeed = document.getElementById('setting-voice-speed');
        if (voiceSpeed) {
            voiceSpeed.addEventListener('change', (e) => {
                SettingsStore.set('voiceSpeed', parseFloat(e.target.value));
                AudioBridge.applyVoiceSettings();
            });
        }

        // --- ★修正4: カード表示数 ---
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

        // --- ★修正2: 音量スライダー（ID 不明でも拾う） ---
        this.volumeInputs = [];
        const ranges = Array.from(screen.querySelectorAll('input[type="range"]'));
        ranges.forEach((input, index) => {
            const role = this._detectVolumeRole(input, index, ranges.length);
            this.volumeInputs.push({ input: input, role: role });

            const onInput = () => {
                const max = parseFloat(input.max) || (input.tagName === 'SELECT' ? 5 : 100);
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

        // 音量が select で実装されている場合のフォロー
        Array.from(screen.querySelectorAll('select')).forEach(sel => {
            if (sel.id === 'setting-voice-speed' || sel.id === 'setting-card-count') return;
            const role = this._detectVolumeRole(sel, -1, 0);
            if (!role) return;
            sel.addEventListener('change', () => {
                const v = parseFloat(sel.value);
                if (!isFinite(v)) return;
                const norm = v > 1 ? v / (parseFloat(sel.options[sel.options.length - 1].value) || 5) : v;
                SettingsStore.set(role + 'Volume', Math.max(0, Math.min(1, norm)));
                AudioBridge.apply({
                    reader: SettingsStore.get('readerVolume'),
                    se: SettingsStore.get('seVolume'),
                    bgm: SettingsStore.get('bgmVolume')
                });
            });
        });
    }

    /** ラベル文字列や id から音量の役割を推定 */
    _detectVolumeRole(el, index, total) {
        const id = String(el.id || '').toLowerCase();
        const name = String(el.name || '').toLowerCase();
        const item = el.closest ? el.closest('.setting-item') : null;
        const labelText = item ? (item.textContent || '') : '';
        const hay = (id + ' ' + name + ' ' + labelText).toLowerCase();

        if (hay.indexOf('読手') >= 0 || hay.indexOf('reader') >= 0 || hay.indexOf('voice') >= 0 || hay.indexOf('speak') >= 0) return 'reader';
        if (hay.indexOf('bgm') >= 0 || hay.indexOf('music') >= 0) return 'bgm';
        if (hay.indexOf('se') >= 0 || hay.indexOf('sfx') >= 0 || hay.indexOf('効果音') >= 0) return 'se';

        // 見つからなければ並び順で割り当てる（読手 → SE → BGM）
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

    /** 保存済み設定を UI に反映 */
    syncSettingsUI() {
        const voiceToggle = document.getElementById('setting-voice');
        if (voiceToggle) voiceToggle.checked = !!SettingsStore.get('voiceEnabled');

        const voiceSpeed = document.getElementById('setting-voice-speed');
        if (voiceSpeed) voiceSpeed.value = String(SettingsStore.get('voiceSpeed'));

        const cardCount = document.getElementById('setting-card-count');
        if (cardCount) cardCount.value = String(SettingsStore.get('cardCount'));

        (this.volumeInputs || []).forEach(entry => {
            const input = entry.input;
            const role = entry.role;
            const norm = SettingsStore.get(role + 'Volume');
            const max = parseFloat(input.max) || 100;
            const min = parseFloat(input.min) || 0;
            const raw = Math.round(min + norm * (max - min));
            input.value = String(raw);
            this._updateVolumeIndicator(input, raw, max);
        });

        this.applyCardGridLayout(SettingsStore.get('cardCount'));
    }

    /** 難易度ボタンに CPU の挙動説明を付与 */
    decorateDifficultyButtons() {
        const desc = {
            0: 'CPUなし。読み札と構造式の確認用（アンロック対象外）',
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

    /* ========================= オンライン: メニュー ========================= */
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
                cardCount: SettingsStore.get('cardCount'),          // ★修正4
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

    /* ========================= オンライン: 開始 ========================= */
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
            cardCount: cardCount,
            categories: settings.categories || []
        });
        this.applyCardGridLayout(cardCount);
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
            cardCount: cardCount,
            categories: settings.categories || []
        });
        this.applyCardGridLayout(cardCount);
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
        this.stopFinalCountdown();
        this.hidePreparing();
        this.closeRoundResultModal();
    }

    resetOnlineState() {
        this.engine.pause();
        this.stopOnlineWatchdog();
        this.stopFinalCountdown();
        this.hidePreparing();
        this.isOnlineMode = false;
        this.isHost = false;
        this.onlineGameStarted = false;
        this.resetRoundUIState();
        const wm = document.getElementById('waiting-room-modal');
        if (wm) wm.remove();
        const om = document.getElementById('online-menu-modal');
        if (om) om.remove();
    }

    /* ========================= オンライン: 同期 ========================= */
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

    /* ========================= ウォッチドッグ ========================= */
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
                    console.warn('[watchdog] db round', dbRound, '!= engine round', myRound, '-> resend');
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

    /* ========================= 状態同期 ========================= */
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
            this.renderCards(cards, false).catch(() => { });
        }

        if (phase === 'reading') this.updateOnlineClue(gameState);
        else if (phase === 'dealing' && roundChanged && !this.isHost) this.resetClueDisplay();

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

    creditOpponentFromRoom(resultRound, target) {
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
                        // ★修正3: 描画完了 → cardsReady → 読み上げ
                        await this.renderCards(data.round.cards, true);
                    }
                } else {
                    this.resetClueDisplay();
                    // ★修正3: 全カード描画を await（旧版は 6 秒で打ち切って先に読み上げていた）
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
        this.updateFooterState(data);
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

    /* ---- 最終解答カウントダウン ---- */
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

    /* ========================= ★カード描画（キャッシュ優先） ========================= */
    applyCardGridLayout(count) {
        const grid = document.getElementById('card-grid');
        if (!grid) return;
        grid.classList.remove('cards-6', 'cards-9', 'cards-12', 'cards-16');
        grid.classList.add('cards-' + SettingsStore.normalizeCardCount(count));
    }

    showPreparing(text, sub) {
        let el = document.getElementById('preparing-overlay');
        if (!el) {
            el = document.createElement('div');
            el.id = 'preparing-overlay';
            document.body.appendChild(el);
        }
        el.innerHTML =
            '<div class="loading-spinner" style="width:40px;height:40px;border:4px solid var(--card-border);border-top-color:var(--accent-gold);"></div>' +
            '<div class="prep-text">' + (text || '準備中') + '</div>' +
            (sub ? '<div class="prep-sub" id="prep-sub">' + sub + '</div>' : '');
        return el;
    }

    updatePreparingSub(text) {
        const el = document.getElementById('prep-sub');
        if (el) el.textContent = text;
    }

    hidePreparing() {
        const el = document.getElementById('preparing-overlay');
        if (el) el.remove();
    }

    /**
     * カードを描画する。
     * @param {Array} cards
     * @param {boolean} startReading 完了後に読み上げを開始するか
     * ★修正3: 全カードの描画（キャッシュ注入 or 生成）が完了するまで
     *          engine.setCardsReady(true) を呼ばない＝読み上げは絶対に先行しない
     */
    async renderCards(cards, startReading) {
        const grid = document.getElementById('card-grid');
        if (!grid) return;

        const list = (cards || []).filter(c => c);
        this._dealing = true;
        this.engine.cardsReady = false;
        this.applyCardGridLayout(list.length);
        this.updateFooterState();

        // 1) 未取得分があれば事前にまとめて生成（キャッシュヒットなら即時）
        const missing = list.filter(c => !StructureCache.has(c));
        if (missing.length > 0) {
            StructureCache.pause();
            const overlay = this.showPreparing('札を準備中', '構造式を生成しています… 0 / ' + missing.length);
            try {
                await Promise.race([
                    StructureCache.ensureMany(missing, (done, total) => {
                        this.updatePreparingSub('構造式を生成しています… ' + done + ' / ' + total);
                    }),
                    new Promise(res => setTimeout(res, 20000))   // 万一のハング防止
                ]);
            } catch (e) { console.warn('ensureMany failed', e); }
            overlay.remove();
        }

        // 2) DOM 構築＋キャッシュHTMLの同期注入（待ち時間ほぼ0）
        grid.innerHTML = '';
        const pending = [];
        list.forEach(compound => {
            const div = document.createElement('div');
            div.className = 'card';
            div.dataset.id = String(compound.id || '').trim();
            const contentDiv = document.createElement('div');
            contentDiv.className = 'card-content';
            div.appendChild(contentDiv);
            grid.appendChild(div);

            if (StructureCache.applyTo(contentDiv, compound)) return;   // ★即時

            // キャッシュ miss時のフォールバック（直接レンダリング）
            div.classList.add('loading-card');
            contentDiv.innerHTML = '<div class="card-loading"><div class="loading-spinner"></div></div>';
            pending.push((async () => {
                try {
                    const html = await StructureCache.render(compound);
                    if (html) contentDiv.innerHTML = html;
                    else await StructureRenderer.render(contentDiv, compound.smiles, 'light', {
                        name: compound.name, name_en: compound.name_en, formula: compound.formula
                    });
                } catch (e) {
                    contentDiv.innerHTML =
                        '<div class="card-fallback"><div class="compound-name">' + (compound.name || '') + '</div>' +
                        '<div class="compound-formula">' + (compound.formula || '') + '</div></div>';
                } finally {
                    div.classList.remove('loading-card');
                }
            })());
        });

        if (pending.length > 0) {
            await Promise.race([
                Promise.all(pending),
                new Promise(res => setTimeout(res, 20000))
            ]);
        }

        // 3) 全カード描画完了 → エンジンに通知 → 読み上げ開始
        await new Promise(r => requestAnimationFrame(() => r()));
        this._dealing = false;
        this.engine.setCardsReady(true);
        if (startReading) this.engine.startReading(true);
        this.updateFooterState();
        if (!this.isOnlineMode) StructureCache.resume();
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

    /* ========================= モーダル管理 ========================= */
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
        this.updateFooterState();

        const playerWon = !!data.playerWon;
        const reason = data.reason || null;
        const compound = data.target || {};
        const explanation = data.explanation || '解説はありません。';

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
            resultTitle = playerWon ? '正解' : (this.isOnlineMode ? '相手の取りです' : '不正解');
            resultColor = playerWon ? '#22c55e' : 'var(--accent-red)';
        }

        const sc = (this.isHost || !this.isOnlineMode)
            ? this.engine.getAuthoritativeScores()
            : (() => { const s = (this.onlineGameState && this.onlineGameState.scores) || {}; return { player: this.num(s.player), opponent: this.num(s.opponent) }; })();
        const myNow = (this.isHost || !this.isOnlineMode) ? sc.player : sc.opponent;
        const oppNow = (this.isHost || !this.isOnlineMode) ? sc.opponent : sc.player;

        const targetId = String(compound.id || '').trim();
        const unlockedNow = targetId && ProgressManager.isUnlocked(targetId);
        const lockBadge = !this.isOnlineMode
            ? (unlockedNow
                ? '<div class="unlock-badge">🔓 資料アンロック済み</div>'
                : (this.isPracticeMode
                    ? '<div class="lock-badge">練習モードはアンロック対象外</div>'
                    : '<div class="lock-badge">🔒 正解すると資料が解放</div>'))
            : '';

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

        // ★構造式はキャッシュから即時注入（モーダル表示のもたつき防止）
        const structureDiv = document.getElementById('modal-structure');
        if (structureDiv) {
            if (!StructureCache.applyTo(structureDiv, compound)) {
                if (compound.smiles) {
                    StructureCache.render(compound).then(html => {
                        if (html && document.body.contains(structureDiv)) structureDiv.innerHTML = html;
                        else if (document.body.contains(structureDiv)) {
                            StructureRenderer.render(structureDiv, compound.smiles, 'light', {
                                name: compound.name, name_en: compound.name_en, formula: compound.formula
                            }).catch(() => { });
                        }
                    }).catch(() => { });
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
        this.hidePreparing();
        try { StorageManager.recordCpuResult(data.winner); } catch (e) { }

        const mode = this.isPracticeMode ? 'practice' : (this.isOnlineMode ? 'online' : 'cpu');
        const progress = ProgressManager.recordGameEnd({
            mode: mode,
            winner: data.winner,
            difficulty: this.isPracticeMode ? 0 : (this.selectedDifficulty || 0),
            correctRounds: (this.engine.roundWins ? this.engine.roundWins.player : 0)
        });
        this._gameEndResult = progress;

        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.id = 'game-end-modal';

        const rankUpHtml = progress.rankUp ? '<div class="rankup-banner">昇段 ／ ' + progress.rankUp + '</div>' : '';
        const pointsHtml = progress.gained > 0 ? '<div class="points-gained">+' + progress.gained + ' pt 獲得</div>' : '';

        if (this.isPracticeMode) {
            modal.innerHTML =
                '<div class="modal-content" style="background:var(--card-bg);border:3px solid var(--accent-gold);border-radius:2px;padding:25px 20px;max-width:420px;width:92%;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,0.5);">' +
                '<h2 style="font-size:1.8rem;margin-bottom:15px;color:var(--accent-gold);font-family:var(--font-display);letter-spacing:.2em;text-indent:.2em;">練習終了</h2>' +
                '<div style="background:var(--tatami-light);padding:20px;border-radius:2px;border:2px solid var(--card-border);margin-bottom:18px;">' +
                '<div style="font-size:0.85rem;color:var(--text-light);margin-bottom:8px;letter-spacing:.1em;font-family:var(--font-display);">TOTAL SCORE</div>' +
                '<div style="font-size:2.5rem;color:var(--accent-green);font-family:var(--font-display);font-weight:900;">' + (data.playerScore || 0) + '</div></div>' +
                '<p style="font-size:0.8rem;color:var(--text-light);margin-bottom:18px;line-height:1.6;">練習モードはポイント・アンロックの対象外です。<br>CPU戦で正解すると資料が解放されます。</p>' +
                '<button class="btn btn-primary" id="modal-finish-btn" style="width:100%;">タイトルへ戻る</button></div>';
        } else {
            const playerLabel = this.isOnlineMode ? 'あなた' : 'PLAYER';
            const opponentLabel = this.isOnlineMode ? '相手' : 'CPU';
            const message = data.winner === 'player' ? '勝利' : (data.winner === 'cpu' ? '敗北' : '引き分け');
            modal.innerHTML =
                '<div class="modal-content" style="background:var(--card-bg);border:3px solid var(--accent-gold);border-radius:2px;padding:25px 20px;max-width:420px;width:92%;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,0.5);">' +
                '<h2 style="font-size:1.8rem;margin-bottom:15px;color:var(--accent-gold);font-family:var(--font-display);letter-spacing:.2em;text-indent:.2em;">ゲーム終了</h2>' +
                '<div style="font-size:1.4rem;margin-bottom:14px;color:var(--text-dark);font-family:var(--font-display);font-weight:700;letter-spacing:.1em;">' + message + '</div>' +
                rankUpHtml + pointsHtml +
                '<div style="display:flex;justify-content:space-around;margin-bottom:18px;gap:15px;">' +
                '<div style="text-align:center;flex:1;background:var(--tatami-light);padding:12px 8px;border-radius:2px;border:2px solid var(--card-border);">' +
                '<div style="font-size:0.8rem;color:var(--text-light);margin-bottom:5px;letter-spacing:.1em;font-family:var(--font-display);">' + playerLabel + '</div>' +
                '<div style="font-size:1.8rem;color:var(--accent-green);font-family:var(--font-display);font-weight:900;">' + (data.playerScore || 0) + '</div></div>' +
                '<div style="text-align:center;flex:1;background:var(--tatami-light);padding:12px 8px;border-radius:2px;border:2px solid var(--card-border);">' +
                '<div style="font-size:0.8rem;color:var(--text-light);margin-bottom:5px;letter-spacing:.1em;font-family:var(--font-display);">' + opponentLabel + '</div>' +
                '<div style="font-size:1.8rem;color:var(--accent-red);font-family:var(--font-display);font-weight:900;">' + (data.cpuScore || 0) + '</div></div></div>' +
                '<div style="background:var(--tatami-light);border:2px solid var(--card-border);border-radius:2px;padding:10px;margin-bottom:18px;font-family:var(--font-display);">' +
                '<div style="font-size:0.72rem;color:var(--text-light);letter-spacing:.12em;margin-bottom:4px;">現在の段位</div>' +
                '<div style="font-size:1.15rem;font-weight:900;color:var(--accent-green);letter-spacing:.1em;">' + progress.rank.name + '</div>' +
                '<div style="font-size:0.85rem;color:var(--text-dark);margin-top:4px;">' + ProgressManager.points + ' pt ／ 通算 ' + ProgressManager.data.wins + ' 勝</div></div>' +
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
        this.stopOnlineWatchdog();
        this.stopFinalCountdown();
        this.hidePreparing();
        this.closeRoundResultModal();

        // ★修正4: カード枚数は SettingsStore が正本
        const cardCount = SettingsStore.get('cardCount');

        const settings = {
            mode: this.isPracticeMode ? 'practice' : 'cpu',
            isOnline: false,
            isHost: false,
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

        // 対戦中にバックグラウンド生成を止め、CPU を描画に集中させる
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
        const categoryName = this.getCategoryDisplayName(target.category);
        alert('ヒント: ' + categoryName + ' / 分子式: ' + target.formula);
    }

    /* ========================= 統計・段位 ========================= */
    updateStats() {
        let summary = null;
        try { summary = StorageManager.getSummary(); } catch (e) { summary = null; }
        const p = ProgressManager.data;

        this.setText('stat-games', p.gamesPlayed || (summary ? summary.totalGames : 0));
        this.setText('stat-accuracy', summary ? summary.accuracy + '%' : '0%');
        this.setText('stat-max-combo', summary ? summary.maxCombo : 0);
        this.setText('stat-cpu-wins', p.wins);
        this.setText('stat-cpu-losses', p.losses);
        this.setText('stat-cpu-draws', p.draws);
        this.setText('stat-cpu-winrate', ProgressManager.winRate() + '%');
        this.setText('profile-total-score', ProgressManager.points + ' pt');
        this.renderRankPanel();

        if (summary) {
            this.renderBarGraph('category-bars', summary.byCategory, (cat) => this.getCategoryDisplayName(cat));
            const diffNames = { 0: '練習', 1: '易しい', 3: '普通', 7: '難しい' };
            this.renderBarGraph('difficulty-bars', summary.byDifficulty, (d) => diffNames[d] || ('Lv.' + d));
            this.renderBarGraph('stage-bars', summary.byStage, (s) => 'STAGE ' + s);
            this.renderHistory(summary.history);
        }
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
            '<div class="profile-unlock">図鑑アンロック: <strong style="color:var(--accent-green);">' + unlocked + '</strong> / ' + totalCompounds + ' 化合物</div>';
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
            const total = val.correct + val.wrong;
            const rate = total > 0 ? Math.round((val.correct / total) * 100) : 0;
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

    /* ========================= 資料（ロック機構付き） ========================= */
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
        panel.innerHTML =
            '<div class="unlock-panel-row">' +
            '<span class="unlock-panel-title">図鑑アンロック</span>' +
            '<span class="unlock-panel-value">' + unlocked + ' / ' + total + '（' + pct + '%）</span></div>' +
            '<div class="unlock-track"><div class="unlock-fill" style="width:' + pct + '%"></div></div>' +
            '<div class="unlock-hint">CPU戦で正解した化合物の構造式が「資料」で開示されます（練習・オンラインは対象外）</div>';
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
        let filteredCompounds = this.engine.compounds;
        if (this.referenceCurrentCategory !== 'all') {
            filteredCompounds = filteredCompounds.filter(c => c.category === this.referenceCurrentCategory);
        }
        if (filteredCompounds.length === 0) {
            listContainer.innerHTML = '<div class="reference-empty">この単元には化合物がありません</div>';
            return;
        }

        const grouped = {};
        filteredCompounds.forEach(c => {
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
            const unlockedInCat = grouped[cat].filter(c => ProgressManager.isUnlocked(c.id)).length;
            header.textContent = this.getCategoryDisplayName(cat) + '（' + unlockedInCat + ' / ' + grouped[cat].length + '）';
            section.appendChild(header);

            const grid = document.createElement('div');
            grid.className = 'reference-grid';
            grouped[cat].forEach(compound => {
                const unlocked = ProgressManager.isUnlocked(compound.id);
                const item = document.createElement('div');
                item.className = 'reference-item' + (unlocked ? '' : ' locked');
                item.dataset.id = String(compound.id || '').trim();
                const structInner = unlocked ? '' : ('<div class="ref-lock">' + this._lockSvg() + '<span>未解放</span></div>');
                item.innerHTML =
                    '<div class="reference-item-structure ' + (unlocked ? '' : 'locked') + '">' + structInner + '</div>' +
                    '<div class="reference-item-name">' + (compound.name || '') + '</div>' +
                    '<div class="reference-item-formula">' + (unlocked ? (compound.formula || '') : '???') + '</div>';
                item.addEventListener('click', () => this.showReferenceDetail(compound));
                grid.appendChild(item);
                if (unlocked) renderQueue.push({ el: item.querySelector('.reference-item-structure'), compound: compound });
            });
            section.appendChild(grid);
            listContainer.appendChild(section);
        });

        // ★キャッシュから同期注入 → 未取得分だけ非同期生成
        requestAnimationFrame(() => {
            renderQueue.forEach(entry => {
                if (!entry.el) return;
                if (StructureCache.applyTo(entry.el, entry.compound)) return;
                StructureCache.render(entry.compound).then(html => {
                    if (html && document.body.contains(entry.el)) entry.el.innerHTML = html;
                }).catch(() => { });
            });
        });
    }

    showReferenceDetail(compound) {
        const modal = document.getElementById('reference-detail-modal');
        if (!modal) return;
        const compoundId = String(compound.id || '').trim();
        const clueData = this.engine.clues[compoundId];
        const unlocked = ProgressManager.isUnlocked(compoundId);

        this.setText('detail-name', compound.name || '');
        this.setText('detail-formula', unlocked ? (compound.formula || '') : '???（未解放）');

        const structureDiv = document.getElementById('detail-structure');
        if (structureDiv) {
            structureDiv.innerHTML = '';
            if (unlocked) {
                structureDiv.classList.remove('locked');
                if (!StructureCache.applyTo(structureDiv, compound)) {
                    StructureCache.render(compound).then(html => {
                        if (html && document.body.contains(structureDiv)) structureDiv.innerHTML = html;
                        else if (compound.smiles && document.body.contains(structureDiv)) {
                            StructureRenderer.render(structureDiv, compound.smiles, 'light', {
                                name: compound.name, name_en: compound.name_en, formula: compound.formula
                            }).catch(() => { });
                        }
                    }).catch(() => { });
                }
            } else {
                structureDiv.classList.add('locked');
                structureDiv.innerHTML =
                    '<div class="ref-lock" style="color:#8b8676;">' + this._lockSvg() +
                    '<span>構造式はロック中</span>' +
                    '<span style="font-size:.65rem;opacity:.8;">CPU戦でこの化合物に正解すると解放</span></div>';
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
                const content = document.createElement('div');
                content.textContent = unlocked ? clueData.explanation : '（構造式をアンロックすると全文を表示）';
                explanationDiv.appendChild(content);
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

    /* ========================= 画面切替・設定 ========================= */
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
            this.refreshTitleProgress();
            StructureCache.resume();
        }
        if (screenId === 'screen-settings') this.syncSettingsUI();
        this.updateFooterState();
    }

    refreshTitleProgress() {
        const container = document.querySelector('.title-logo');
        if (!container) return;
        const rank = ProgressManager.rankOf(ProgressManager.points);
        let bar = document.getElementById('title-progress-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'title-progress-bar';
            container.appendChild(bar);
        }
        const total = this.engine.compounds.length || 0;
        const cached = Math.min(StructureCache.mem.size, total);
        const cacheText = total > 0 && cached >= total
            ? '構造式キャッシュ 準備完了'
            : '構造式キャッシュ ' + cached + ' / ' + total;
        bar.innerHTML =
            '<div class="title-rank-line">段位 ' + rank.name + ' ／ ' + ProgressManager.points + ' pt ／ 通算 ' + ProgressManager.data.wins + ' 勝</div>' +
            '<div class="title-sub-line">図鑑アンロック ' + ProgressManager.unlockedCount() + ' / ' + total + '　・　' + cacheText + '</div>';
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
        // SettingsStore が正本。既存 StorageManager からも読み込む（init でマージ済み）
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