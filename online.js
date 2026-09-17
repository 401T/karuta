/**
 * OnlineManager - オンライン対戦管理（改訂版）
 * ホストがゲーム状態を管理、ゲストは同期する
 */
const OnlineManager = {
    db: null,
    currentRoom: null,
    isHost: false,
    playerId: null,
    roomRef: null,
    listeners: [],
    onStateChange: null, // ゲーム状態変更コールバック
    onOpponentTap: null, // 相手のタップコールバック

    init() {
        if (typeof firebase === 'undefined') {
            console.warn('Firebase SDK not loaded');
            return false;
        }
        if (!firebase.apps.length) {
            const firebaseConfig = {
            apiKey: "AIzaSyAsuOgiPKYiZc_vP1E8JEaKufr3Bod51a8",
            authDomain: "chem-karut.firebaseapp.com",
            databaseURL: "https://chem-karut-default-rtdb.asia-southeast1.firebasedatabase.app",
            projectId: "chem-karut",
            storageBucket: "chem-karut.firebasestorage.app",
            messagingSenderId: "283699409494",
            appId: "1:283699409494:web:41a17f4c8551d0224c81f7",
            measurementId: "G-8N22NYHZQZ"
            };
            firebase.initializeApp(firebaseConfig);
        }
        this.db = firebase.database();
        this.playerId = 'player_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        console.log('OnlineManager initialized, playerId:', this.playerId);
        return true;
    },

    async createRoom(settings) {
        if (!this.db) return null;
        const roomId = this.generateRoomId();
        const roomRef = this.db.ref('rooms/' + roomId);
        
        const roomData = {
            roomId: roomId,
            host: this.playerId,
            guest: null,
            status: 'waiting',
            settings: settings,
            // ゲーム状態（ホストが更新）
            gameState: {
                round: 0,
                totalRounds: 10,
                currentStage: 0,
                cards: [],
                target: null,
                scores: { player: 0, opponent: 0 },
                phase: 'waiting' // waiting, dealing, reading, result, finished
            },
            // タップ履歴
            taps: {},
            createdAt: firebase.database.ServerValue.TIMESTAMP,
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        };

        await roomRef.set(roomData);
        
        this.currentRoom = roomId;
        this.isHost = true;
        this.roomRef = roomRef;

        console.log('Room created:', roomId);
        return roomId;
    },

    async joinRoom(roomId) {
        if (!this.db) return false;
        const roomRef = this.db.ref('rooms/' + roomId);
        const snapshot = await roomRef.get();

        if (!snapshot.exists()) {
            throw new Error('ルームが見つかりません');
        }

        const roomData = snapshot.val();

        if (roomData.status !== 'waiting') {
            throw new Error('このルームは対戦中です');
        }

        if (roomData.host === this.playerId) {
            throw new Error('自分のルームには参加できません');
        }

        await roomRef.update({
            guest: this.playerId,
            status: 'playing',
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        });

        this.currentRoom = roomId;
        this.isHost = false;
        this.roomRef = roomRef;

        console.log('Joined room:', roomId);
        return true;
    },

    async leaveRoom() {
        if (!this.roomRef) return;
        const snapshot = await this.roomRef.get();
        if (!snapshot.exists()) return;

        const roomData = snapshot.val();

        if (this.isHost) {
            await this.roomRef.remove();
        } else {
            await this.roomRef.update({
                guest: null,
                status: 'waiting',
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            });
        }

        this.cleanup();
    },

    /**
     * ホスト: ゲーム状態を更新
     */
    async updateGameState(gameState) {
        if (!this.roomRef || !this.isHost) return;
        await this.roomRef.child('gameState').update({
            ...gameState,
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        });
    },

    /**
     * ホスト: カード配列と正解を設定
     */
    async setRoundData(cards, target, roundNumber) {
        if (!this.roomRef || !this.isHost) return;
        await this.roomRef.child('gameState').update({
            cards: cards,
            target: target,
            round: roundNumber,
            currentStage: 0,
            phase: 'dealing',
            taps: {}
        });
    },

    /**
     * ホスト: 現在のstageを更新
     */
    async updateStage(stageNumber) {
        if (!this.roomRef || !this.isHost) return;
        await this.roomRef.child('gameState').update({
            currentStage: stageNumber,
            phase: 'reading'
        });
    },

    /**
     * ホスト: 得点を更新
     */
    async updateScores(scores) {
        if (!this.roomRef || !this.isHost) return;
        await this.roomRef.child('gameState').update({
            scores: scores
        });
    },

    /**
     * ホスト: ラウンド終了
     */
    async finishRound(winner) {
        if (!this.roomRef || !this.isHost) return;
        await this.roomRef.child('gameState').update({
            phase: 'result',
            roundWinner: winner
        });
    },

    /**
     * ホスト: ゲーム終了
     */
    async finishGame(finalScores) {
        if (!this.roomRef || !this.isHost) return;
        await this.roomRef.child('gameState').update({
            phase: 'finished',
            scores: finalScores
        });
    },

    /**
     * 両プレイヤー: タップを記録
     */
    async recordTap(cardId) {
        if (!this.roomRef) return;
        const tapRef = this.roomRef.child('taps/' + this.playerId);
        await tapRef.set({
            cardId: cardId,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
    },

    /**
     * タップをクリア
     */
    async clearTaps() {
        if (!this.roomRef) return;
        await this.roomRef.child('taps').remove();
    },

    /**
     * ルーム状態の監視（ゲーム状態変更）
     */
    onRoomUpdate(callback) {
        if (!this.roomRef) return;
        this.onStateChange = callback;

        const listener = this.roomRef.child('gameState').on('value', (snapshot) => {
            if (snapshot.exists() && callback) {
                callback(snapshot.val());
            }
        });

        this.listeners.push({ ref: this.roomRef.child('gameState'), event: 'value', callback: listener });
    },

    /**
     * タップの監視
     */
    onTaps(callback) {
        if (!this.roomRef) return;
        this.onOpponentTap = callback;

        const listener = this.roomRef.child('taps').on('value', (snapshot) => {
            if (snapshot.exists() && callback) {
                const taps = snapshot.val();
                // 自分のタップ以外のものを検出
                const opponentId = this.isHost ? 'guest' : 'host';
                // 実際にはplayerIdで判断
                const opponentTaps = {};
                for (const pid in taps) {
                    if (pid !== this.playerId) {
                        opponentTaps[pid] = taps[pid];
                    }
                }
                if (Object.keys(opponentTaps).length > 0) {
                    callback(opponentTaps);
                }
            }
        });

        this.listeners.push({ ref: this.roomRef.child('taps'), event: 'value', callback: listener });
    },

    generateRoomId() {
        return Math.random().toString(36).substr(2, 6).toUpperCase();
    },

    cleanup() {
        this.listeners.forEach(({ ref, event, callback }) => {
            ref.off(event, callback);
        });
        this.listeners = [];
        this.currentRoom = null;
        this.roomRef = null;
        this.onStateChange = null;
        this.onOpponentTap = null;
    }
};