/* =========================================================================
app.js  —  メインアプリケーション（オンライン対戦 修正版 v3）
【症状: 2問目以降、読み札が読まれはじめない／ゲームが進まない】への対策
 1) ホストの読み上げ開始をカード描画の完了から切り離した
    （描画が 15 秒タイムアウトすると startReading 自体が呼ばれなかった）
 2) startReading(true) で state 汚染による永久停止を防止
 3) 前ラウンドの result スナップショットで現在のラウンドを殺さない
    （forceRoundEndLocal にラウンド番号照合を追加／不一致なら DB を修復）
 4) syncOnlineGameState に同期シーケンスを導入し、
    古い dealing スナップショットが読み札表示を消す事故を防止
 5) resetClueDisplay は「ラウンドが変わったとき」だけ実行
 6) オンライン常時ウォッチドッグ（3秒間隔）
    ホスト: DB の round/phase がズレていたら書き戻し＋読み上げ再点火
    ゲスト: 表示だけ取り残されていたら最新状態を再適用
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
        this.syncSeq = 0;                 // ★ v3
        this._onlineWatchdog = null;      // ★ v3
        // UI状態
        this.hasShownResult = false;
        this.roundResultModal = null;
        this.historyTargetId = null;
        this.init();
    }
    /* ========================= 初期化 ========================= */
    async init() {
        console.log('App initializing...');
        try {
            const loaded = await this.engine.loadData();
            if (!loaded) { this.showError('データ読み込み失敗'); return; }
            console.log('Data loaded successfully');
            StructureRenderer.init();
            AudioManager.init();
            StorageManager.init();
            if (typeof OnlineManager !== 'undefined') {
                const onlineReady = OnlineManager.init();
                if (!onlineReady) console.warn('Online mode is disabled due to configuration.');
            }
            this.loadSettings();
            this.engine.onUpdate = (data) => this.updateGameUI(data);
            this.engine.onRoundEnd = (data) => this.showRoundResult(data);
            this.engine.onGameEnd = (data) => this.showGameEnd(data);
            this.bindEvents();
            this.renderCategoryGrid();
            setTimeout(() => {
                const ls = document.getElementById('loading-screen');
                if (ls) ls.classList.remove('active');
                this.showScreen('screen-title');
            }, 1000);
        } catch (e) {
            console.error('Initialization error:', e);
            this.showError('初期化エラー: ' + e.message);
        }
    }
    showError(message) {
        const loadingScreen = document.getElementById('loading-screen');
        if (!loadingScreen) return;
        loadingScreen.innerHTML =
            `<div class="loading-content">
                <h1 style="color: var(--accent-red); font-size: 1.5rem; margin-bottom: 20px;">エラー</h1>
                <p style="color: var(--card-bg); margin-bottom: 20px;">${message}</p>
                <p style="color: rgba(255,255,255,0.6); font-size: 0.9rem;">コンソール(F12)で詳細を確認</p>
            </div>`;
    }
    /* ========================= イベント ========================= */
    bindEvents() {
        document.querySelectorAll('[data-next]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const nextScreen = e.currentTarget.dataset.next;
                const mode = e.currentTarget.dataset.mode;
                if (mode) this.currentMode = mode;
                if (nextScreen === 'screen-difficulty') this.updateDifficultySelection();
                else if (nextScreen === 'screen-stats') this.updateStats();
                else if (nextScreen === 'screen-reference') this.renderReference();
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
                this.selectedDifficulty = parseInt(e.currentTarget.dataset.level);
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
                if (card && !card.classList.contains('correct')) {
                    this.handleCardTap(card.dataset.id, card);
                }
            });
        }
        const skipBtn = document.getElementById('btn-skip');
        if (skipBtn) {
            skipBtn.addEventListener('click', () => {
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
                this.resetOnlineState();
                this.showScreen('screen-title');
            });
        }
        const hintBtn = document.getElementById('btn-hint');
        if (hintBtn) hintBtn.addEventListener('click', () => this.showHint());
        const nextClueBtn = document.getElementById('btn-next-clue');
        if (nextClueBtn) {
            nextClueBtn.addEventListener('click', () => {
                if (!this.isOnlineMode || this.isHost) this.engine.nextClue();
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
        const voiceToggle = document.getElementById('setting-voice');
        if (voiceToggle) {
            voiceToggle.addEventListener('change', (e) => {
                StorageManager.updateSetting('voiceEnabled', e.target.checked);
                AudioManager.updateSettings({ enabled: e.target.checked });
            });
        }
        const voiceSpeed = document.getElementById('setting-voice-speed');
        if (voiceSpeed) {
            voiceSpeed.addEventListener('change', (e) => {
                StorageManager.updateSetting('voiceSpeed', parseFloat(e.target.value));
                AudioManager.updateSettings({ rate: parseFloat(e.target.value) });
            });
        }
        const cardCount = document.getElementById('setting-card-count');
        if (cardCount) {
            cardCount.addEventListener('change', (e) => {
                StorageManager.updateSetting('cardCount', parseInt(e.target.value));
            });
        }
        const resetBtn = document.getElementById('btn-reset-stats');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (confirm('統計データを初期化しますか？')) {
                    StorageManager.resetAll();
                    alert('初期化しました。');
                }
            });
        }
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
            `<div class="modal-content" style="background: var(--card-bg); border: 3px solid var(--accent-gold); border-radius: 2px; padding: 25px 20px; max-width: 420px; width: 92%; text-align: center;">
                <h2 style="font-size: 1.5rem; margin-bottom: 20px; color: var(--accent-gold); font-family: var(--font-display);">オンライン対戦</h2>
                <div style="margin-bottom: 20px;">
                    <button class="btn btn-primary" id="btn-create-room" style="width: 100%; margin-bottom: 10px; min-height: 48px;">ルーム作成</button>
                    <p style="font-size: 0.8rem; color: var(--text-light);">対戦相手とルームを共有</p>
                </div>
                <div style="margin-bottom: 20px;">
                    <input type="text" id="room-id-input" placeholder="ルームID（6桁）" maxlength="6"
                        style="width: 100%; padding: 10px; border: 2px solid var(--card-border); border-radius: 2px; text-align: center; font-size: 1.2rem; letter-spacing: 0.3em; text-transform: uppercase; min-height: 44px; box-sizing: border-box;">
                    <button class="btn btn-secondary" id="btn-join-room" style="width: 100%; margin-top: 10px; min-height: 48px;">ルーム参加</button>
                </div>
                <button class="btn btn-danger" id="btn-cancel-online" style="width: 100%; min-height: 44px; margin-top: 0;">キャンセル</button>
            </div>`;
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
                cardCount: StorageManager.loadSettings().cardCount || 9,
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
            if (!roomId || roomId.length !== 6) {
                alert('6桁のルームIDを入力してください');
                return;
            }
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
    showWaitingRoom(roomId) {
        const existing = document.getElementById('waiting-room-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.id = 'waiting-room-modal';
        modal.innerHTML =
            `<div class="modal-content" style="background: var(--card-bg); border: 3px solid var(--accent-gold); border-radius: 2px; padding: 25px 20px; max-width: 420px; width: 92%; text-align: center;">
                <h2 id="waiting-opponent-status" style="font-size: 1.3rem; margin-bottom: 20px; color: var(--text-light); font-family: var(--font-display);">対戦相手を待っています...</h2>
                <div style="background: var(--tatami-light); padding: 20px; border-radius: 2px; border: 2px solid var(--card-border); margin-bottom: 20px;">
                    <div style="font-size: 0.9rem; color: var(--text-light); margin-bottom: 10px;">ルームID</div>
                    <div style="font-size: 2rem; font-weight: 900; color: var(--accent-green); letter-spacing: 0.3em; font-family: var(--font-display);">${roomId}</div>
                </div>
                <p style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 20px;">上記のルームIDを対戦相手に共有してください</p>
                <button class="btn btn-primary" id="btn-start-game" disabled style="width: 100%; margin-bottom: 15px; min-height: 48px; opacity: 0.5;">ゲーム開始</button>
                <div class="loading-spinner" style="margin: 20px auto;"></div>
                <button class="btn btn-danger" id="btn-cancel-waiting" style="width: 100%; min-height: 44px; margin-top: 0;">キャンセル</button>
            </div>`;
        document.body.appendChild(modal);
        document.getElementById('btn-start-game').addEventListener('click', () => {
            OnlineManager.updateGameState({ phase: 'starting' });
        });
        document.getElementById('btn-cancel-waiting').addEventListener('click', async () => {
            if (typeof OnlineManager !== 'undefined') { try { await OnlineManager.leaveRoom(); } catch (e) { } }
            this.resetOnlineState();
        });
    }
    showWaitingRoomForGuest(roomId) {
        const existing = document.getElementById('waiting-room-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.id = 'waiting-room-modal';
        modal.innerHTML =
            `<div class="modal-content" style="background: var(--card-bg); border: 3px solid var(--accent-gold); border-radius: 2px; padding: 25px 20px; max-width: 420px; width: 92%; text-align: center;">
                <h2 style="font-size: 1.3rem; margin-bottom: 20px; color: var(--accent-gold); font-family: var(--font-display);">ホストの開始を待っています...</h2>
                <div style="background: var(--tatami-light); padding: 20px; border-radius: 2px; border: 2px solid var(--card-border); margin-bottom: 20px;">
                    <div style="font-size: 0.9rem; color: var(--text-light); margin-bottom: 10px;">ルームID</div>
                    <div style="font-size: 2rem; font-weight: 900; color: var(--accent-green); letter-spacing: 0.3em; font-family: var(--font-display);">${roomId}</div>
                </div>
                <p style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 20px;">ホストがゲームを開始するまでお待ちください</p>
                <div class="loading-spinner" style="margin: 20px auto;"></div>
                <button class="btn btn-danger" id="btn-cancel-waiting" style="width: 100%; min-height: 44px; margin-top: 0;">キャンセル</button>
            </div>`;
        document.body.appendChild(modal);
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
        this.engine.configure({
            mode: 'online',
            isOnline: true,
            isHost: true,
            cpuLevel: 0,
            cardCount: settings.cardCount || 9,
            categories: settings.categories || []
        });
        this.engine.onOnlineStateChange = (state) => this.handleOnlineStateChange(state);
        this.setupOnlineSync();
        this.showScreen('screen-game');
        this.engine.startGame(10);
        this.startOnlineWatchdog();   // ★ v3
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
        this.engine.configure({
            mode: 'online',
            isOnline: true,
            isHost: false,
            cpuLevel: 0,
            cardCount: settings.cardCount || 9,
            categories: settings.categories || []
        });
        this.setupOnlineSync();
        if (roomData && roomData.gameState) this.syncOnlineGameState(roomData.gameState, roomData);
        this.showScreen('screen-game');
        this.startOnlineWatchdog();   // ★ v3
    }
    resetRoundUIState() {
        this.syncSeq++;                 // ★ v3: 実行中の同期を無効化
        this.hasShownResult = false;
        this.onlineGameState = null;
        this.onlineRound = -1;
        this.renderedRound = -1;
        this.processedTaps = {};
        this.tapSeq = 0;
        this.gameEndShown = false;
        this.leftHandled = false;
        this.historyTargetId = null;
        this.closeRoundResultModal();
    }
    resetOnlineState() {
        this.engine.pause();
        this.stopOnlineWatchdog();      // ★ v3
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
                    await OnlineManager.updateScores(state.scores || { player: 0, opponent: 0 });
                    break;
                case 'stage_update':
                    await OnlineManager.updateStage(state.currentStage, state.round);
                    break;
                case 'round_end':
                    await OnlineManager.finishRound(
                        state.playerWon ? 'player' : 'opponent',
                        state.round || this.engine.roundNumber,
                        state.scores || this.engine.scores
                    );
                    break;
                case 'game_end':
                    await OnlineManager.finishGame(state.scores || this.engine.scores);
                    break;
            }
        } catch (e) {
            console.error('handleOnlineStateChange error:', e);
        }
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
        alert(message || '対戦相手が退出しました');
    }
    /* ========================= ★ v3: オンライン常時ウォッチドッグ ========================= */
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
                if (!r || !r.isActive) return;
                const myRound = this.engine.roundNumber;
                const myStage = Number(r.currentStage) || 0;
                // DB が前ラウンドのまま → ラウンドデータを書き戻す（ステージは維持）
                if (dbRound !== myRound) {
                    console.warn('[watchdog] db round', dbRound, '!= engine round', myRound, '-> resend round data');
                    await OnlineManager.setRoundData(r.cards, r.target, myRound, this.engine.totalRounds, myStage);
                    return;
                }
                // 読み上げたのに phase が result/dealing のまま → 復旧
                if (myStage > 0 && gs.phase !== 'reading' && gs.phase !== 'finished') {
                    console.warn('[watchdog] phase stuck at', gs.phase, '-> repair to reading stage', myStage);
                    await OnlineManager.updateStage(myStage, myRound);
                    return;
                }
                // ローカルの読み上げ自体が止まっていたら点火
                this.engine.ensureReading();
            } else {
                // ゲスト: 表示だけ取り残されている場合の再適用（冪等）
                this.onlineGameState = gs;
                if (gs.phase === 'reading') this.updateOnlineClue(gs);
            }
        } catch (e) {
            console.error('onlineWatchdogTick error:', e);
        }
    }
    /* ===================================================================== */
    async syncOnlineGameState(gameState, roomData) {
        if (!gameState) return;
        const mySeq = ++this.syncSeq;   // ★ v3: 同期シーケンス
        this.onlineGameState = gameState;
        const round = Number(gameState.round) || 0;
        const phase = gameState.phase || 'waiting';
        const roundChanged = (round !== this.onlineRound);

        /* 新ラウンド検出：結果表示フラグを確実にリセット */
        if (roundChanged) {
            this.onlineRound = round;
            this.hasShownResult = false;
            this.renderedRound = -1;
            this.processedTaps = {};
            this.historyTargetId = null;
            this.closeRoundResultModal();
        }
        // スコア表示（ホスト＝player / ゲスト＝opponent）
        const scores = gameState.scores || {};
        const myScore = this.isHost ? this.num(scores.player) : this.num(scores.opponent);
        const oppScore = this.isHost ? this.num(scores.opponent) : this.num(scores.player);
        this.setText('score-player', myScore);
        this.setText('score-cpu', oppScore);
        const total = this.num(gameState.totalRounds) || this.engine.totalRounds || 10;
        this.setText('round-display', `${round} / ${total}`);

        // カード描画（ゲスト側・ラウンドごとに1回だけ／表示をブロックしない）
        const cards = gameState.cards;
        if (!this.isHost && Array.isArray(cards) && cards.length > 0 && this.renderedRound !== round) {
            this.renderedRound = round;
            this.resetClueDisplay();
            this.renderOnlineCards(cards).catch(() => { });   // ★ v3: await しない
        }

        // ★ v3: dealing での表示クリアは「ラウンドが変わったとき」だけ
        //   （古い dealing スナップショットが読み札を消す事故の防止）
        if (phase === 'reading') {
            this.updateOnlineClue(gameState);
        } else if (phase === 'dealing' && roundChanged && !this.isHost) {
            this.resetClueDisplay();
        }

        // 結果表示（resultRound が現在のラウンドと一致するときだけ）
        if (phase === 'result' && !this.hasShownResult) {
            const resultRound = (gameState.resultRound === undefined || gameState.resultRound === null)
                ? round : Number(gameState.resultRound);
            if (resultRound === round) {
                if (this.isHost) {
                    /* ★ v3: 自分のエンジンが別のラウンドを進めているのに
                       前ラウンドの result が届いた場合は「終了処理をしない」
                       ＝旧版はここで currentRound を殺し、以後 startReading が
                       永久に no-op になって 2 問目以降が進行不能だった */
                    if (resultRound !== this.engine.roundNumber && this.engine.currentRound.isActive) {
                        console.warn('[sync] stale result for round', resultRound, '-> repair db');
                        const r = this.engine.currentRound;
                        OnlineManager.setRoundData(r.cards, r.target, this.engine.roundNumber,
                            this.engine.totalRounds, Number(r.currentStage) || 0);
                        return;
                    }
                    this.hasShownResult = true;
                    if (this.engine.currentRound.isActive) {
                        this.engine.forceRoundEndLocal(resultRound);
                    }
                } else {
                    this.hasShownResult = true;
                }
                if (mySeq !== this.syncSeq) return; // さらに新しい同期が入った
                const target = gameState.target;
                if (target) {
                    const clueData = this.engine.clues[String(target.id || '').trim()];
                    const explanation = (clueData && clueData.explanation) ? clueData.explanation : '解説データなし';
                    const winner = gameState.roundWinner;
                    this.showRoundResult({
                        playerWon: this.isHost ? (winner === 'player') : (winner === 'opponent'),
                        target: target,
                        explanation: explanation
                    });
                }
            }
        }
        if (phase === 'finished' && !this.gameEndShown) {
            this.gameEndShown = true;
            const s = gameState.scores || {};
            const hostScore = this.num(s.player);
            const guestScore = this.num(s.opponent);
            const mine = this.isHost ? hostScore : guestScore;
            const other = this.isHost ? guestScore : hostScore;
            this.showGameEnd({
                playerScore: mine,
                cpuScore: other,
                maxCombo: this.engine.maxCombo,
                winner: mine > other ? 'player' : (mine < other ? 'cpu' : 'draw')
            });
        }
    }
    num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
    resetClueDisplay() {
        const historyEl = document.getElementById('clue-history');
        if (historyEl) historyEl.innerHTML = '';
        const stageEl = document.getElementById('clue-stage');
        if (stageEl) stageEl.textContent = 'STAGE 1';
        const textEl = document.getElementById('clue-text');
        if (textEl) textEl.textContent = '読み札が始まります';
        this.historyTargetId = null;
        const cluePanel = document.querySelector('.clue-display');
        if (cluePanel) cluePanel.scrollTop = 0;
    }
    async renderOnlineCards(cards) {
        const grid = document.getElementById('card-grid');
        if (!grid) return;
        const renderRound = this.renderedRound;
        grid.innerHTML = '';
        const cardElements = [];
        (cards || []).forEach(c => {
            if (!c) return;
            const div = document.createElement('div');
            div.className = 'card';
            div.dataset.id = String(c.id || '').trim();
            const contentDiv = document.createElement('div');
            contentDiv.className = 'card-content';
            div.appendChild(contentDiv);
            grid.appendChild(div);
            cardElements.push({ element: contentDiv, compound: c });
        });
        const promises = cardElements.map(({ element, compound }, index) => {
            return new Promise((resolve) => {
                setTimeout(() => {
                    try {
                        StructureRenderer.render(element, compound.smiles, 'light', {
                            name: compound.name,
                            name_en: compound.name_en,
                            formula: compound.formula
                        }).then(resolve).catch(resolve);
                    } catch (e) { resolve(); }
                }, index * 50);
            });
        });
        // ★ v3: タイムアウトを 15s → 6s に短縮（描画ハング時の影響を最小化）
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 6000));
        await Promise.race([Promise.all(promises), timeoutPromise]);
        return renderRound;
    }
    updateOnlineClue(gameState) {
        const stage = Number(gameState.currentStage) || 0;
        const stageEl = document.getElementById('clue-stage');
        const textEl = document.getElementById('clue-text');
        if (stageEl) stageEl.textContent = `STAGE ${Math.max(1, stage)}`;
        if (gameState.target) {
            const clueData = this.engine.clues[String(gameState.target.id || '').trim()];
            if (clueData) {
                const stageData = clueData.stages.find(s => s.stage === stage);
                if (textEl && stageData) textEl.textContent = stageData.text;
            }
        }
        this.updateClueWithHistory({ target: gameState.target, currentStage: stage });
    }
    /* ========================= タップ処理 ========================= */
    handleCardTap(id, element) {
        if (this.isOnlineMode) {
            this.handleOnlineCardTap(id, element);
            return;
        }
        if (this.hasShownResult) return;
        this.engine.handlePlayerTap(id);
        const target = this.engine.currentRound.target;
        const targetId = String(target ? target.id : '').trim();
        if (String(id || '').trim() === targetId && element) element.classList.add('correct');
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
            try { await OnlineManager.recordTap(tapId, meta); } catch (e) { }
            return;
        }
        // ゲスト
        if (isCorrect) {
            if (element) element.classList.add('correct');
            this.hasShownResult = true;
            try { AudioManager.playSound('correct'); } catch (e) { }
            const clueData = this.engine.clues[targetId];
            const explanation = (clueData && clueData.explanation) ? clueData.explanation : '解説データなし';
            this.showRoundResult({ playerWon: true, target: gs.target, explanation: explanation });
            try {
                await OnlineManager.updateGameState({
                    phase: 'result',
                    roundWinner: 'opponent',
                    resultRound: round
                });
            } catch (e) { console.error(e); }
        } else {
            if (element) {
                element.classList.add('wrong');
                setTimeout(() => element.classList.remove('wrong'), 600);
            }
            try { AudioManager.playSound('wrong'); } catch (e) { }
        }
        try { await OnlineManager.recordTap(tapId, meta); } catch (e) { }
    }
    handleRemoteTaps(taps) {
        if (!this.isOnlineMode || !taps) return;
        if (!this.isHost) {
            Object.keys(taps).forEach(pid => {
                const tap = taps[pid];
                if (!tap || !tap.cardId) return;
                const key = `${tap.round || 0}_${tap.seq || tap.timestamp || 0}_${tap.cardId}`;
                if (this.processedTaps[pid] === key) return;
                this.processedTaps[pid] = key;
                const gs = this.onlineGameState;
                if (gs && tap.round && Number(tap.round) !== Number(gs.round || 0)) return;
                const tapId = String(tap.cardId).trim();
                const cardEl = this.findCardElement(tapId);
                if (!cardEl) return;
                const targetId = gs && gs.target ? String(gs.target.id || '').trim() : '';
                if (tapId === targetId) {
                    cardEl.classList.add('correct');
                } else {
                    cardEl.classList.add('wrong');
                    setTimeout(() => cardEl.classList.remove('wrong'), 600);
                }
            });
            return;
        }
        const round = this.engine.currentRound;
        if (!round || !round.isActive || !round.target) return;
        const targetId = String(round.target.id || '').trim();
        const currentRoundNo = this.engine.roundNumber;
        Object.keys(taps).forEach(pid => {
            const tap = taps[pid];
            if (!tap || !tap.cardId) return;
            const tapRound = Number(tap.round) || 0;
            if (tapRound && tapRound !== currentRoundNo) return;
            const key = `${tapRound}_${tap.seq || tap.timestamp || 0}_${tap.cardId}`;
            if (this.processedTaps[pid] === key) return;
            this.processedTaps[pid] = key;
            const tapId = String(tap.cardId).trim();
            const cardEl = this.findCardElement(tapId);
            const isCorrect = (tapId === targetId);
            if (isCorrect) {
                if (cardEl) cardEl.classList.add('correct');
                if (!this.engine.currentRound.isActive) return;
                const stage = Number(tap.stage) || this.engine.currentRound.currentStage || 1;
                this.engine.scoreOpponentCorrect(stage);
                this.engine._finishRound(false);
            } else {
                if (cardEl) {
                    cardEl.classList.add('wrong');
                    setTimeout(() => cardEl.classList.remove('wrong'), 600);
                }
            }
        });
    }
    findCardElement(id) {
        const grid = document.getElementById('card-grid');
        if (!grid) return null;
        const safeId = (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id);
        try { return grid.querySelector(`.card[data-id="${safeId}"]`); }
        catch (e) {
            return Array.from(grid.querySelectorAll('.card')).find(c => c.dataset.id === String(id)) || null;
        }
    }
    flashCard(id, type) {
        const card = this.findCardElement(id);
        if (card) {
            card.classList.add(type);
            setTimeout(() => card.classList.remove(type), 600);
        }
    }
    /* ========================= ゲームUI ========================= */
    async updateGameUI(data) {
        if (!data) return;
        const scores = data.scores || { player: 0, opponent: 0 };
        this.setText('score-player', scores.player || 0);
        this.setText('score-cpu', scores.opponent || 0);
        this.setText('round-display', `${data.roundNumber} / ${data.totalRounds}`);
        switch (data.state) {
            case 'DEAL':
                this.hasShownResult = false;
                this.historyTargetId = null;
                this.closeRoundResultModal();
                if (this.isOnlineMode) {
                    this.onlineRound = data.roundNumber;
                    this.renderedRound = data.roundNumber;
                    this.processedTaps = {};
                    if (this.isHost) {
                        this.resetClueDisplay();
                        /* ★ v3 最重要修正:
                           旧版は「await renderOnlineCards() の完了後」に
                           startReading() を呼んでいた。描画が 1 枚でもハングすると
                           15 秒待たされ、その間に届いた前ラウンドの result で
                           state が RESULT に変わると startReading が永久に no-op →
                           2 問目以降、読み札が一切始まらなくなっていた。
                           → 読み上げタイマーを先に起動し、描画は並行実行にする。 */
                        this.engine.startReading(true);
                        this.renderOnlineCards(data.round.cards).catch(() => { });
                    }
                } else {
                    this.resetClueDisplay();
                    await this.renderCards(data.round.cards);
                }
                break;
            case 'READING':
                this.updateClueWithHistory(data.round);
                break;
            case 'RESULT':
                break;
        }
        if (data.type === 'wrong' || data.type === 'cpu_wrong') this.flashCard(data.id, 'wrong');
    }
    async renderCards(cards) {
        const grid = document.getElementById('card-grid');
        if (!grid) return;
        grid.innerHTML = '';
        const cardElements = [];
        (cards || []).forEach(c => {
            if (!c) return;
            const div = document.createElement('div');
            div.className = 'card';
            div.dataset.id = String(c.id || '').trim();
            const contentDiv = document.createElement('div');
            contentDiv.className = 'card-content';
            div.appendChild(contentDiv);
            grid.appendChild(div);
            cardElements.push({ element: contentDiv, compound: c });
        });
        const promises = cardElements.map(({ element, compound }, index) => {
            return new Promise((resolve) => {
                setTimeout(() => {
                    try {
                        StructureRenderer.render(element, compound.smiles, 'light', {
                            name: compound.name,
                            name_en: compound.name_en,
                            formula: compound.formula
                        }).then(resolve).catch(resolve);
                    } catch (e) { resolve(); }
                }, index * 50);
            });
        });
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 6000));
        await Promise.race([Promise.all(promises), timeoutPromise]);
        this.engine.startReading(true);
    }
    /** 読み札履歴（STAGE 1〜current-1 を冪等に再構築） */
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
        if (stageEl) stageEl.textContent = `STAGE ${currentStage}`;
        if (textEl) textEl.textContent = currentStageData.text;
        const historyDiv = document.getElementById('clue-history');
        if (!historyDiv) return;
        if (this.historyTargetId !== targetId) {
            historyDiv.innerHTML = '';
            this.historyTargetId = targetId;
        }
        const existing = new Set();
        historyDiv.querySelectorAll('.clue-history-item').forEach(item => {
            existing.add(String(item.dataset.stage));
        });
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
            label.textContent = `STAGE ${s}`;
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
    closeRoundResultModal() {
        if (this.roundResultModal) {
            try { this.roundResultModal.remove(); } catch (e) { }
            this.roundResultModal = null;
        }
        const legacy = document.getElementById('round-result-modal');
        if (legacy) legacy.remove();
    }
    showRoundResult(data) {
        if (!data) return;
        if (this.roundResultModal) return;
        this.hasShownResult = true;
        const playerWon = !!data.playerWon;
        const compound = data.target || {};
        const explanation = data.explanation || '解説はありません。';
        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.id = 'round-result-modal';
        const resultTitle = this.isPracticeMode
            ? (playerWon ? '正解' : '確認')
            : (playerWon ? '正解' : '不正解');
        const resultColor = playerWon ? '#22c55e' : 'var(--accent-red)';
        modal.innerHTML =
            `<div class="modal-content" style="background: var(--card-bg); border: 3px solid ${resultColor}; border-radius: 2px; padding: 25px 20px; max-width: 420px; width: 92%; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5);">
                <h2 style="font-size: 1.8rem; margin-bottom: 15px; color: ${resultColor}; font-family: var(--font-display); letter-spacing: 0.15em;">${resultTitle}</h2>
                <div style="background: var(--tatami-light); border-radius: 2px; padding: 15px; margin-bottom: 15px; min-height: 130px; border: 2px solid var(--card-border);">
                    <div id="modal-structure" style="width: 100%; height: 100%;"></div>
                </div>
                <div style="font-size: 1.2rem; margin-bottom: 6px; color: var(--text-dark); font-family: var(--font-display); font-weight: 700; letter-spacing: 0.1em;"></div>
                <div class="modal-formula" style="font-size: 0.9rem; color: var(--text-light); margin-bottom: 15px;"></div>
                <div style="font-size: 0.85rem; color: var(--text-dark); line-height: 1.7; margin-bottom: 20px; text-align: left; background: var(--tatami-light); padding: 12px 14px; border-radius: 2px; border-left: 4px solid var(--accent-gold); font-family: var(--font-main);">
                    <div style="font-size: 0.75rem; font-weight: 700; color: var(--accent-green); letter-spacing: 0.1em; margin-bottom: 4px; font-family: var(--font-display);">解説</div>
                    <div class="modal-explanation"></div>
                </div>
                <button class="btn btn-primary" id="modal-next-btn" style="width: 100%; font-family: var(--font-display);">次の問題へ</button>
            </div>`;
        document.body.appendChild(modal);
        this.roundResultModal = modal;
        const nameEl = modal.querySelector('.modal-content > div:nth-child(3)');
        if (nameEl) nameEl.textContent = compound.name || '';
        const formulaEl = modal.querySelector('.modal-formula');
        if (formulaEl) formulaEl.textContent = compound.formula || '';
        const expEl = modal.querySelector('.modal-explanation');
        if (expEl) expEl.textContent = explanation;
        const structureDiv = document.getElementById('modal-structure');
        if (structureDiv && compound.smiles) {
            StructureRenderer.render(structureDiv, compound.smiles, 'light', {
                name: compound.name,
                name_en: compound.name_en,
                formula: compound.formula
            }).catch(() => { });
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
                    this.engine.startNewRound();
                });
            }
        }
    }
    showGameEnd(data) {
        if (!data) return;
        if (this.gameEndShown && this.isOnlineMode) return;
        this.gameEndShown = true;
        this.stopOnlineWatchdog();   // ★ v3
        if (!this.isPracticeMode && data.winner) {
            try { StorageManager.recordCpuResult(data.winner); } catch (e) { }
        }
        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.id = 'game-end-modal';
        if (this.isPracticeMode) {
            modal.innerHTML =
                `<div class="modal-content" style="background: var(--card-bg); border: 3px solid var(--accent-gold); border-radius: 2px; padding: 25px 20px; max-width: 420px; width: 92%; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5);">
                    <h2 style="font-size: 1.8rem; margin-bottom: 15px; color: var(--accent-gold); font-family: var(--font-display); letter-spacing: 0.2em;">練習終了</h2>
                    <div style="background: var(--tatami-light); padding: 20px; border-radius: 2px; border: 2px solid var(--card-border); margin-bottom: 25px;">
                        <div style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 8px; letter-spacing: 0.1em; font-family: var(--font-display);">TOTAL SCORE</div>
                        <div style="font-size: 2.5rem; color: var(--accent-green); font-family: var(--font-display); font-weight: 900;">${data.playerScore || 0}</div>
                    </div>
                    <button class="btn btn-primary" id="modal-finish-btn" style="width: 100%; font-family: var(--font-display);">タイトルへ戻る</button>
                </div>`;
        } else {
            const playerLabel = this.isOnlineMode ? 'あなた' : 'PLAYER';
            const opponentLabel = this.isOnlineMode ? '相手' : 'CPU';
            const message = data.winner === 'player' ? '勝利' : (data.winner === 'cpu' ? '敗北' : '引き分け');
            modal.innerHTML =
                `<div class="modal-content" style="background: var(--card-bg); border: 3px solid var(--accent-gold); border-radius: 2px; padding: 25px 20px; max-width: 420px; width: 92%; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5);">
                    <h2 style="font-size: 1.8rem; margin-bottom: 15px; color: var(--accent-gold); font-family: var(--font-display); letter-spacing: 0.2em;">ゲーム終了</h2>
                    <div style="font-size: 1.4rem; margin-bottom: 20px; color: var(--text-dark); font-family: var(--font-display); font-weight: 700; letter-spacing: 0.1em;">${message}</div>
                    <div style="display: flex; justify-content: space-around; margin-bottom: 25px; gap: 15px;">
                        <div style="text-align: center; flex: 1; background: var(--tatami-light); padding: 12px 8px; border-radius: 2px; border: 2px solid var(--card-border);">
                            <div style="font-size: 0.8rem; color: var(--text-light); margin-bottom: 5px; letter-spacing: 0.1em; font-family: var(--font-display);">${playerLabel}</div>
                            <div style="font-size: 1.8rem; color: var(--accent-green); font-family: var(--font-display); font-weight: 900;">${data.playerScore || 0}</div>
                        </div>
                        <div style="text-align: center; flex: 1; background: var(--tatami-light); padding: 12px 8px; border-radius: 2px; border: 2px solid var(--card-border);">
                            <div style="font-size: 0.8rem; color: var(--text-light); margin-bottom: 5px; letter-spacing: 0.1em; font-family: var(--font-display);">${opponentLabel}</div>
                            <div style="font-size: 1.8rem; color: var(--accent-red); font-family: var(--font-display); font-weight: 900;">${data.cpuScore || 0}</div>
                        </div>
                    </div>
                    <button class="btn btn-primary" id="modal-finish-btn" style="width: 100%; font-family: var(--font-display);">タイトルへ戻る</button>
                </div>`;
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
    }
    updateDifficultySelection() {
        document.querySelectorAll('.diff-btn').forEach(btn => {
            btn.classList.remove('selected');
            if (parseInt(btn.dataset.level) === this.selectedDifficulty) btn.classList.add('selected');
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
        this.stopOnlineWatchdog();   // ★ v3
        this.closeRoundResultModal();
        const settings = {
            mode: this.isPracticeMode ? 'practice' : 'cpu',
            isOnline: false,
            isHost: false,
            cpuLevel: this.isPracticeMode ? 0 : this.selectedDifficulty,
            cardCount: StorageManager.loadSettings().cardCount || 9,
            categories: this.selectedCategories.length > 0 ? this.selectedCategories : []
        };
        this.engine.configure(settings);
        this.engine.onOnlineStateChange = null;
        const gameScreen = document.getElementById('screen-game');
        if (gameScreen) {
            if (this.isPracticeMode) gameScreen.classList.add('practice-mode');
            else gameScreen.classList.remove('practice-mode');
        }
        this.setText('player-score-label', '得点');
        this.setText('cpu-score-label', this.isPracticeMode ? '' : 'CPU');
        this.showScreen('screen-game');
        this.engine.startGame(10);
    }
    showHint() {
        let target = this.engine.currentRound ? this.engine.currentRound.target : null;
        if (!target && this.onlineGameState) target = this.onlineGameState.target;
        if (!target) return;
        const categoryName = this.getCategoryDisplayName(target.category);
        alert(`ヒント: ${categoryName} / 分子式: ${target.formula}`);
    }
    /* ========================= 統計 ========================= */
    updateStats() {
        const stats = StorageManager.getSummary();
        this.setText('stat-games', stats.totalGames);
        this.setText('stat-accuracy', stats.accuracy + '%');
        this.setText('stat-max-combo', stats.maxCombo);
        this.setText('profile-total-score', stats.totalScore + ' pt');
        this.updateRank(stats.totalScore);
        this.setText('stat-cpu-wins', stats.cpuWins);
        this.setText('stat-cpu-losses', stats.cpuLosses);
        this.setText('stat-cpu-draws', stats.cpuDraws);
        this.setText('stat-cpu-winrate', stats.cpuWinRate + '%');
        this.renderBarGraph('category-bars', stats.byCategory, (cat) => this.getCategoryDisplayName(cat));
        const diffNames = { 0: '練習', 1: '易しい', 3: '普通', 7: '難しい' };
        this.renderBarGraph('difficulty-bars', stats.byDifficulty, (d) => diffNames[d] || `Lv.${d}`);
        this.renderBarGraph('stage-bars', stats.byStage, (s) => `STAGE ${s}`);
        this.renderHistory(stats.history);
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
            return { key, rate, total };
        }).sort((a, b) => a.rate - b.rate);
        entries.forEach(item => {
            const row = document.createElement('div');
            row.className = 'bar-item';
            const isLow = item.rate < 50;
            const label = labelFunc(item.key);
            row.innerHTML =
                `<div class="bar-label" title="${label}">${label}</div>
                 <div class="bar-track"><div class="bar-fill ${isLow ? 'low' : ''}" style="width: ${item.rate}%"></div></div>
                 <div class="bar-value">${item.rate}%</div>`;
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
            const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
            let compoundName = h.compoundId;
            const compound = this.engine.compounds.find(c => String(c.id || '').trim() === h.compoundId);
            if (compound) compoundName = compound.name;
            const item = document.createElement('div');
            item.className = `history-item ${h.result}`;
            item.innerHTML =
                `<div class="history-date">${dateStr}</div>
                 <div class="history-name">${compoundName}</div>
                 <div class="history-result">${h.result === 'correct' ? '正解' : '不正解'}</div>`;
            container.appendChild(item);
        });
    }
    updateRank(score) {
        const rankEl = document.getElementById('profile-rank');
        if (!rankEl) return;
        let rank = '初心者';
        if (score >= 10000) rank = '名人';
        else if (score >= 5000) rank = '達人';
        else if (score >= 2000) rank = '上級者';
        else if (score >= 1000) rank = '中級者';
        else if (score >= 500) rank = '初級者';
        rankEl.textContent = `段位: ${rank}`;
    }
    setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }
    /* ========================= 資料 ========================= */
    renderReference() {
        const tabsContainer = document.getElementById('reference-tabs');
        const listContainer = document.getElementById('reference-list');
        if (!tabsContainer || !listContainer) return;
        const categories = this.engine.getCategories();
        tabsContainer.innerHTML = '';
        const allTab = document.createElement('button');
        allTab.className = 'reference-tab' + (this.referenceCurrentCategory === 'all' ? ' selected' : '');
        allTab.textContent = 'すべて';
        allTab.dataset.category = 'all';
        allTab.addEventListener('click', () => {
            this.referenceCurrentCategory = 'all';
            this.renderReference();
        });
        tabsContainer.appendChild(allTab);
        categories.forEach(cat => {
            const tab = document.createElement('button');
            tab.className = 'reference-tab' + (this.referenceCurrentCategory === cat ? ' selected' : '');
            tab.textContent = this.getCategoryDisplayName(cat);
            tab.dataset.category = cat;
            tab.addEventListener('click', () => {
                this.referenceCurrentCategory = cat;
                this.renderReference();
            });
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
        Object.keys(grouped).sort().forEach(cat => {
            const section = document.createElement('div');
            section.className = 'reference-category-section';
            const header = document.createElement('div');
            header.className = 'reference-category-header';
            header.textContent = `${this.getCategoryDisplayName(cat)}（${grouped[cat].length}）`;
            section.appendChild(header);
            const grid = document.createElement('div');
            grid.className = 'reference-grid';
            grouped[cat].forEach(compound => {
                const item = document.createElement('div');
                item.className = 'reference-item';
                item.dataset.id = String(compound.id || '').trim();
                item.innerHTML =
                    `<div class="reference-item-structure" data-smiles="${compound.smiles || ''}"></div>
                     <div class="reference-item-name">${compound.name || ''}</div>
                     <div class="reference-item-formula">${compound.formula || ''}</div>`;
                item.addEventListener('click', () => this.showReferenceDetail(compound));
                grid.appendChild(item);
            });
            section.appendChild(grid);
            listContainer.appendChild(section);
        });
        requestAnimationFrame(() => {
            const structures = listContainer.querySelectorAll('.reference-item-structure');
            structures.forEach((el, index) => {
                const smiles = el.dataset.smiles;
                if (smiles) {
                    setTimeout(() => {
                        StructureRenderer.render(el, smiles, 'light', {}).catch(() => { });
                    }, index * 30);
                }
            });
        });
    }
    showReferenceDetail(compound) {
        const modal = document.getElementById('reference-detail-modal');
        if (!modal) return;
        const compoundId = String(compound.id || '').trim();
        const clueData = this.engine.clues[compoundId];
        this.setText('detail-name', compound.name || '');
        this.setText('detail-formula', compound.formula || '');
        const structureDiv = document.getElementById('detail-structure');
        if (structureDiv) {
            structureDiv.innerHTML = '';
            if (compound.smiles) {
                StructureRenderer.render(structureDiv, compound.smiles, 'light', {
                    name: compound.name,
                    name_en: compound.name_en,
                    formula: compound.formula
                }).catch(() => { });
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
                    num.textContent = `STEP ${stage.stage}`;
                    item.appendChild(num);
                    item.appendChild(document.createTextNode(stage.text));
                    stagesDiv.appendChild(item);
                });
                const playBtn = document.createElement('button');
                playBtn.className = 'btn btn-primary';
                playBtn.style.cssText = 'width: 100%; margin-top: 12px; font-size: 0.9rem; padding: 10px;';
                playBtn.textContent = '読み上げる';
                playBtn.addEventListener('click', () => this.playAllStages(clueData.stages));
                stagesDiv.appendChild(playBtn);
            } else {
                stagesDiv.innerHTML = '<div style="color: var(--text-light); font-size: 0.85rem; padding: 10px;">読み札データがありません</div>';
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
                content.textContent = clueData.explanation;
                explanationDiv.appendChild(content);
            } else {
                explanationDiv.innerHTML = '<div style="color: var(--text-light); font-size: 0.85rem;">解説データがありません</div>';
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
                onEnd: () => {
                    index++;
                    if (index < stages.length) setTimeout(playNext, 500);
                }
            });
        };
        playNext();
    }
    /* ========================= 画面切替・設定 ========================= */
    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(s => {
            if (!s.classList.contains('modal-screen')) s.classList.remove('active');
        });
        const target = document.getElementById(screenId);
        if (target) {
            target.classList.add('active');
            const scrollables = target.querySelectorAll('.clue-display, .card-field, .settings-container, .stats-container, .difficulty-container, .title-container, .reference-list');
            scrollables.forEach(el => { el.scrollTop = 0; });
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
        const settings = StorageManager.loadSettings();
        if (!settings) return;
        const voiceToggle = document.getElementById('setting-voice');
        const voiceSpeed = document.getElementById('setting-voice-speed');
        const cardCount = document.getElementById('setting-card-count');
        if (voiceToggle) voiceToggle.checked = settings.voiceEnabled;
        if (voiceSpeed) voiceSpeed.value = settings.voiceSpeed;
        if (cardCount) cardCount.value = settings.cardCount;
        AudioManager.updateSettings({ enabled: settings.voiceEnabled, rate: settings.voiceSpeed });
    }
}
window.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, starting app...');
    window.app = new App();
});