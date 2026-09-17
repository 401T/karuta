/**
 * App - メインアプリケーションクラス
 * - 絵文字不使用
 * - 筑紫ゴシック統一
 * - 読み札履歴表示（画面ずれ修正）
 * - 単元別選択機能
 * - レスポンシブ対応
 * - compounds.json キー名空白対応
 * - 全画面共通背景（畳）
 * - 得点常時表示 / タイマー削除 / 一口解説表示
 */
class App {
    constructor() {
        this.engine = new GameEngine();
        this.currentMode = 'cpu';
        this.selectedDifficulty = 3;
        this.selectedCategories = [];
        this.allCategoriesSelected = true;
        
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
        document.querySelectorAll('[data-next]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const nextScreen = e.currentTarget.dataset.next;
                const mode = e.currentTarget.dataset.mode;
                if (mode) this.currentMode = mode;
                if (nextScreen === 'screen-difficulty') this.updateDifficultySelection();
                else if (nextScreen === 'screen-stats') this.updateStats();
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
        if (startBtn) {
            startBtn.addEventListener('click', () => this.startGame());
        }

        const selectAllBtn = document.getElementById('btn-select-all');
        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', () => this.toggleSelectAllCategories());
        }

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
        if (skipBtn) skipBtn.addEventListener('click', () => this.engine.skipRound());

        const pauseBtn = document.getElementById('btn-pause');
        if (pauseBtn) pauseBtn.addEventListener('click', () => {
            this.engine.pause();
            this.showScreen('screen-title');
        });

        const hintBtn = document.getElementById('btn-hint');
        if (hintBtn) hintBtn.addEventListener('click', () => this.showHint());

        const nextClueBtn = document.getElementById('btn-next-clue');
        if (nextClueBtn) nextClueBtn.addEventListener('click', () => this.engine.nextClue());

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
        const settings = {
            mode: this.currentMode,
            cpuLevel: this.selectedDifficulty,
            cardCount: StorageManager.loadSettings().cardCount || 9,
            categories: this.selectedCategories.length > 0 ? this.selectedCategories : []
        };
        this.engine.configure(settings);
        this.engine.startGame(10);
        this.showScreen('screen-game');
    }

    /**
     * ゲーム中のUI更新（得点・ラウンド数・読み札）
     */
    async updateGameUI(data) {
        // 得点とラウンド数を常時更新
        const playerScoreEl = document.getElementById('score-player');
        const cpuScoreEl = document.getElementById('score-cpu');
        const roundDisplayEl = document.getElementById('round-display');
        
        if (playerScoreEl) playerScoreEl.textContent = data.scores.player;
        if (cpuScoreEl) cpuScoreEl.textContent = data.scores.cpu;
        if (roundDisplayEl) roundDisplayEl.textContent = `${data.roundNumber} / ${data.totalRounds}`;

        switch (data.state) {
            case 'DEAL':
                await this.renderCards(data.round.cards);
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
                // 結果表示時は何もしない（モーダルで処理）
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

    /**
     * 正解/不正解モーダル（一口解説付き）
     */
    showRoundResult(data) {
        const playerWon = data.playerWon;
        const compound = data.target;
        const explanation = data.explanation || '解説はありません。';
        
        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.innerHTML = `
            <div class="modal-content" style="background: var(--card-bg); border: 3px solid ${playerWon ? '#22c55e' : 'var(--accent-red)'}; border-radius: 2px; padding: 25px 20px; max-width: 420px; width: 92%; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5);">
                <h2 style="font-size: 1.8rem; margin-bottom: 15px; color: ${playerWon ? '#22c55e' : 'var(--accent-red)'}; font-family: var(--font-display); letter-spacing: 0.15em;">${playerWon ? '正解' : '不正解'}</h2>
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
                this.engine.startNewRound();
            });
        }
    }

    /**
     * ゲーム終了モーダル（得点表示）
     */
    showGameEnd(data) {
        const message = data.winner === 'player' ? '勝利' : 
                       data.winner === 'cpu' ? '敗北' : '引き分け';
        
        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
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
            const scrollables = target.querySelectorAll('.clue-display, .card-field, .settings-container, .stats-container, .difficulty-container, .title-container');
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


