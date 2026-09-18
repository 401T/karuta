/* =========================================================================
online.js  —  オンライン対戦管理（修正版 v3）
【2枚目以降で読み札が始まらない根本原因の除去】
・書き込み直列化キュー（_enqueue）を導入
  → setRoundData(round N) より先に updateStage / finishRound が
    飛んでしまう「書き込み順序の逆転」を根絶
・updateStage の phase==='result' ガードを修正
  → 旧版は「前ラウンドの result が残っている」だけで
    以後すべてのステージ更新を永久に捨て続けていた（＝2枚目以降が進行不能）
  → resultRound が『現在のラウンド』のときだけ抑止し、
    それ以外は phase:'reading' + round を書き戻して自己修復
・setRoundData に currentStage 引数を追加（ウォッチドッグの復旧用）
========================================================================= */
const OnlineManager = {
    db: null,
    currentRoom: null,
    isHost: false,
    playerId: null,
    roomRef: null,
    onStateChange: null,
    onOpponentTap: null,
    isInitialized: false,
    _roomValueCb: null,
    _tapsCb: null,
    _writeQueue: Promise.resolve(),   // ★ v3

    /* ========================= 書き込み直列化 ========================= */
    /**
     * ★ v3: すべての Firebase 書き込みを 1 本化して順序を保証する。
     *   1 件が 8 秒以上ハングしても後続を止めない（タイムアウト付き）。
     */
    _enqueue(task, timeoutMs = 8000) {
        const run = this._writeQueue.then(() => {
            return Promise.race([
                Promise.resolve().then(task),
                new Promise(resolve => setTimeout(() => resolve('timeout'), timeoutMs))
            ]);
        }, () => {
            return Promise.race([
                Promise.resolve().then(task),
                new Promise(resolve => setTimeout(() => resolve('timeout'), timeoutMs))
            ]);
        });
        this._writeQueue = run.then(() => { }, () => { });
        return run.catch(e => { console.error('OnlineManager write error:', e); });
    },

    init() {
        if (typeof firebase === 'undefined') {
            console.warn('Firebase SDK not loaded');
            return false;
        }
        if (this.isInitialized && this.db) return true;
        try {
            if (!firebase.apps.length) {
                const firebaseConfig = {
                    apiKey: "AIzaSyAsuOgiPKYiZc_vP1E8JEaKufr3Bod51a8",
                    authDomain: "chem-karut.firebaseapp.com",
                    databaseURL: "https://chem-karut-default-rtdb.asia-southeast1.firebasedatabase.app",
                    projectId: "chem-karut",
                    storageBucket: "chem-karut.firebasestorage.app",
                    messagingSenderId: "283699409494",
                    appId: "1:283699409494:web:c1251c794169d7bc4c81f7"
                };
                firebase.initializeApp(firebaseConfig);
            }
            this.db = firebase.database();
            if (!this.playerId) {
                this.playerId = 'player_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            }
            this.isInitialized = true;
            console.log('✅ OnlineManager initialized, playerId:', this.playerId);
            return true;
        } catch (e) {
            console.error('❌ Firebase initialization error:', e);
            return false;
        }
    },
    async createRoom(settings) {
        if (!this.db) throw new Error('Firebase not initialized');
        const roomId = this.generateRoomId();
        const roomRef = this.db.ref('rooms/' + roomId);
        const roomData = {
            roomId: roomId,
            host: this.playerId,
            guest: null,
            status: 'waiting',
            settings: settings || {},
            gameState: {
                round: 0,
                totalRounds: 10,
                currentStage: 0,
                cards: [],
                target: null,
                scores: { player: 0, opponent: 0 },
                phase: 'waiting',
                roundWinner: null,
                resultRound: null
            },
            taps: {},
            createdAt: firebase.database.ServerValue.TIMESTAMP,
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        };
        await roomRef.set(roomData);
        this.currentRoom = roomId;
        this.isHost = true;
        this.roomRef = roomRef;
        this._writeQueue = Promise.resolve();
        try { roomRef.onDisconnect().remove(); } catch (e) { }
        console.log('Room created:', roomId);
        return roomId;
    },
    async joinRoom(roomId) {
        if (!this.db) throw new Error('Firebase not initialized');
        const roomRef = this.db.ref('rooms/' + roomId);
        const snapshot = await roomRef.get();
        if (!snapshot.exists()) throw new Error('ルームが見つかりません');
        const roomData = snapshot.val();
        if (roomData.host === this.playerId) throw new Error('自分のルームには参加できません');
        if (roomData.guest && roomData.status === 'playing') throw new Error('このルームは対戦中です');
        await roomRef.update({
            guest: this.playerId,
            status: 'playing',
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        });
        this.currentRoom = roomId;
        this.isHost = false;
        this.roomRef = roomRef;
        this._writeQueue = Promise.resolve();
        try {
            roomRef.child('guest').onDisconnect().remove();
            roomRef.child('status').onDisconnect().set('waiting');
        } catch (e) { }
        console.log('Joined room:', roomId);
        return true;
    },
    async leaveRoom() {
        if (!this.roomRef) { this.cleanup(); return; }
        try {
            await this.roomRef.onDisconnect().cancel();
            const snapshot = await this.roomRef.get();
            if (snapshot.exists()) {
                if (this.isHost) {
                    await this.roomRef.remove();
                } else {
                    await this.roomRef.update({
                        guest: null,
                        status: 'waiting',
                        'gameState/phase': 'waiting',
                        'gameState/roundWinner': null,
                        'gameState/resultRound': null,
                        taps: {},
                        updatedAt: firebase.database.ServerValue.TIMESTAMP
                    });
                }
            }
        } catch (e) {
            console.error('Error leaving room:', e);
        }
        this.cleanup();
    },
    /** ルーム状態の監視（差し替え式・常に 1 本だけ） */
    onRoomUpdate(callback) {
        if (!this.roomRef) return;
        this.onStateChange = callback;
        if (this._roomValueCb) {
            this.roomRef.off('value', this._roomValueCb);
            this._roomValueCb = null;
        }
        const listener = (snapshot) => {
            if (!callback) return;
            if (snapshot.exists()) callback(snapshot.val());
            else callback(null);
        };
        this._roomValueCb = listener;
        this.roomRef.on('value', listener);
    },
    /** タップ監視（差し替え式） */
    onTaps(callback) {
        if (!this.roomRef) return;
        this.onOpponentTap = callback;
        const tapsRef = this.roomRef.child('taps');
        if (this._tapsCb) {
            tapsRef.off('value', this._tapsCb);
            this._tapsCb = null;
        }
        const listener = (snapshot) => {
            if (!callback || !snapshot.exists()) return;
            const taps = snapshot.val() || {};
            const opponentTaps = {};
            for (const pid in taps) {
                if (pid !== this.playerId) opponentTaps[pid] = taps[pid];
            }
            if (Object.keys(opponentTaps).length > 0) callback(opponentTaps);
        };
        this._tapsCb = listener;
        tapsRef.on('value', listener);
    },
    recordTap(cardId, meta) {
        if (!this.roomRef) return Promise.resolve();
        const m = meta || {};
        return this._enqueue(async () => {
            await this.roomRef.child('taps/' + this.playerId).set({
                cardId: String(cardId || '').trim(),
                round: Number(m.round) || 0,
                stage: Number(m.stage) || 0,
                seq: Number(m.seq) || Date.now(),
                timestamp: firebase.database.ServerValue.TIMESTAMP
            });
        }, 5000);
    },
    generateRoomId() {
        return Math.random().toString(36).substr(2, 6).toUpperCase();
    },
    cleanup() {
        try {
            if (this.roomRef && this._roomValueCb) this.roomRef.off('value', this._roomValueCb);
            if (this.roomRef && this._tapsCb) this.roomRef.child('taps').off('value', this._tapsCb);
        } catch (e) { }
        this._roomValueCb = null;
        this._tapsCb = null;
        this.currentRoom = null;
        this.roomRef = null;
        this.onStateChange = null;
        this.onOpponentTap = null;
        this._writeQueue = Promise.resolve();
    },
    updateGameState(partial) {
        if (!this.roomRef) return Promise.resolve();
        return this._enqueue(async () => {
            await this.roomRef.child('gameState').update(Object.assign({}, partial, {
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            }));
        });
    },
    /**
     * ★ ラウンドデータ設定（currentStage 引数追加 → 復旧時にステージを潰さない）
     */
    setRoundData(cards, target, roundNumber, totalRounds, currentStage) {
        if (!this.roomRef) return Promise.resolve();
        return this._enqueue(async () => {
            try { await this.roomRef.child('taps').remove(); } catch (e) { }
            const payload = {
                cards: cards || [],
                target: target || null,
                round: Number(roundNumber) || 0,
                currentStage: Number(currentStage) || 0,
                phase: (Number(currentStage) > 0) ? 'reading' : 'dealing',
                roundWinner: null,
                resultRound: null,
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            };
            if (typeof totalRounds === 'number') payload.totalRounds = totalRounds;
            await this.roomRef.child('gameState').update(payload);
            console.log('[online] setRoundData round=' + payload.round + ' phase=' + payload.phase);
        });
    },
    /**
     * ★ v3: ステージ更新（自己修復型）
     *   ・finished は抑止
     *   ・「現在ラウンドの結果確定」だけが抑止対象
     *   ・前ラウンドの result が残っていても reading で上書きして復旧する
     *   ・round も一緒に書いて DB 側のラウンドズレを修復する
     */
    updateStage(stageNumber, roundNumber) {
        if (!this.roomRef) return Promise.resolve();
        return this._enqueue(async () => {
            const stage = Number(stageNumber) || 0;
            const rnd = Number(roundNumber) || 0;
            try {
                const snap = await this.roomRef.child('gameState').get();
                if (snap.exists()) {
                    const gs = snap.val() || {};
                    const gsRound = Number(gs.round) || 0;
                    if (gs.phase === 'finished') return;
                    if (rnd && gsRound && gsRound !== rnd) {
                        console.warn('[online] updateStage skipped: db round', gsRound, '!= local', rnd);
                        return;
                    }
                    const resRound = (gs.resultRound === undefined || gs.resultRound === null)
                        ? null : Number(gs.resultRound);
                    if (gs.phase === 'result' && (resRound === null || resRound === rnd)) {
                        return; // 本当に現在のラウンドの結果確定済み
                    }
                    if (gs.phase === 'result') {
                        console.warn('[online] stale result (round ' + resRound + ') detected -> repair to reading round ' + rnd);
                    }
                }
            } catch (e) { /* 読めなければそのまま更新 */ }
            const payload = {
                currentStage: stage,
                phase: 'reading',
                roundWinner: null,
                resultRound: null,
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            };
            if (rnd) payload.round = rnd;
            await this.roomRef.child('gameState').update(payload);
        });
    },
    updateScores(scores) {
        if (!this.roomRef) return Promise.resolve();
        return this._enqueue(async () => {
            await this.roomRef.child('gameState').update({
                scores: scores || { player: 0, opponent: 0 },
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            });
        });
    },
    finishRound(winner, roundNumber, scores) {
        if (!this.roomRef) return Promise.resolve();
        return this._enqueue(async () => {
            const payload = {
                phase: 'result',
                roundWinner: winner,
                resultRound: (typeof roundNumber === 'number') ? roundNumber : null,
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            };
            if (typeof roundNumber === 'number' && roundNumber > 0) payload.round = roundNumber;
            if (scores) payload.scores = scores;
            await this.roomRef.child('gameState').update(payload);
            console.log('[online] finishRound round=' + roundNumber + ' winner=' + winner);
        });
    },
    finishGame(finalScores) {
        if (!this.roomRef) return Promise.resolve();
        return this._enqueue(async () => {
            const payload = {
                phase: 'finished',
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            };
            if (finalScores) payload.scores = finalScores;
            await this.roomRef.child('gameState').update(payload);
        });
    },
    async getRoom() {
        if (!this.roomRef) return null;
        try {
            const snap = await this.roomRef.get();
            return snap.exists() ? snap.val() : null;
        } catch (e) {
            console.error('getRoom error:', e);
            return null;
        }
    }
};