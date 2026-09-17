/**
 * App - メインアプリケーションクラス
 * 画面遷移、ゲーム制御、UI更新を統合管理
 * 絵文字不使用・筑紫ゴシック統一・読み札履歴表示対応
 */
class App {
    constructor() {
        this.engine = new GameEngine();
        this.currentMode = 'cpu';
        this.selectedDifficulty = 3;
        this.timerInterval = null;
        this.gameStartTime = 0;
        
        this.init();
    }

    async init() {
        console.log('App initializing...');
        
        try {
            const loaded = await this.engine.loadData();
            
            if (!loaded) {
                console.error('Failed to load data');
                this.showError('データ読み込み失敗');
                return;
            }

            console.log('Data loaded successfully');
            
            StructureRenderer.init();
            AudioManager.init();
            StorageManager.init();
            this.loadSettings();

            this.engine.onUpdate = (data) => this.updateGameUI(data);
            this.engine.onRoundEnd = (data) => this.showRoundResult(data);
            this.engine.onGameEnd = (data) => this.showGameEnd(data);

            this.bindEvents();
            
            console.log('App ready, showing title screen');
            
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
        // 画面遷移 (data-next)
        document.querySelectorAll('[data-next]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const nextScreen = e.currentTarget.dataset.next;
                const mode = e.currentTarget.dataset.mode;
                
                if (mode) this.currentMode = mode;
                
                if (nextScreen === 'screen-difficulty') {
                    this.updateDifficultySelection();
                } else if (nextScreen === 'screen-stats') {
                    this.updateStats();
                }
                
                this.showScreen(nextScreen);
            });
        });

        // 戻るボタン (data-back)
        document.querySelectorAll('[data-back]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.showScreen(e.currentTarget.dataset.back);
            });
        });

        // 難易度ボタン（クリックで選択）
        document.querySelectorAll('.diff-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('selected'));
                e.currentTarget.classList.add('selected');
                this.selectedDifficulty = parseInt(e.currentTarget.dataset.level);
            });
        });

        // 「次へ」ボタンでゲーム開始
        document.getElementById('btn-start-difficulty').addEventListener('click', () => {
            this.startGame();
        });

        // ゲーム画面の操作
        document.getElementById('card-grid').addEventListener('click', (e) => {
            const card = e.target.closest('.card');
            if (card && !card.classList.contains('taken')) {
                const id = card.dataset.id;
                this.handleCardTap(id, card);
            }
        });

        document.getElementById('btn-skip').addEventListener('click', () => {
            this.engine.skipRound();
        });

        document.getElementById('btn-pause').addEventListener('click', () => {
            this.engine.pause();
            this.showScreen('screen-title');
        });

        document.getElementById('btn-hint').addEventListener('click', () => {
            this.showHint();
        });

        document.getElementById('btn-next-clue').addEventListener('click', () => {
            this.engine.nextClue();
        });

        // 設定
        document.getElementById('setting-voice').addEventListener('change', (e) => {
            StorageManager.updateSetting('voiceEnabled', e.target.checked);
            AudioManager.updateSettings({ enabled: e.target.checked });
        });

        document.getElementById('setting-voice-speed').addEventListener('change', (e) => {
            StorageManager.updateSetting('voiceSpeed', parseFloat(e.target.value));
            AudioManager.updateSettings({ rate: parseFloat(e.target.value) });
        });

        document.getElementById('setting-card-count').addEventListener('change', (e) => {
            StorageManager.updateSetting('cardCount', parseInt(e.target.value));
        });

        document.getElementById('btn-reset-stats').addEventListener('click', () => {
            if (confirm('統計データを初期化しますか？')) {
                StorageManager.resetAll();
                alert('初期化しました。');
            }
        });
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
        const settings = {
            mode: this.currentMode,
            cpuLevel: this.selectedDifficulty,
            cardCount: StorageManager.loadSettings().cardCount || 9,
            categories: []
        };

        this.engine.configure(settings);
        this.engine.startGame(10);

        this.showScreen('screen-game');
        this.startTimer();
    }

    async updateGameUI(data) {
        document.getElementById('timer').textContent = this.formatTime(Date.now() - this.gameStartTime);

        switch (data.state) {
            case 'DEAL':
                await this.renderCards(data.round.cards);
                document.getElementById('clue-history').innerHTML = '';
                document.getElementById('clue-stage').textContent = 'STAGE 1';
                document.getElementById('clue-text').textContent = '読み札が始まります';
                break;

            case 'READING':
                this.updateClueWithHistory(data.round);
                break;

            case 'RESULT':
                this.stopTimer();
                break;
        }

        if (data.type === 'wrong') {
            this.flashCard(data.id, 'wrong');
        } else if (data.type === 'cpu_wrong') {
            this.flashCard(data.id, 'wrong');
        }
    }

    async renderCards(cards) {
        const grid = document.getElementById('card-grid');
        grid.innerHTML = '';

        const cardElements = [];
        cards.forEach(c => {
            const div = document.createElement('div');
            div.className = 'card';
            div.dataset.id = c.id;

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

        const timeoutPromise = new Promise((resolve) => {
            setTimeout(resolve, 15000);
        });

        await Promise.race([Promise.all(promises), timeoutPromise]);
        this.engine.startReading();
    }

    /**
     * 読み札の履歴表示（過去のstageを累積）
     */
    updateClueWithHistory(round) {
        const clueData = this.engine.clues[round.target.id];
        if (!clueData) return;

        const currentStageData = clueData.stages.find(s => s.stage === round.currentStage);
        
        if (currentStageData) {
            // 現在のstageを表示
            document.getElementById('clue-stage').textContent = `STAGE ${round.currentStage}`;
            document.getElementById('clue-text').textContent = currentStageData.text;

            // 前のstageを履歴に追加（重複チェック）
            const historyDiv = document.getElementById('clue-history');
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
                    
                    // 履歴を自動スクロール
                    const cluePanel = document.querySelector('.clue-display');
                    if (cluePanel) {
                        cluePanel.scrollTop = cluePanel.scrollHeight;
                    }
                }
            }

            // 初回表示時（Stage 1）は履歴をクリア
            if (round.currentStage === 1) {
                historyDiv.innerHTML = '';
            }
        }
    }

    handleCardTap(id, element) {
        this.engine.handlePlayerTap(id);

        const isCorrect = (id === this.engine.currentRound.target.id);
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
        const playerWon = data.playerWon;
        const compound = data.target;
        
        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.innerHTML = `
            <div class="modal-content" style="background: var(--card-bg); border: 3px solid ${playerWon ? '#22c55e' : 'var(--accent-red)'}; border-radius: 2px; padding: 30px; max-width: 400px; width: 90%; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5);">
                <h2 style="font-size: 2rem; margin-bottom: 20px; color: ${playerWon ? '#22c55e' : 'var(--accent-red)'}; font-family: var(--font-display); letter-spacing: 0.15em;">${playerWon ? '正解' : '不正解'}</h2>
                <div style="background: var(--tatami-light); border-radius: 2px; padding: 20px; margin-bottom: 20px; min-height: 150px; border: 2px solid var(--card-border);">
                    <div id="modal-structure" style="width: 100%; height: 100%;"></div>
                </div>
                <div style="font-size: 1.3rem; margin-bottom: 10px; color: var(--text-dark); font-family: var(--font-display); font-weight: 700; letter-spacing: 0.1em;">${compound.name}</div>
                <div style="font-size: 0.95rem; color: var(--text-light); margin-bottom: 20px;">${compound.formula}</div>
                <div style="font-size: 0.9rem; color: var(--text-dark); line-height: 1.8; margin-bottom: 30px; text-align: left; background: var(--tatami-light); padding: 15px; border-radius: 2px; border-left: 4px solid var(--accent-green);">${data.explanation}</div>
                <button class="btn btn-primary" id="modal-next-btn" style="width: 100%; font-family: var(--font-display);">次の問題へ</button>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        const structureDiv = document.getElementById('modal-structure');
        StructureRenderer.render(structureDiv, compound.smiles, 'light', {
            name: compound.name,
            name_en: compound.name_en,
            formula: compound.formula
        });
        
        document.getElementById('modal-next-btn').addEventListener('click', () => {
            modal.remove();
            this.engine.startNewRound();
        });
    }

    showGameEnd(data) {
        this.stopTimer();
        
        const message = data.winner === 'player' ? '勝利' : 
                       data.winner === 'cpu' ? '敗北' : '引き分け';
        
        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.innerHTML = `
            <div class="modal-content" style="background: var(--card-bg); border: 3px solid var(--accent-gold); border-radius: 2px; padding: 30px; max-width: 400px; width: 90%; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5);">
                <h2 style="font-size: 2rem; margin-bottom: 20px; color: var(--accent-gold); font-family: var(--font-display); letter-spacing: 0.2em;">ゲーム終了</h2>
                <div style="font-size: 1.5rem; margin-bottom: 20px; color: var(--text-dark); font-family: var(--font-display); font-weight: 700; letter-spacing: 0.1em;">${message}</div>
                <div style="display: flex; justify-content: space-around; margin-bottom: 30px;">
                    <div style="text-align: center;">
                        <div style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 5px; letter-spacing: 0.1em;">PLAYER</div>
                        <div style="font-size: 2rem; color: var(--accent-green); font-family: var(--font-display); font-weight: 700;">${data.playerScore}</div>
                    </div>
                    <div style="text-align: center;">
                        <div style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 5px; letter-spacing: 0.1em;">CPU</div>
                        <div style="font-size: 2rem; color: var(--accent-red); font-family: var(--font-display); font-weight: 700;">${data.cpuScore}</div>
                    </div>
                </div>
                <button class="btn btn-primary" id="modal-finish-btn" style="width: 100%; font-family: var(--font-display);">タイトルへ戻る</button>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        document.getElementById('modal-finish-btn').addEventListener('click', () => {
            modal.remove();
            this.showScreen('screen-title');
        });
    }

    updateStats() {
        const stats = StorageManager.getSummary();
        
        document.getElementById('stat-winrate').textContent = stats.accuracy + '%';
        document.getElementById('stat-accuracy').textContent = stats.accuracy + '%';
        document.getElementById('stat-games').textContent = stats.totalGames;
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const target = document.getElementById(screenId);
        if (target) {
            target.classList.add('active');
        }
    }

    startTimer() {
        this.stopTimer();
        this.gameStartTime = Date.now();
        this.timerInterval = setInterval(() => {
            const elapsed = Date.now() - this.gameStartTime;
            document.getElementById('timer').textContent = this.formatTime(elapsed);
        }, 100);
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    formatTime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        const remainingMs = Math.floor((ms % 1000) / 10);
        
        if (minutes > 0) {
            return `+${minutes}:${remainingSeconds.toString().padStart(2, '0')}.${remainingMs.toString().padStart(2, '0')}秒`;
        } else {
            return `+${seconds}.${remainingMs.toString().padStart(2, '0')}秒`;
        }
    }

    showHint() {
        const target = this.engine.currentRound.target;
        alert(`ヒント: ${target.category} / 分子式: ${target.formula}`);
    }

    loadSettings() {
        const settings = StorageManager.loadSettings();
        if (!settings) return;

        document.getElementById('setting-voice').checked = settings.voiceEnabled;
        document.getElementById('setting-voice-speed').value = settings.voiceSpeed;
        document.getElementById('setting-card-count').value = settings.cardCount;

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


