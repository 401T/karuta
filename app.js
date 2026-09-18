/**
 * App - メインアプリケーションクラス（完全修正版）
 * 
 * 修正内容：
 * 1. オンラインモードでもホストはUI更新を行う
 * 2. オンラインモードでホストのみ読み札開始・次のラウンド開始
 * 3. オンラインモードでゲストはFirebaseからカード・状態を同期
 * 4. CPU戦・オンライン戦ともに正解/誤答後に確実に進行
 */
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
        this.hasShownResult = false;
        
        this.init();
    }

    async init() {
        console.log('App initializing...');
        
        try {
            const loaded = await this.engine.loadData();
            if (!loaded) {
                this.showError('データ読み込み失敗');
                return;
            }

            console.log('Data loaded successfully');
            
            StructureRenderer.init();
            AudioManager.init();
            StorageManager.init();
            
            if (typeof OnlineManager !== 'undefined') {
                const onlineReady = OnlineManager.init();
                if (!onlineReady) {
                    console.warn('Online mode is disabled due to configuration.');
                }
            }
            
            this.loadSettings();

            this.engine.onUpdate = (data) => this.updateGameUI(data);
            this.engine.onRoundEnd = (data) => this.showRoundResult(data);
            this.engine.onGameEnd = (data) => this.showGameEnd(data);

            this.bindEvents();
            this.renderCategoryGrid();
            
            setTimeout(() => {
                document.getElementById('loading-screen').classList.remove('active');
                this.showScreen('screen-title');
            }, 1000);
            
        } catch (e) {
            console.error('Initialization error:', e);
            this.showError('初期化エラー: ' + e.message);
        }
    }

    showError(message) {
        const loadingScreen = document.getElementById('loading-screen');
        loadingScreen.innerHTML = `
            <div class="loading-content">
                <h1 style="color: var(--accent-red); font-size: 1.5rem; margin-bottom: 20px;">エラー</h1>
                <p style="color: var(--card-bg); margin-bottom: 20px;">${message}</p>
                <p style="color: rgba(255,255,255,0.6); font-size: 0.9rem;">コンソール(F12)で詳細を確認</p>
            </div>
        `;
    }

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
            btn.addEventListener('click', (e) => {
                this.showScreen(e.currentTarget.dataset.back);
            });
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
                if (card && !card.classList.contains('taken')) {
                    this.handleCardTap(card.dataset.id, card);
                }
            });
        }

        const skipBtn = document.getElementById('btn-skip');
        if (skipBtn) {
            skipBtn.addEventListener('click', () => {
                if (!this.isOnlineMode || this.isHost) {
                    this.engine.skipRound();
                }
            });
        }

        const pauseBtn = document.getElementById('btn-pause');
        if (pauseBtn) {
            pauseBtn.addEventListener('click', () => {
                if (this.isOnlineMode) {
                    if (typeof OnlineManager !== 'undefined') {
                        OnlineManager.leaveRoom();
                    }
                    this.isOnlineMode = false;
                }
                this.engine.pause();
                this.showScreen('screen-title');
            });
        }

        const hintBtn = document.getElementById('btn-hint');
        if (hintBtn) hintBtn.addEventListener('click', () => this.showHint());

        const nextClueBtn = document.getElementById('btn-next-clue');
        if (nextClueBtn) {
            nextClueBtn.addEventListener('click', () => {
                if (!this.isOnlineMode || this.isHost) {
                    this.engine.nextClue();
                }
            });
        }

        const modalCloseBtn = document.getElementById('modal-close-btn');
        if (modalCloseBtn) {
            modalCloseBtn.addEventListener('click', () => {
                document.getElementById('reference-detail-modal').classList.remove('active');
            });
        }

        const modalOverlay = document.getElementById('reference-detail-modal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) {
                    modalOverlay.classList.remove('active');
                }
            });
        }

        const onlineBtn = document.getElementById('btn-online');
        if (onlineBtn) {
            onlineBtn.addEventListener('click', () => this.showOnlineMenu());
        }

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

    showOnlineMenu() {
        if (typeof OnlineManager === 'undefined' || !OnlineManager.init()) {
            alert('オンライン機能が利用できません。Firebaseの設定を確認してください。');
            return;
        }

        document.querySelectorAll('.modal-screen').forEach(m => m.remove());

        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.id = 'online-menu-modal';
        modal.innerHTML = `
            <div class="modal-content" style="background: var(--card-bg); border: 3px solid var(--accent-gold); border-radius: 2px; padding: 25px 20px; max-width: 420px; width: 92%; text-align: center;">
                <h2 style="font-size: 1.5rem; margin-bottom: 20px; color: var(--accent-gold); font-family: var(--font-display);">オンライン対戦</h2>
                
                <div style="margin-bottom: 20px;">
                    <button class="btn btn-primary" id="btn-create-room" style="width: 100%; margin-bottom: 10px; min-height: 48px;">ルーム作成</button>
                    <p style="font-size: 0.8rem; color: var(--text-light);">対戦相手とルームを共有</p>
                </div>

                <div style="margin-bottom: 20px;">
                    <input type="text" id="room-id-input" placeholder="ルームID（6桁）" 
                           style="width: 100%; padding: 10px; border: 2px solid var(--card-border); border-radius: 2px; text-align: center; font-size: 1.2rem; letter-spacing: 0.3em; text-transform: uppercase; min-height: 44px; box-sizing: border-box;">
                    <button class="btn btn-secondary" id="btn-join-room" style="width: 100%; margin-top: 10px; min-height: 48px;">ルーム参加</button>
                </div>

                <button class="btn btn-danger" id="btn-cancel-online" style="width: 100%; min-height: 44px;">キャンセル</button>
            </div>
        `;
        document.body.appendChild(modal);

        document.getElementById('btn-create-room').addEventListener('click', () => this.createOnlineRoom());
        document.getElementById('btn-join-room').addEventListener('click', () => this.joinOnlineRoom());
        document.getElementById('btn-cancel-online').addEventListener('click', () => modal.remove());
    }

    async createOnlineRoom() {
        try {
            const settings = {
                mode: 'online',
                cardCount: StorageManager.loadSettings().cardCount || 9,
                categories: this.selectedCategories.length > 0 ? this.selectedCategories : [],
                difficulty: this.selectedDifficulty
            };

            const roomId = await OnlineManager.createRoom(settings);
            this.isHost = true;

            const onlineMenu = document.getElementById('online-menu-modal');
            if (onlineMenu) onlineMenu.remove();

            this.showWaitingRoom(roomId);

            OnlineManager.onRoomUpdate((roomData) => {
                console.log('Room update (host):', roomData);
                if (roomData && roomData.gameState && roomData.gameState.phase === 'starting') {
                    this.startOnlineGameAsHost(roomData);
                }
            });

        } catch (e) {
            console.error('Failed to create room:', e);
            alert('ルーム作成に失敗しました: ' + e.message);
        }
    }

    async joinOnlineRoom() {
        try {
            const roomIdInput = document.getElementById('room-id-input');
            const roomId = roomIdInput.value.trim().toUpperCase();

            if (!roomId || roomId.length !== 6) {
                alert('6桁のルームIDを入力してください');
                return;
            }

            await OnlineManager.joinRoom(roomId);
            this.isHost = false;

            const onlineMenu = document.getElementById('online-menu-modal');
            if (onlineMenu) onlineMenu.remove();

            this.showWaitingRoomForGuest(roomId);

            OnlineManager.onRoomUpdate((roomData) => {
                console.log('Room update (guest):', roomData);
                if (roomData && roomData.gameState && roomData.gameState.phase !== 'waiting' && roomData.gameState.phase !== 'starting') {
                    this.startOnlineGameAsGuest(roomData);
                }
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
        modal.innerHTML = `
            <div class="modal-content" style="background: var(--card-bg); border: 3px solid var(--accent-gold); border-radius: 2px; padding: 25px 20px; max-width: 420px; width: 92%; text-align: center;">
                <h2 style="font-size: 1.5rem; margin-bottom: 20px; color: var(--accent-gold); font-family: var(--font-display);">対戦相手を待っています...</h2>
                
                <div style="background: var(--tatami-light); padding: 20px; border-radius: 2px; border: 2px solid var(--card-border); margin-bottom: 20px;">
                    <div style="font-size: 0.9rem; color: var(--text-light); margin-bottom: 10px;">ルームID</div>
                    <div style="font-size: 2rem; font-weight: 900; color: var(--accent-green); letter-spacing: 0.3em; font-family: var(--font-display);">${roomId}</div>
                </div>

                <p style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 20px;">
                    上記のルームIDを対戦相手に共有してください
                </p>

                <button class="btn btn-primary" id="btn-start-game" style="width: 100%; margin-bottom: 15px; min-height: 48px;">ゲーム開始</button>

                <div class="loading-spinner" style="margin: 20px auto;"></div>

                <button class="btn btn-danger" id="btn-cancel-waiting" style="width: 100%; min-height: 44px;">キャンセル</button>
            </div>
        `;
        document.body.appendChild(modal);

        document.getElementById('btn-start-game').addEventListener('click', () => {
            OnlineManager.updateGameState({ phase: 'starting' }).then(() => {
                this.startOnlineGameAsHost({ settings: { cardCount: 9, categories: [] } });
            });
        });

        document.getElementById('btn-cancel-waiting').addEventListener('click', async () => {
            if (typeof OnlineManager !== 'undefined') {
                await OnlineManager.leaveRoom();
            }
            modal.remove();
            this.isOnlineMode = false;
            this.isHost = false;
        });
    }

    showWaitingRoomForGuest(roomId) {
        const existing = document.getElementById('waiting-room-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.id = 'waiting-room-modal';
        modal.innerHTML = `
            <div class="modal-content" style="background: var(--card-bg); border: 3px solid var(--accent-gold); border-radius: 2px; padding: 25px 20px; max-width: 420px; width: 92%; text-align: center;">
                <h2 style="font-size: 1.5rem; margin-bottom: 20px; color: var(--accent-gold); font-family: var(--font-display);">ホストの開始を待っています...</h2>
                
                <div style="background: var(--tatami-light); padding: 20px; border-radius: 2px; border: 2px solid var(--card-border); margin-bottom: 20px;">
                    <div style="font-size: 0.9rem; color: var(--text-light); margin-bottom: 10px;">ルームID</div>
                    <div style="font-size: 2rem; font-weight: 900; color: var(--accent-green); letter-spacing: 0.3em; font-family: var(--font-display);">${roomId}</div>
                </div>

                <p style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 20px;">
                    ホストがゲームを開始するまでお待ちください
                </p>

                <div class="loading-spinner" style="margin: 20px auto;"></div>

                <button class="btn btn-danger" id="btn-cancel-waiting" style="width: 100%; min-height: 44px;">キャンセル</button>
            </div>
        `;
        document.body.appendChild(modal);

        document.getElementById('btn-cancel-waiting').addEventListener('click', async () => {
            if (typeof OnlineManager !== 'undefined') {
                await OnlineManager.leaveRoom();
            }
            modal.remove();
            this.isOnlineMode = false;
            this.isHost = false;
        });
    }

    startOnlineGameAsHost(roomData) {
        const waitingModal = document.getElementById('waiting-room-modal');
        if (waitingModal) waitingModal.remove();

        this.isOnlineMode = true;
        this.isPracticeMode = false;
        this.hasShownResult = false;

        const gameScreen = document.getElementById('screen-game');
        if (gameScreen) {
            gameScreen.classList.remove('practice-mode');
        }

        const playerLabel = document.getElementById('player-score-label');
        const cpuLabel = document.getElementById('cpu-score-label');
        if (playerLabel) playerLabel.textContent = 'あなた';
        if (cpuLabel) cpuLabel.textContent = '相手';

        const settings = roomData.settings || {};
        const gameSettings = {
            mode: 'online',
            isOnline: true,
            isHost: true,
            cardCount: settings.cardCount || 9,
            categories: settings.categories || []
        };
        this.engine.configure(gameSettings);
        
        this.engine.onOnlineStateChange = (state) => {
            this.handleOnlineStateChange(state);
        };
        
        this.engine.startGame(10);
        this.setupOnlineSync();
        this.showScreen('screen-game');
    }

    startOnlineGameAsGuest(roomData) {
        const waitingModal = document.getElementById('waiting-room-modal');
        if (waitingModal) waitingModal.remove();

        this.isOnlineMode = true;
        this.isPracticeMode = false;
        this.hasShownResult = false;

        const gameScreen = document.getElementById('screen-game');
        if (gameScreen) {
            gameScreen.classList.remove('practice-mode');
        }

        const playerLabel = document.getElementById('player-score-label');
        const cpuLabel = document.getElementById('cpu-score-label');
        if (playerLabel) playerLabel.textContent = 'あなた';
        if (cpuLabel) cpuLabel.textContent = '相手';

        const settings = roomData.settings || {};
        const gameSettings = {
            mode: 'online',
            isOnline: true,
            isHost: false,
            cardCount: settings.cardCount || 9,
            categories: settings.categories || []
        };
        this.engine.configure(gameSettings);

        this.setupOnlineSync();

        if (roomData.gameState) {
            this.syncOnlineGameState(roomData.gameState);
        }

        this.showScreen('screen-game');
    }

    handleOnlineStateChange(state) {
        if (!this.isOnlineMode || !this.isHost) return;
        
        switch (state.type) {
            case 'round_start':
                OnlineManager.setRoundData(state.cards, state.target, state.round);
                OnlineManager.updateScores(state.scores);
                break;
            case 'stage_update':
                OnlineManager.updateStage(state.currentStage);
                break;
            case 'round_end':
                OnlineManager.finishRound(state.playerWon ? 'player' : 'opponent');
                OnlineManager.updateScores(state.scores);
                break;
            case 'game_end':
                OnlineManager.finishGame(state.scores);
                break;
        }
    }

    setupOnlineSync() {
        OnlineManager.onRoomUpdate((roomData) => {
            if (roomData && roomData.gameState) {
                this.onlineGameState = roomData.gameState;
                this.syncOnlineGameState(roomData.gameState);
            }
        });

        OnlineManager.onTaps((taps) => {
            this.handleOpponentTap(taps);
        });
    }

    async syncOnlineGameState(gameState) {
        if (!gameState) return;

        const playerScoreEl = document.getElementById('score-player');
        const cpuScoreEl = document.getElementById('score-cpu');
        const roundDisplayEl = document.getElementById('round-display');

        if (playerScoreEl) playerScoreEl.textContent = gameState.scores.player;
        if (cpuScoreEl) cpuScoreEl.textContent = gameState.scores.opponent;
        if (roundDisplayEl) roundDisplayEl.textContent = `${gameState.round} / ${gameState.totalRounds}`;

        if (gameState.phase === 'dealing' && gameState.cards && gameState.cards.length > 0) {
            if (!this.isHost) {
                await this.renderOnlineCards(gameState.cards);
            }
        } else if (gameState.phase === 'reading') {
            this.updateOnlineClue(gameState);
        } else if (gameState.phase === 'result' && !this.hasShownResult) {
            this.hasShownResult = true;
            if (!this.isHost && gameState.target) {
                const clueData = this.engine.clues[gameState.target.id];
                this.showRoundResult({
                    playerWon: gameState.roundWinner === 'player',
                    target: gameState.target,
                    explanation: clueData ? clueData.explanation : '解説データなし'
                });
            }
        } else if (gameState.phase === 'finished') {
            this.showGameEnd({
                playerScore: gameState.scores.player,
                cpuScore: gameState.scores.opponent,
                winner: gameState.scores.player > gameState.scores.opponent ? 'player' : 
                       gameState.scores.player < gameState.scores.opponent ? 'cpu' : 'draw'
            });
        }
    }

    async renderOnlineCards(cards) {
        const grid = document.getElementById('card-grid');
        if (!grid) return;
        grid.innerHTML = '';

        const cardElements = [];
        cards.forEach(c => {
            const div = document.createElement('div');
            div.className = 'card';
            div.dataset.id = (c.id || '').trim();
            const contentDiv = document.createElement('div');
            contentDiv.className = 'card-content';
            div.appendChild(contentDiv);
            grid.appendChild(div);
            cardElements.push({ element: contentDiv, compound: c });
        });

        const promises = cardElements.map(({ element, compound }, index) => {
            return new Promise((resolve) => {
                setTimeout(() => {
                    StructureRenderer.render(element, compound.smiles, 'light', {
                        name: compound.name,
                        name_en: compound.name_en,
                        formula: compound.formula
                    }).then(resolve);
                }, index * 50);
            });
        });

        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 15000));
        await Promise.race([Promise.all(promises), timeoutPromise]);
    }

    updateOnlineClue(gameState) {
        const stageEl = document.getElementById('clue-stage');
        const textEl = document.getElementById('clue-text');
        
        if (stageEl) stageEl.textContent = `STAGE ${gameState.currentStage}`;
        
        if (gameState.target && this.engine.clues[gameState.target.id]) {
            const clueData = this.engine.clues[gameState.target.id];
            const stageData = clueData.stages.find(s => s.stage === gameState.currentStage);
            if (textEl && stageData) {
                textEl.textContent = stageData.text;
            }
        }

        this.updateClueWithHistory({
            target: gameState.target,
            currentStage: gameState.currentStage
        });
    }

    async handleOnlineCardTap(id, element) {
        if (!this.isOnlineMode) return;

        if (this.isHost) {
            this.engine.handlePlayerTap(id);
            const targetId = (this.engine.currentRound.target.id || '').trim();
            const tapId = (id || '').trim();
            const isCorrect = (tapId === targetId);
            if (isCorrect) {
                element.classList.add('correct');
                setTimeout(() => element.classList.add('taken'), 600);
            }
        } else {
            await OnlineManager.recordTap(id);
        }
    }

    handleOpponentTap(taps) {
        if (!this.onlineGameState) return;

        for (const playerId in taps) {
            const tap = taps[playerId];
            const card = document.querySelector(`.card[data-id="${tap.cardId}"]`);
            if (card && !card.classList.contains('taken')) {
                const target = this.onlineGameState.target;
                if (target) {
                    const targetId = (target.id || '').trim();
                    const tapId = (tap.cardId || '').trim();
                    const isCorrect = (tapId === targetId);
                    
                    if (isCorrect) {
                        card.classList.add('correct');
                        setTimeout(() => card.classList.add('taken'), 600);
                    } else {
                        card.classList.add('wrong');
                        setTimeout(() => card.classList.remove('wrong'), 600);
                    }
                }
            }
        }
    }

    renderCategoryGrid() {
        const grid = document.getElementById('category-grid');
        if (!grid) return;

        grid.innerHTML = '';
        const categories = this.engine.getCategories();
        this.selectedCategories = [...categories];
        this.allCategoriesSelected = true;

        categories.forEach(cat => {
            const tag = document.createElement('button');
            tag.className = 'category-tag selected';
            tag.textContent = this.getCategoryDisplayName(cat);
            tag.dataset.category = cat;
            
            tag.addEventListener('click', () => {
                tag.classList.toggle('selected');
                if (tag.classList.contains('selected')) {
                    if (!this.selectedCategories.includes(cat)) {
                        this.selectedCategories.push(cat);
                    }
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
        tags.forEach(tag => {
            tag.classList.toggle('selected', shouldSelect);
        });
        this.selectedCategories = shouldSelect ? this.engine.getCategories() : [];
        this.allCategoriesSelected = shouldSelect;
        this.updateSelectAllButtonText();
    }

    updateDifficultySelection() {
        document.querySelectorAll('.diff-btn').forEach(btn => {
            btn.classList.remove('selected');
            if (parseInt(btn.dataset.level) === this.selectedDifficulty) {
                btn.classList.add('selected');
            }
        });
    }

    startGame() {
        this.isPracticeMode = (this.selectedDifficulty === 0);
        this.isOnlineMode = false;
        this.hasShownResult = false;
        
        const settings = {
            mode: this.isPracticeMode ? 'practice' : 'cpu',
            cpuLevel: this.isPracticeMode ? 0 : this.selectedDifficulty,
            cardCount: StorageManager.loadSettings().cardCount || 9,
            categories: this.selectedCategories.length > 0 ? this.selectedCategories : []
        };
        
        this.engine.configure(settings);
        this.engine.startGame(10);
        
        const gameScreen = document.getElementById('screen-game');
        if (gameScreen) {
            if (this.isPracticeMode) {
                gameScreen.classList.add('practice-mode');
            } else {
                gameScreen.classList.remove('practice-mode');
            }
        }
        
        const playerLabel = document.getElementById('player-score-label');
        const cpuLabel = document.getElementById('cpu-score-label');
        if (playerLabel) playerLabel.textContent = '得点';
        if (cpuLabel) cpuLabel.textContent = this.isPracticeMode ? '' : 'CPU';
        
        this.showScreen('screen-game');
    }

    async updateGameUI(data) {
        // オンラインモードでもホストはUIを更新する
        // if (this.isOnlineMode) return; // この行を削除

        const playerScoreEl = document.getElementById('score-player');
        const cpuScoreEl = document.getElementById('score-cpu');
        const roundDisplayEl = document.getElementById('round-display');
        
        if (playerScoreEl) playerScoreEl.textContent = data.scores.player;
        if (cpuScoreEl) cpuScoreEl.textContent = data.scores.cpu;
        if (roundDisplayEl) roundDisplayEl.textContent = `${data.roundNumber} / ${data.totalRounds}`;

        switch (data.state) {
            case 'DEAL':
                // オンラインモードではホストのみカードを描画
                if (this.isOnlineMode) {
                    if (this.isHost) {
                        await this.renderOnlineCards(data.round.cards);
                        // ホストのみ読み札を開始
                        this.engine.startReading();
                    }
                } else {
                    await this.renderCards(data.round.cards);
                }
                const historyEl = document.getElementById('clue-history');
                if (historyEl) historyEl.innerHTML = '';
                const stageEl = document.getElementById('clue-stage');
                if (stageEl) stageEl.textContent = 'STAGE 1';
                const textEl = document.getElementById('clue-text');
                if (textEl) textEl.textContent = '読み札が始まります';
                const cardField = document.getElementById('card-grid');
                if (cardField) cardField.scrollTop = 0;
                break;

            case 'READING':
                this.updateClueWithHistory(data.round);
                break;

            case 'RESULT':
                break;
        }

        if (data.type === 'wrong') this.flashCard(data.id, 'wrong');
        else if (data.type === 'cpu_wrong') this.flashCard(data.id, 'wrong');
    }

    async renderCards(cards) {
        const grid = document.getElementById('card-grid');
        if (!grid) return;
        grid.innerHTML = '';

        const cardElements = [];
        cards.forEach(c => {
            const div = document.createElement('div');
            div.className = 'card';
            div.dataset.id = (c.id || '').trim();
            const contentDiv = document.createElement('div');
            contentDiv.className = 'card-content';
            div.appendChild(contentDiv);
            grid.appendChild(div);
            cardElements.push({ element: contentDiv, compound: c });
        });

        const promises = cardElements.map(({ element, compound }, index) => {
            return new Promise((resolve) => {
                setTimeout(() => {
                    StructureRenderer.render(element, compound.smiles, 'light', {
                        name: compound.name,
                        name_en: compound.name_en,
                        formula: compound.formula
                    }).then(resolve);
                }, index * 50);
            });
        });

        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 15000));
        await Promise.race([Promise.all(promises), timeoutPromise]);
        this.engine.startReading();
    }

    updateClueWithHistory(round) {
        const clueData = this.engine.clues[round.target.id];
        if (!clueData) return;

        const currentStageData = clueData.stages.find(s => s.stage === round.currentStage);
        if (!currentStageData) return;

        const stageEl = document.getElementById('clue-stage');
        const textEl = document.getElementById('clue-text');
        if (stageEl) stageEl.textContent = `STAGE ${round.currentStage}`;
        if (textEl) textEl.textContent = currentStageData.text;

        const historyDiv = document.getElementById('clue-history');
        if (!historyDiv) return;
        
        const existingStages = Array.from(historyDiv.querySelectorAll('.clue-history-item'));
        const alreadyExists = existingStages.some(item => 
            item.dataset.stage === String(round.currentStage)
        );

        if (!alreadyExists && round.currentStage > 1) {
            const prevStage = round.currentStage - 1;
            const prevStageData = clueData.stages.find(s => s.stage === prevStage);
            if (prevStageData) {
                const historyItem = document.createElement('div');
                historyItem.className = 'clue-history-item';
                historyItem.dataset.stage = String(prevStage);
                historyItem.innerHTML = `
                    <span class="stage-label">STAGE ${prevStage}</span>
                    <div>${prevStageData.text}</div>
                `;
                historyDiv.appendChild(historyItem);
                
                requestAnimationFrame(() => {
                    const cluePanel = document.querySelector('.clue-display');
                    if (cluePanel) {
                        cluePanel.scrollTo({
                            top: cluePanel.scrollHeight,
                            behavior: 'smooth'
                        });
                    }
                });
            }
        }

        if (round.currentStage === 1) {
            historyDiv.innerHTML = '';
            const cluePanel = document.querySelector('.clue-display');
            if (cluePanel) cluePanel.scrollTop = 0;
        }
    }

    handleCardTap(id, element) {
        if (this.isOnlineMode) {
            this.handleOnlineCardTap(id, element);
            return;
        }

        this.engine.handlePlayerTap(id);
        
        const targetId = (this.engine.currentRound.target.id || '').trim();
        const tapId = (id || '').trim();
        const isCorrect = (tapId === targetId);

        if (isCorrect) {
            element.classList.add('correct');
            setTimeout(() => element.classList.add('taken'), 600);
        }
    }

    flashCard(id, type) {
        const card = document.querySelector(`.card[data-id="${id}"]`);
        if (card) {
            card.classList.add(type);
            setTimeout(() => card.classList.remove(type), 600);
        }
    }

    showRoundResult(data) {
        if (this.hasShownResult) return;
        this.hasShownResult = true;

        const playerWon = data.playerWon;
        const compound = data.target;
        const explanation = data.explanation || '解説はありません。';
        
        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        
        const resultTitle = this.isPracticeMode 
            ? (playerWon ? '正解' : '確認') 
            : (playerWon ? '正解' : '不正解');
        const resultColor = playerWon ? '#22c55e' : 'var(--accent-red)';
        
        modal.innerHTML = `
            <div class="modal-content" style="background: var(--card-bg); border: 3px solid ${resultColor}; border-radius: 2px; padding: 25px 20px; max-width: 420px; width: 92%; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5);">
                <h2 style="font-size: 1.8rem; margin-bottom: 15px; color: ${resultColor}; font-family: var(--font-display); letter-spacing: 0.15em;">${resultTitle}</h2>
                <div style="background: var(--tatami-light); border-radius: 2px; padding: 15px; margin-bottom: 15px; min-height: 130px; border: 2px solid var(--card-border);">
                    <div id="modal-structure" style="width: 100%; height: 100%;"></div>
                </div>
                <div style="font-size: 1.2rem; margin-bottom: 6px; color: var(--text-dark); font-family: var(--font-display); font-weight: 700; letter-spacing: 0.1em;">${compound.name}</div>
                <div style="font-size: 0.9rem; color: var(--text-light); margin-bottom: 15px;">${compound.formula}</div>
                <div style="font-size: 0.85rem; color: var(--text-dark); line-height: 1.7; margin-bottom: 20px; text-align: left; background: var(--tatami-light); padding: 12px 14px; border-radius: 2px; border-left: 4px solid var(--accent-gold); font-family: var(--font-main);">
                    <div style="font-size: 0.75rem; font-weight: 700; color: var(--accent-green); letter-spacing: 0.1em; margin-bottom: 4px; font-family: var(--font-display);">解説</div>
                    ${explanation}
                </div>
                <button class="btn btn-primary" id="modal-next-btn" style="width: 100%; font-family: var(--font-display);">次の問題へ</button>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        const structureDiv = document.getElementById('modal-structure');
        if (structureDiv) {
            StructureRenderer.render(structureDiv, compound.smiles, 'light', {
                name: compound.name,
                name_en: compound.name_en,
                formula: compound.formula
            });
        }
        
        const nextBtn = document.getElementById('modal-next-btn');
        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                modal.remove();
                this.hasShownResult = false;
                
                // ホストのみ次のラウンドを開始
                if (this.isHost || !this.isOnlineMode) {
                    this.engine.startNewRound();
                }
                // ゲストはFirebaseの変化を待つ
            });
        }
    }

    showGameEnd(data) {
        if (!this.isPracticeMode && data.winner) {
            StorageManager.recordCpuResult(data.winner);
        }
        
        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        
        if (this.isPracticeMode) {
            modal.innerHTML = `
                <div class="modal-content" style="background: var(--card-bg); border: 3px solid var(--accent-gold); border-radius: 2px; padding: 25px 20px; max-width: 420px; width: 92%; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5);">
                    <h2 style="font-size: 1.8rem; margin-bottom: 15px; color: var(--accent-gold); font-family: var(--font-display); letter-spacing: 0.2em;">練習終了</h2>
                    <div style="background: var(--tatami-light); padding: 20px; border-radius: 2px; border: 2px solid var(--card-border); margin-bottom: 25px;">
                        <div style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 8px; letter-spacing: 0.1em; font-family: var(--font-display);">TOTAL SCORE</div>
                        <div style="font-size: 2.5rem; color: var(--accent-green); font-family: var(--font-display); font-weight: 900;">${data.playerScore}</div>
                    </div>
                    <button class="btn btn-primary" id="modal-finish-btn" style="width: 100%; font-family: var(--font-display);">タイトルへ戻る</button>
                </div>
            `;
        } else {
            const message = data.winner === 'player' ? '勝利' : 
                           data.winner === 'cpu' ? '敗北' : '引き分け';
            
            modal.innerHTML = `
                <div class="modal-content" style="background: var(--card-bg); border: 3px solid var(--accent-gold); border-radius: 2px; padding: 25px 20px; max-width: 420px; width: 92%; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5);">
                    <h2 style="font-size: 1.8rem; margin-bottom: 15px; color: var(--accent-gold); font-family: var(--font-display); letter-spacing: 0.2em;">ゲーム終了</h2>
                    <div style="font-size: 1.4rem; margin-bottom: 20px; color: var(--text-dark); font-family: var(--font-display); font-weight: 700; letter-spacing: 0.1em;">${message}</div>
                    <div style="display: flex; justify-content: space-around; margin-bottom: 25px; gap: 15px;">
                        <div style="text-align: center; flex: 1; background: var(--tatami-light); padding: 12px 8px; border-radius: 2px; border: 2px solid var(--card-border);">
                            <div style="font-size: 0.8rem; color: var(--text-light); margin-bottom: 5px; letter-spacing: 0.1em; font-family: var(--font-display);">PLAYER</div>
                            <div style="font-size: 1.8rem; color: var(--accent-green); font-family: var(--font-display); font-weight: 900;">${data.playerScore}</div>
                        </div>
                        <div style="text-align: center; flex: 1; background: var(--tatami-light); padding: 12px 8px; border-radius: 2px; border: 2px solid var(--card-border);">
                            <div style="font-size: 0.8rem; color: var(--text-light); margin-bottom: 5px; letter-spacing: 0.1em; font-family: var(--font-display);">CPU</div>
                            <div style="font-size: 1.8rem; color: var(--accent-red); font-family: var(--font-display); font-weight: 900;">${data.cpuScore}</div>
                        </div>
                    </div>
                    <button class="btn btn-primary" id="modal-finish-btn" style="width: 100%; font-family: var(--font-display);">タイトルへ戻る</button>
                </div>
            `;
        }
        
        document.body.appendChild(modal);
        
        const finishBtn = document.getElementById('modal-finish-btn');
        if (finishBtn) {
            finishBtn.addEventListener('click', () => {
                modal.remove();
                if (this.isOnlineMode) {
                    if (typeof OnlineManager !== 'undefined') {
                        OnlineManager.leaveRoom();
                    }
                    this.isOnlineMode = false;
                }
                this.showScreen('screen-title');
            });
        }
    }

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
            
            row.innerHTML = `
                <div class="bar-label" title="${labelFunc(item.key)}">${labelFunc(item.key)}</div>
                <div class="bar-track">
                    <div class="bar-fill ${isLow ? 'low' : ''}" style="width: ${item.rate}%"></div>
                </div>
                <div class="bar-value">${item.rate}%</div>
            `;
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
            const dateStr = `${date.getMonth()+1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2,'0')}`;
            
            let compoundName = h.compoundId;
            const compound = this.engine.compounds.find(c => (c.id || '').trim() === h.compoundId);
            if (compound) compoundName = compound.name;
            
            const item = document.createElement('div');
            item.className = `history-item ${h.result}`;
            item.innerHTML = `
                <div class="history-date">${dateStr}</div>
                <div class="history-name">${compoundName}</div>
                <div class="history-result">${h.result === 'correct' ? '正解' : '不正解'}</div>
            `;
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
                item.dataset.id = (compound.id || '').trim();
                
                item.innerHTML = `
                    <div class="reference-item-structure" data-smiles="${compound.smiles || ''}"></div>
                    <div class="reference-item-name">${compound.name || ''}</div>
                    <div class="reference-item-formula">${compound.formula || ''}</div>
                `;
                
                item.addEventListener('click', () => {
                    this.showReferenceDetail(compound);
                });
                
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
                        StructureRenderer.render(el, smiles, 'light', {});
                    }, index * 30);
                }
            });
        });
    }

    showReferenceDetail(compound) {
        const modal = document.getElementById('reference-detail-modal');
        if (!modal) return;
        
        const clueData = this.engine.clues[(compound.id || '').trim()];
        
        document.getElementById('detail-name').textContent = compound.name || '';
        document.getElementById('detail-formula').textContent = compound.formula || '';
        
        const structureDiv = document.getElementById('detail-structure');
        structureDiv.innerHTML = '';
        if (compound.smiles) {
            StructureRenderer.render(structureDiv, compound.smiles, 'light', {
                name: compound.name,
                name_en: compound.name_en,
                formula: compound.formula
            });
        }
        
        const stagesDiv = document.getElementById('detail-stages');
        stagesDiv.innerHTML = '';
        
        if (clueData && clueData.stages && clueData.stages.length > 0) {
            const title = document.createElement('div');
            title.className = 'reference-detail-stages-title';
            title.textContent = '読み札';
            stagesDiv.appendChild(title);
            
            clueData.stages.forEach(stage => {
                const item = document.createElement('div');
                item.className = 'reference-stage-item';
                item.innerHTML = `<span class="stage-num">STEP ${stage.stage}</span>${stage.text}`;
                stagesDiv.appendChild(item);
            });
            
            const playBtn = document.createElement('button');
            playBtn.className = 'btn btn-primary';
            playBtn.style.cssText = 'width: 100%; margin-top: 12px; font-size: 0.9rem; padding: 10px;';
            playBtn.textContent = '読み上げる';
            playBtn.addEventListener('click', () => {
                this.playAllStages(clueData.stages);
            });
            stagesDiv.appendChild(playBtn);
        } else {
            stagesDiv.innerHTML = '<div style="color: var(--text-light); font-size: 0.85rem; padding: 10px;">読み札データがありません</div>';
        }
        
        const explanationDiv = document.getElementById('detail-explanation');
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
                    if (index < stages.length) {
                        setTimeout(playNext, 500);
                    }
                }
            });
        };
        playNext();
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const target = document.getElementById(screenId);
        if (target) {
            target.classList.add('active');
            const scrollables = target.querySelectorAll('.clue-display, .card-field, .settings-container, .stats-container, .difficulty-container, .title-container, .reference-list');
            scrollables.forEach(el => { el.scrollTop = 0; });
        }
    }

    showHint() {
        const target = this.engine.currentRound.target;
        if (!target) return;
        const categoryName = this.getCategoryDisplayName(target.category);
        alert(`ヒント: ${categoryName} / 分子式: ${target.formula}`);
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
        AudioManager.updateSettings({
            enabled: settings.voiceEnabled,
            rate: settings.voiceSpeed
        });
    }
}

window.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, starting app...');
    window.app = new App();
});