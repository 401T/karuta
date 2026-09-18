/* =========================================================================
   online.js  —  オンライン対戦管理（修正版 v2）
   -------------------------------------------------------------------------
   修正点:
   ・リスナーの多重登録を防止（onRoomUpdate / onTaps は「差し替え式」）
     → 読み札が何十個も重複する原因だった
   ・setRoundData でルーム直下の taps を確実に削除し、
     roundWinner / resultRound をリセット
     → 「一度正解すると以降タップできない」原因だった
   ・finishRound / updateStage にラウンド番号を持たせ、
     前ラウンドの結果・古いステージ更新で上書きされないようにした
   ・ルーム消滅（相手退出）を検知できるように callback(null) を追加
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

    /**
     * Firebase初期化
     */
    init() {
        if (typeof firebase === 'undefined') {
            console.warn('Firebase SDK not loaded');
            return false;
        }
        if (this.isInitialized && this.db) {
            return true;
        }
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

        // 切断時の後始末（ホストが落ちたらルームごと削除）
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

        if (roomData.host === this.playerId) {
            throw new Error('自分のルームには参加できません');
        }
        if (roomData.guest && roomData.status === 'playing') {
            throw new Error('このルームは対戦中です');
        }

        await roomRef.update({
            guest: this.playerId,
            status: 'playing',
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        });

        this.currentRoom = roomId;
        this.isHost = false;
        this.roomRef = roomRef;

        // 切断時の後始末（ゲストが落ちたら待機状態に戻す）
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

    /**
     * ルーム状態の監視（★リスナーは必ず1本だけ。呼び直すたびに差し替え）
     */
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
            else callback(null); // ルーム消失（相手が退出）
        };
        this._roomValueCb = listener;
        this.roomRef.on('value', listener);
    },

    /**
     * タップ監視（★こちらも差し替え式）
     */
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

    /**
     * 自分のタップを記録（round / stage / seq を付けて誤判定を防止）
     */
    async recordTap(cardId, meta) {
        if (!this.roomRef) return;
        const m = meta || {};
        try {
            await this.roomRef.child('taps/' + this.playerId).set({
                cardId: String(cardId || '').trim(),
                round: Number(m.round) || 0,
                stage: Number(m.stage) || 0,
                seq: Number(m.seq) || Date.now(),
                timestamp: firebase.database.ServerValue.TIMESTAMP
            });
        } catch (e) {
            console.error('recordTap error:', e);
        }
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
    },

    async updateGameState(partial) {
        if (!this.roomRef) return;
        await this.roomRef.child('gameState').update(Object.assign({}, partial, {
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        }));
    },

    /**
     * ★ ラウンドデータ設定
     *   taps は「ルーム直下」にあるので child('taps') を削除する（旧版のバグ）
     *   roundWinner / resultRound も必ずリセットする
     */
    async setRoundData(cards, target, roundNumber, totalRounds) {
        if (!this.roomRef) return;
        try { await this.roomRef.child('taps').remove(); } catch (e) { }
        const payload = {
            cards: cards || [],
            target: target || null,
            round: Number(roundNumber) || 0,
            currentStage: 0,
            phase: 'dealing',
            roundWinner: null,
            resultRound: null,
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        };
        if (typeof totalRounds === 'number') payload.totalRounds = totalRounds;
        await this.roomRef.child('gameState').update(payload);
    },

    /**
     * ★ stage更新（result / finished を上書きしない・他ラウンドは無視）
     */
    async updateStage(stageNumber, roundNumber) {
        if (!this.roomRef) return;
        try {
            const snap = await this.roomRef.child('gameState').get();
            if (snap.exists()) {
                const gs = snap.val() || {};
                if (gs.phase === 'result' || gs.phase === 'finished') return;
                if (typeof roundNumber === 'number' && gs.round && Number(gs.round) !== Number(roundNumber)) return;
            }
        } catch (e) { /* 読めなかった場合はそのまま更新 */ }
        await this.roomRef.child('gameState').update({
            currentStage: Number(stageNumber) || 0,
            phase: 'reading',
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        });
    },

    async updateScores(scores) {
        if (!this.roomRef) return;
        await this.roomRef.child('gameState').update({
            scores: scores || { player: 0, opponent: 0 },
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        });
    },

    /**
     * ★ ラウンド終了（resultRound を必ずセット → 古い結果の再表示を防止）
     */
    async finishRound(winner, roundNumber, scores) {
        if (!this.roomRef) return;
        const payload = {
            phase: 'result',
            roundWinner: winner,
            resultRound: (typeof roundNumber === 'number') ? roundNumber : null,
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        };
        if (scores) payload.scores = scores;
        await this.roomRef.child('gameState').update(payload);
    },

    async finishGame(finalScores) {
        if (!this.roomRef) return;
        const payload = {
            phase: 'finished',
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        };
        if (finalScores) payload.scores = finalScores;
        await this.roomRef.child('gameState').update(payload);
    },

    async getRoom() {
        if (!this.roomRef) return null;
        const snap = await this.roomRef.get();
        return snap.exists() ? snap.val() : null;
    }
};