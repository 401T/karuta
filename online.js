/**
 * OnlineManager - オンライン対戦管理（修正版）
 * - ゲストはホストのゲーム開始を待つ
 * - ルーム状態のクリーンアップ処理を追加
 * - タイムアウト処理で「対戦中です」問題を解消
 */
const OnlineManager = {
    db: null,
    currentRoom: null,
    isHost: false,
    playerId: null,
    roomRef: null,
    listeners: [],
    onStateChange: null,
    onOpponentTap: null,
    joinTimestamp: null, // 参加時刻（タイムアウト用）

    init() {
        if (typeof firebase === 'undefined') {
            console.warn('Firebase SDK not loaded');
            return false;
        }
        if (!firebase.apps.length) {
            const firebaseConfig = {
                apiKey: "YOUR_API_KEY",
                authDomain: "YOUR_PROJECT.firebaseapp.com",
                databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
                projectId: "YOUR_PROJECT_ID",
                storageBucket: "YOUR_PROJECT.appspot.com",
                messagingSenderId: "YOUR_SENDER_ID",
                appId: "YOUR_APP_ID"
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
            gameState: {
                round: 0,
                totalRounds: 10,
                currentStage: 0,
                cards: [],
                target: null,
                scores: { player: 0, opponent: 0 },
                phase: 'waiting'
            },
            taps: {},
            createdAt: firebase.database.ServerValue.TIMESTAMP,
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        };

        await roomRef.set(roomData);
        
        this.currentRoom = roomId;
        this.isHost = true;
        this.roomRef = roomRef;
        this.joinTimestamp = Date.now();

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

        // ルーム状態のチェックとクリーンアップ
        if (roomData.status === 'playing' && !roomData.guest) {
            // ゲストがいないのにplaying状態 → クリーンアップ
            console.warn('Room is in playing state but no guest. Cleaning up...');
            await roomRef.update({
                status: 'waiting',
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            });
        } else if (roomData.status === 'playing' && roomData.guest) {
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
        this.joinTimestamp = Date.now();

        console.log('Joined room:', roomId);
        return true;
    },

    async leaveRoom() {
        if (!this.roomRef) return;
        const snapshot = await this.roomRef.get();
        if (!snapshot.exists()) return;

        const roomData = snapshot.val();

        if (this.isHost) {
            // ホストが退出 → ルームを削除
            await this.roomRef.remove();
        } else {
            // ゲストが退出 → ステータスをwaitingに戻す
            await this.roomRef.update({
                guest: null,
                status: 'waiting',
                gameState: {
                    phase: 'waiting'
                },
                taps: {},
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            });
        }

        this.cleanup();
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
        this.joinTimestamp = null;
    }
};