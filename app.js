/**
 * App - メインアプリケーションクラス
 * 画面遷移、ゲーム制御、UI更新を統合管理
 * - 絵文字不使用（すべてSVGアイコン）
 * - 筑紫ゴシック統一
 * - 読み札履歴表示対応（画面ずれ修正版）
 * - 単元別選択機能対応
 * - レスポンシブ対応
 * - compounds.json キー名空白対応
 */
class App {
    constructor() {
        this.engine = new GameEngine();
        this.currentMode = 'cpu';
        this.selectedDifficulty = 3;
        this.selectedCategories = [];
        this.allCategoriesSelected = true;
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
            this.renderCategoryGrid();
            
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

        // 難易度ボタン
        document.querySelectorAll('.diff-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('selected'));
                e.currentTarget.classList.add('selected');
                this.selectedDifficulty = parseInt(e.currentTarget.dataset.level);
            });
        });

        // 「開始」ボタン
        const startBtn = document.getElementById('btn-start-difficulty');
        if (startBtn) {
            startBtn.addEventListener('click', () => {
                this.startGame();
            });
        }

        // 単元「すべて選択」ボタン
        const selectAllBtn = document.getElementById('btn-select-all');
        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', () => {
                this.toggleSelectAllCategories();
            });
        }

        // ゲーム画面の操作
        const cardGrid = document.getElementById('card-grid');
        if (cardGrid) {
            cardGrid.addEventListener('click', (e) => {
                const card = e.target.closest('.card');
                if (card && !card.classList.contains('taken')) {
                    const id = card.dataset.id;
                    this.handleCardTap(id, card);
                }
            });
        }

        const skipBtn = document.getElementById('btn-skip');
        if (skipBtn) {
            skipBtn.addEventListener('click', () => {
                this.engine.skipRound();
            });
        }

        const pauseBtn = document.getElementById('btn-pause');
        if (pauseBtn) {
            pauseBtn.addEventListener('click', () => {
                this.engine.pause();
                this.showScreen('screen-title');
            });
        }

        const hintBtn = document.getElementById('btn-hint');
        if (hintBtn) {
            hintBtn.addEventListener('click', () => {
                this.showHint();
            });
        }

        const nextClueBtn = document.getElementById('btn-next-clue');
        if (nextClueBtn) {
            nextClueBtn.addEventListener('click', () => {
                this.engine.nextClue();
            });
        }

        // 設定
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

    /**
     * 単元グリッドを動的に生成
     */
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
        if (!btn) return;
        btn.textContent = this.allCategoriesSelected ? 'すべて解除' : 'すべて選択';
    }

    toggleSelectAllCategories() {
        const tags = document.querySelectorAll('.category-tag');
        const shouldSelect = !this.allCategoriesSelected;
        
        tags.forEach(tag => {
            if (shouldSelect) {
                tag.classList.add('selected');
            } else {
                tag.classList.remove('selected');
            }
        });
        
        if (shouldSelect) {
            this.selectedCategories = this.engine.getCategories();
        } else {
            this.selectedCategories = [];
        }
        
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
        const settings = {
            mode: this.currentMode,
            cpuLevel: this.selectedDifficulty,
            cardCount: StorageManager.loadSettings().cardCount || 9,
            categories: this.selectedCategories.length > 0 ? this.selectedCategories : []
        };

        this.engine.configure(settings);
        this.engine.startGame(10);

        this.showScreen('screen-game');
        this.startTimer();
    }

    async updateGameUI(data) {
        const timerEl = document.getElementById('timer');
        if (timerEl) {
            timerEl.textContent = this.formatTime(Date.now() - this.gameStartTime);
        }

        switch (data.state) {
            case 'DEAL':
                await this.renderCards(data.round.cards);
                const historyEl = document.getElementById('clue-history');
                if (historyEl) historyEl.innerHTML = '';
                const stageEl = document.getElementById('clue-stage');
                if (stageEl) stageEl.textContent = 'STAGE 1';
                const textEl = document.getElementById('clue-text');
                if (textEl) textEl.textContent = '読み札が始まります';
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
        if (!grid) return;
        grid.innerHTML = '';

        const cardElements = [];
        cards.forEach(c => {
            const div = document.createElement('div');
            div.className = 'card';
            // キー名空白対策：idをトリム
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

        const timeoutPromise = new Promise((resolve) => {
            setTimeout(resolve, 15000);
        });

        await Promise.race([Promise.all(promises), timeoutPromise]);
        this.engine.startReading();
    }

    /**
     * 読み札の履歴表示（画面ずれ修正版）
     * requestAnimationFrame + setTimeout の二段階スクロールで確実化
     */
    updateClueWithHistory(round) {
        const clueData = this.engine.clues[round.target.id];
        if (!clueData) return;

        const currentStageData = clueData.stages.find(s => s.stage === round.currentStage);
        
        if (currentStageData) {
            // 現在のstageを表示
            const stageEl = document.getElementById('clue-stage');
            const textEl = document.getElementById('clue-text');
            if (stageEl) stageEl.textContent = `STAGE ${round.currentStage}`;
            if (textEl) textEl.textContent = currentStageData.text;

            const historyDiv = document.getElementById('clue-history');
            if (!historyDiv) return;
            
            // 重複チェック
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
                    
                    // 画面ずれ防止：二段階スクロール
                    // 1. DOM更新直後にrequestAnimationFrameでスクロール
                    requestAnimationFrame(() => {
                        const cluePanel = document.querySelector('.clue-display');
                        if (cluePanel) {
                            // 2. アニメーション完了後に再度スクロール（確実化）
                            setTimeout(() => {
                                cluePanel.scrollTo({
                                    top: cluePanel.scrollHeight,
                                    behavior: 'smooth'
                                });
                            }, 350);
                        }
                    });
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
                this.engine.startNewRound();
            });
        }
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
        
        const finishBtn = document.getElementById('modal-finish-btn');
        if (finishBtn) {
            finishBtn.addEventListener('click', () => {
                modal.remove();
                this.showScreen('screen-title');
            });
        }
    }

    updateStats() {
        const stats = StorageManager.getSummary();
        
        const winrateEl = document.getElementById('stat-winrate');
        const accuracyEl = document.getElementById('stat-accuracy');
        const gamesEl = document.getElementById('stat-games');
        
        if (winrateEl) winrateEl.textContent = stats.accuracy + '%';
        if (accuracyEl) accuracyEl.textContent = stats.accuracy + '%';
        if (gamesEl) gamesEl.textContent = stats.totalGames;
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
            const timerEl = document.getElementById('timer');
            if (timerEl) {
                timerEl.textContent = this.formatTime(elapsed);
            }
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
        if (!target) return;
        const categoryName = this.getCategoryDisplayName(target.category);
        alert(`ヒント: ${categoryName} / 分子式: ${target.formula}`);
    }

    getCategoryDisplayName(category) {
        const names = {
            hydrocarbon: '炭化水素',
            aromatic: '芳香族',
            alcohol: 'アルコール',
            phenol: 'フェノール',
            carbonyl: 'カルボニル',
            acid: 'カルボン酸',
            ester: 'エステル',
            ether: 'エーテル',
            amine: 'アミン',
            nitro: 'ニトロ',
            halide: 'ハロゲン',
            amino_acid: 'アミノ酸',
            sugar: '糖',
            fatty_acid: '脂肪酸',
            fat: '油脂',
            amide: 'アミド',
            heterocycle: '複素環',
            nucleobase: '核酸塩基',
            nitrile: 'ニトリル',
            peptide: 'ペプチド',
            nitrate: '硝酸エステル',
            indicator: '指示薬',
            soap: '石鹸',
            surfactant: '界面活性剤',
            pharmaceutical: '医薬品',
            alkaloid: 'アルカロイド',
            polysaccharide: '多糖類'
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


