/**
 * OnlineManager - オンライン対戦管理
 * Firebase Realtime Database を使用
 */
const OnlineManager = {
    db: null,
    currentRoom: null,
    isHost: false,
    playerId: null,
    roomRef: null,
    listeners: [],

    /**
     * Firebase 初期化
     */
    init() {
        if (typeof firebase === 'undefined') {
            console.warn('Firebase SDK not loaded');
            return false;
        }
        if (!firebase.apps.length) {
            // Firebase Console から取得した設定に置き換えてください
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

    /**
     * ルーム作成
     */
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
            gameState: null,
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

    /**
     * ルーム参加
     */
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

    /**
     * ルーム退出
     */
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
     * ゲーム状態を更新
     */
    async updateGameState(gameState) {
        if (!this.roomRef) return;

        await this.roomRef.update({
            gameState: gameState,
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        });
    },

    /**
     * カードタップを記録
     */
    async recordCardTap(cardId) {
        if (!this.roomRef) return;

        const actionRef = this.roomRef.child('actions').push();
        await actionRef.set({
            playerId: this.playerId,
            type: 'card_tap',
            cardId: cardId,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
    },

    /**
     * ルーム状態の監視
     */
    onRoomUpdate(callback) {
        if (!this.roomRef) return;

        const listener = this.roomRef.on('value', (snapshot) => {
            if (snapshot.exists()) {
                callback(snapshot.val());
            }
        });

        this.listeners.push({ ref: this.roomRef, event: 'value', callback: listener });
    },

    /**
     * アクションの監視
     */
    onAction(callback) {
        if (!this.roomRef) return;

        const actionsRef = this.roomRef.child('actions');
        const listener = actionsRef.on('child_added', (snapshot) => {
            const action = snapshot.val();
            if (action.playerId !== this.playerId) {
                callback(action);
            }
        });

        this.listeners.push({ ref: actionsRef, event: 'child_added', callback: listener });
    },

    /**
     * ルームID生成（6桁）
     */
    generateRoomId() {
        return Math.random().toString(36).substr(2, 6).toUpperCase();
    },

    /**
     * リスナーのクリーンアップ
     */
    cleanup() {
        this.listeners.forEach(({ ref, event, callback }) => {
            ref.off(event, callback);
        });
        this.listeners = [];
        this.currentRoom = null;
        this.roomRef = null;
    }
};