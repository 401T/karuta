/**
 * OnlineManager - オンライン対戦管理（完全修正版）
 * - firebase-config.jsは不要（このファイルに統合）
 * - 二重宣言エラーを修正
 * - Firebase未設定時でもエラーにならない
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
    isInitialized: false,

    /**
     * Firebase初期化
     * ★ Firebase Consoleから取得した設定をfirebaseConfigに貼り付けてください
     */
    // online.js の init() メソッド内

    init() {
        if (typeof firebase === 'undefined') {
            console.warn('Firebase SDK not loaded');
            return false;
        }

        if (this.isInitialized) {
            return true;
        }

        try {
            if (!firebase.apps.length) {
                // ★★★★★ ご提示いただいた設定情報に置き換えてください ★★★★★
                const firebaseConfig = {
                    apiKey: "AIzaSyAsuOgiPKYiZc_vP1E8JEaKufr3Bod51a8",
                    authDomain: "chem-karut.firebaseapp.com",
                    databaseURL: "https://chem-karut-default-rtdb.asia-southeast1.firebasedatabase.app",
                    projectId: "chem-karut",
                    storageBucket: "chem-karut.firebasestorage.app",
                    messagingSenderId: "283699409494",
                    appId: "1:283699409494:web:c1251c794169d7bc4c81f7"
                };
                // ★★★★★ ここまで ★★★★★

                // 初期化
                firebase.initializeApp(firebaseConfig);
            }

            this.db = firebase.database();
            this.playerId = 'player_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            this.isInitialized = true;

            console.log('✅ OnlineManager initialized, playerId:', this.playerId);
            return true;
        } catch (e) {
            console.error('❌ Firebase initialization error:', e);
            return false;
        }
    },

    async createRoom(settings) {
        if (!this.db) {
            throw new Error('Firebase not initialized');
        }

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

        console.log('Room created:', roomId);
        return roomId;
    },

    async joinRoom(roomId) {
        if (!this.db) {
            throw new Error('Firebase not initialized');
        }

        const roomRef = this.db.ref('rooms/' + roomId);
        const snapshot = await roomRef.get();

        if (!snapshot.exists()) {
            throw new Error('ルームが見つかりません');
        }

        const roomData = snapshot.val();

        if (roomData.status === 'playing' && !roomData.guest) {
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

        console.log('Joined room:', roomId);
        return true;
    },

    async leaveRoom() {
        if (!this.roomRef) return;

        try {
            const snapshot = await this.roomRef.get();
            if (!snapshot.exists()) return;

            const roomData = snapshot.val();

            if (this.isHost) {
                await this.roomRef.remove();
            } else {
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
        } catch (e) {
            console.error('Error leaving room:', e);
        }

        this.cleanup();
    },

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

    async recordTap(cardId) {
        if (!this.roomRef) return;
        const tapRef = this.roomRef.child('taps/' + this.playerId);
        await tapRef.set({
            cardId: cardId,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
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
    },
    /**
     * ゲーム状態を更新
     */
    async updateGameState(gameState) {
        if (!this.roomRef) return;
        await this.roomRef.child('gameState').update({
            ...gameState,
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        });
    }
};