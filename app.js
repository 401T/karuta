/**
 * App - メインアプリケーションクラス
 * 和風デザイン・読み札履歴表示・ステージ自動進行対応
 */
class App {
    constructor() {
        this.engine = new GameEngine();
        this.currentMode = 'cpu';
        this.timerInterval = null;
        this.gameStartTime = 0;
        
        // DOM要素のキャッシュ
        this.dom = {
            loading: document.getElementById('loading-screen'),
            screens: {
                menu: document.getElementById('screen-menu'),
                settings: document.getElementById('screen-settings'),
                gameSetup: document.getElementById('screen-game-setup'),
                game: document.getElementById('screen-game'),
                result: document.getElementById('screen-result'),
                pause: document.getElementById('screen-pause'),
                stats: document.getElementById('screen-stats')
            },
            menu: {
                compoundCount: document.getElementById('compound-count')
            },
            setup: {
                title: document.getElementById('setup-title'),
                difficultyGrid: document.getElementById('difficulty-grid'),
                categoryTags: document.getElementById('category-tags'),
                startBtn: document.getElementById('btn-start-game')
            },
            game: {
                scorePlayer: document.getElementById('score-player'),
                scoreCpu: document.getElementById('score-cpu'),
                timer: document.getElementById('timer'),
                combo: document.getElementById('combo'),
                clueHistory: document.getElementById('clue-history'),
                clueStage: document.getElementById('clue-stage'),
                clueText: document.getElementById('clue-text'),
                cardGrid: document.getElementById('card-grid'),
                roundInfo: document.getElementById('round-info'),
                pauseBtn: document.getElementById('btn-pause'),
                hintBtn: document.getElementById('btn-hint'),
                nextClueBtn: document.getElementById('btn-next-clue'),
                skipBtn: document.getElementById('btn-skip')
            },
            result: {
                header: document.getElementById('result-header'),
                icon: document.getElementById('result-icon'),
                title: document.getElementById('result-title'),
                score: document.getElementById('result-score'),
                structure: document.getElementById('result-structure'),
                name: document.getElementById('result-name'),
                time: document.getElementById('result-time'),
                explanation: document.getElementById('result-explanation'),
                nextBtn: document.getElementById('btn-next-round'),
                finishBtn: document.getElementById('btn-finish-game')
            },
            stats: {
                todayGames: document.getElementById('stat-today-games'),
                todayAccuracy: document.getElementById('stat-today-accuracy'),
                todayAvgTime: document.getElementById('stat-today-avg-time'),
                accuracyBars: document.getElementById('accuracy-bars'),
                weaknessList: document.getElementById('weakness-list')
            },
            settings: {
                voice: document.getElementById('setting-voice'),
                voiceSpeed: document.getElementById('setting-voice-speed'),
                cardCount: document.getElementById('setting-card-count'),
                resetBtn: document.getElementById('btn-reset-stats')
            }
        };

        this.selectedDifficulty = 3;
        this.selectedCategories = [];

        this.init();
    }

    /**
     * 初期化
     */
    async init() {
        this.showLoading(true);

        const loaded = await this.engine.loadData();
        
        if (!loaded) {
            alert('データの読み込みに失敗しました。');
            return;
        }

        StructureRenderer.init();
        AudioManager.init();
        StorageManager.init();
        this.loadSettings();

        this.engine.onUpdate = (data) => this.updateGameUI(data);
        this.engine.onRoundEnd = (data) => this.showResult(data);
        this.engine.onGameEnd = (data) => this.showGameEnd(data);

        this.bindEvents();
        this.dom.menu.compoundCount.textContent = this.engine.getCompoundCount();

        setTimeout(() => {
            this.showLoading(false);
            this.showScreen('menu');
        }, 500);

        console.log('App initialized successfully');
    }

    /**
     * イベント設定
     */
    bindEvents() {
        document.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const mode = e.currentTarget.dataset.mode;
                this.handleMenuClick(mode);
            });
        });

        document.querySelectorAll('.back-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.showScreen('menu');
            });
        });

        this.dom.setup.startBtn.addEventListener('click', () => {
            this.startGame();
        });

        this.dom.game.cardGrid.addEventListener('click', (e) => {
            const card = e.target.closest('.card');
            if (card && !card.classList.contains('taken')) {
                const id = card.dataset.id;
                this.handleCardTap(id, card);
            }
        });

        this.dom.game.pauseBtn.addEventListener('click', () => {
            this.pauseGame();
        });

        this.dom.game.hintBtn.addEventListener('click', () => {
            this.showHint();
        });

        this.dom.game.nextClueBtn.addEventListener('click', () => {
            this.engine.nextClue();
        });

        this.dom.game.skipBtn.addEventListener('click', () => {
            this.engine.skipRound();
        });

        this.dom.result.nextBtn.addEventListener('click', () => {
            this.showScreen('game');
            this.engine.startNewRound();
        });

        this.dom.result.finishBtn.addEventListener('click', () => {
            this.showScreen('menu');
        });

        document.getElementById('btn-resume').addEventListener('click', () => {
            this.resumeGame();
        });

        document.getElementById('btn-quit').addEventListener('click', () => {
            this.showScreen('menu');
        });

        this.dom.settings.voice.addEventListener('change', (e) => {
            this.updateSetting('voiceEnabled', e.target.checked);
        });

        this.dom.settings.voiceSpeed.addEventListener('change', (e) => {
            this.updateSetting('voiceSpeed', parseFloat(e.target.value));
        });

        this.dom.settings.cardCount.addEventListener('change', (e) => {
            this.updateSetting('cardCount', parseInt(e.target.value));
        });

        this.dom.settings.resetBtn.addEventListener('click', () => {
            if (confirm('統計データを初期化しますか？')) {
                StorageManager.resetAll();
                alert('初期化しました。');
            }
        });
    }

    /**
     * メニュークリック処理
     */
    handleMenuClick(mode) {
        AudioManager.playSound('click');

        if (mode === 'settings') {
            this.showScreen('settings');
        } else if (mode === 'stats') {
            this.showStats();
            this.showScreen('stats');
        } else {
            this.currentMode = mode;
            this.setupGameScreen(mode);
            this.showScreen('gameSetup');
        }
    }

    /**
     * ゲーム設定画面の準備
     */
    setupGameScreen(mode) {
        const titles = {
            cpu: 'CPU対戦',
            local: '友達対戦',
            practice: '一人練習',
            training: '構造決定訓練'
        };

        this.dom.setup.title.textContent = titles[mode] || 'ゲーム設定';

        this.dom.setup.difficultyGrid.innerHTML = '';
        for (let i = 1; i <= 7; i++) {
            const btn = document.createElement('button');
            btn.className = 'difficulty-btn' + (i === this.selectedDifficulty ? ' selected' : '');
            btn.innerHTML = `
                <div class="difficulty-level">第${['一','二','三','四','五','六','七'][i-1]}段</div>
                <div class="difficulty-name">${this.getDifficultyName(i)}</div>
            `;
            btn.addEventListener('click', () => {
                this.selectedDifficulty = i;
                document.querySelectorAll('.difficulty-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
            });
            this.dom.setup.difficultyGrid.appendChild(btn);
        }

        this.dom.setup.categoryTags.innerHTML = '';
        const categories = this.engine.getCategories();
        categories.forEach(cat => {
            const tag = document.createElement('button');
            tag.className = 'category-tag';
            tag.textContent = this.getCategoryDisplayName(cat);
            tag.addEventListener('click', () => {
                tag.classList.toggle('selected');
                if (tag.classList.contains('selected')) {
                    this.selectedCategories.push(cat);
                } else {
                    this.selectedCategories = this.selectedCategories.filter(c => c !== cat);
                }
            });
            this.dom.setup.categoryTags.appendChild(tag);
        });
    }

    /**
     * ゲーム開始
     */
    startGame() {
        AudioManager.playSound('click');

        const settings = {
            mode: this.currentMode,
            cpuLevel: this.selectedDifficulty,
            cardCount: StorageManager.loadSettings().cardCount || 9,
            categories: this.selectedCategories
        };

        this.engine.configure(settings);
        this.engine.startGame(10);

        this.showScreen('game');
        this.gameStartTime = Date.now();
        this.startTimer();
    }

    /**
     * ゲーム中のUI更新
     */
    updateGameUI(data) {
        this.dom.game.scorePlayer.textContent = data.scores.player;
        this.dom.game.scoreCpu.textContent = data.scores.cpu;
        this.dom.game.roundInfo.textContent = `${data.roundNumber} / ${data.totalRounds}`;

        if (data.combo > 1) {
            this.dom.game.combo.textContent = `${data.combo}連`;
        } else {
            this.dom.game.combo.textContent = '';
        }

        switch (data.state) {
            case 'DEAL':
                this.renderCards(data.round.cards);
                this.dom.game.clueHistory.innerHTML = '';
                this.dom.game.clueStage.textContent = '読み札';
                this.dom.game.clueText.textContent = '読み札が始まります';
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

    /**
     * カードを描画（構造式表示）
     */
    renderCards(cards) {
        this.dom.game.cardGrid.innerHTML = '';

        cards.forEach(c => {
            const div = document.createElement('div');
            div.className = 'card';
            div.dataset.id = c.id;

            const contentDiv = document.createElement('div');
            contentDiv.className = 'card-content';
            div.appendChild(contentDiv);

            this.dom.game.cardGrid.appendChild(div);

            // 構造式を描画（compoundオブジェクト全体を渡す）
            requestAnimationFrame(() => {
                StructureRenderer.render(contentDiv, c.smiles, 'light', {
                    name: c.name,
                    name_en: c.name_en,
                    formula: c.formula
                });
            });
        });
    }

    /**
     * 読み札を更新（履歴付き・巻物風）
     */
    updateClueWithHistory(round) {
        const clueData = this.engine.clues[round.target.id];
        if (!clueData) return;

        const currentStageData = clueData.stages.find(s => s.stage === round.currentStage);
        
        if (currentStageData) {
            // 現在のステージを強調表示
            this.dom.game.clueStage.textContent = `第${['一','二','三','四'][round.currentStage-1]}段`;
            this.dom.game.clueText.textContent = currentStageData.text;

            // 前のステージを履歴に追加（重複チェック）
            const existingStages = Array.from(this.dom.game.clueHistory.querySelectorAll('.clue-history-item'));
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
                        <span class="stage-label">第${['一','二','三','四'][prevStage-1]}段</span>
                        <div>${prevStageData.text}</div>
                    `;
                    this.dom.game.clueHistory.appendChild(historyItem);
                    
                    // 履歴を自動スクロール
                    const cluePanel = document.querySelector('.clue-panel');
                    if (cluePanel) {
                        cluePanel.scrollTop = cluePanel.scrollHeight;
                    }
                }
            }

            // 初回表示時（Stage 1）は履歴をクリア
            if (round.currentStage === 1) {
                this.dom.game.clueHistory.innerHTML = '';
            }
        }
    }

    /**
     * カードタップ処理
     */
    handleCardTap(id, element) {
        this.engine.handlePlayerTap(id);

        const isCorrect = (id === this.engine.currentRound.target.id);
        if (isCorrect) {
            element.classList.add('correct');
            setTimeout(() => element.classList.add('taken'), 600);
        }
    }

    /**
     * カードのフラッシュエフェクト
     */
    flashCard(id, type) {
        const card = document.querySelector(`.card[data-id="${id}"]`);
        if (card) {
            card.classList.add(type);
            setTimeout(() => card.classList.remove(type), 600);
        }
    }

    /**
     * 結果表示
     */
    showResult(data) {
        const playerWon = data.playerWon;

        this.dom.result.icon.textContent = playerWon ? '✓' : '✗';
        this.dom.result.icon.style.background = playerWon 
            ? 'linear-gradient(135deg, var(--kin-iro) 0%, var(--kin-iro-light) 100%)' 
            : 'linear-gradient(135deg, var(--shu-iro) 0%, #e57373 100%)';

        this.dom.result.title.textContent = playerWon ? '正解' : '不正解';
        this.dom.result.title.style.color = playerWon ? 'var(--success)' : 'var(--danger)';

        if (playerWon) {
            const gained = this.engine.scores.player - (this.engine.scores.player - 1000);
            this.dom.result.score.textContent = `+${gained}`;
        } else {
            this.dom.result.score.textContent = '';
        }

        // 構造式表示
        this.dom.result.structure.innerHTML = '';
        const contentDiv = document.createElement('div');
        contentDiv.style.width = '100%';
        contentDiv.style.height = '100%';
        this.dom.result.structure.appendChild(contentDiv);
        StructureRenderer.render(contentDiv, data.target.smiles, 'light', {
            name: data.target.name,
            name_en: data.target.name_en,
            formula: data.target.formula
        });

        this.dom.result.name.textContent = data.target.name;
        
        const reactionTime = ((Date.now() - this.engine.currentRound.startTime) / 1000).toFixed(2);
        this.dom.result.time.textContent = `${reactionTime}秒`;

        this.dom.result.explanation.textContent = data.explanation;

        this.showScreen('result');
    }

    /**
     * ゲーム終了表示
     */
    showGameEnd(data) {
        this.stopTimer();
        
        const message = data.winner === 'player' ? '勝利！' : 
                       data.winner === 'cpu' ? '敗北...' : '引き分け';
        
        alert(`ゲーム終了\n${message}\n\n玩家: ${data.playerScore}点\nCPU: ${data.cpuScore}点\n最大連勝: ${data.maxCombo}`);
        
        this.showScreen('menu');
    }

    /**
     * 統計表示
     */
    showStats() {
        const summary = StorageManager.getSummary();
        
        this.dom.stats.todayGames.textContent = summary.totalGames;
        this.dom.stats.todayAccuracy.textContent = `${summary.accuracy}%`;
        this.dom.stats.todayAvgTime.textContent = `${summary.avgTime}秒`;

        const categoryAccuracy = StorageManager.getCategoryAccuracy();
        this.dom.stats.accuracyBars.innerHTML = '';
        
        categoryAccuracy.slice(0, 5).forEach(item => {
            const div = document.createElement('div');
            div.className = 'accuracy-bar-item';
            div.innerHTML = `
                <div class="accuracy-bar-label">${this.getCategoryDisplayName(item.category)}</div>
                <div class="accuracy-bar">
                    <div class="accuracy-bar-fill" style="width: ${item.accuracy}%"></div>
                    <div class="accuracy-bar-value">${item.accuracy}%</div>
                </div>
            `;
            this.dom.stats.accuracyBars.appendChild(div);
        });

        const weakCompounds = StorageManager.getWeakCompounds(5);
        this.dom.stats.weaknessList.innerHTML = '';
        
        weakCompounds.forEach(item => {
            const compound = this.engine.compounds.find(c => c.id === item.id);
            if (!compound) return;

            const div = document.createElement('div');
            div.className = 'weakness-item';
            div.innerHTML = `
                <div class="weakness-name">${compound.name}</div>
                <div class="weakness-rate">${item.accuracy}%</div>
            `;
            this.dom.stats.weaknessList.appendChild(div);
        });
    }

    /**
     * 設定を更新
     */
    updateSetting(key, value) {
        StorageManager.updateSetting(key, value);
        
        if (key === 'voiceEnabled' || key === 'voiceSpeed') {
            AudioManager.updateSettings({
                enabled: this.dom.settings.voice.checked,
                rate: parseFloat(this.dom.settings.voiceSpeed.value)
            });
        }
    }

    /**
     * 設定をロード
     */
    loadSettings() {
        const settings = StorageManager.loadSettings();
        if (!settings) return;

        this.dom.settings.voice.checked = settings.voiceEnabled;
        this.dom.settings.voiceSpeed.value = settings.voiceSpeed;
        this.dom.settings.cardCount.value = settings.cardCount;

        AudioManager.updateSettings({
            enabled: settings.voiceEnabled,
            rate: settings.voiceSpeed
        });
    }

    /**
     * 画面切り替え
     */
    showScreen(name) {
        Object.values(this.dom.screens).forEach(el => {
            if (el) el.classList.remove('active');
        });
        
        if (this.dom.screens[name]) {
            this.dom.screens[name].classList.add('active');
        }
    }

    /**
     * ローディング表示
     */
    showLoading(show) {
        if (show) {
            this.dom.loading.classList.add('active');
        } else {
            this.dom.loading.classList.remove('active');
        }
    }

    /**
     * タイマー開始
     */
    startTimer() {
        this.stopTimer();
        this.timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - this.gameStartTime) / 1000);
            const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const seconds = (elapsed % 60).toString().padStart(2, '0');
            this.dom.game.timer.textContent = `${minutes}:${seconds}`;
        }, 1000);
    }

    /**
     * タイマー停止
     */
    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    /**
     * ゲーム一時停止
     */
    pauseGame() {
        this.engine.pause();
        this.stopTimer();
        this.showScreen('pause');
    }

    /**
     * ゲーム再開
     */
    resumeGame() {
        this.engine.resume();
        this.startTimer();
        this.showScreen('game');
    }

    /**
     * ヒント表示
     */
    showHint() {
        const target = this.engine.currentRound.target;
        alert(`ヒント: ${this.getCategoryDisplayName(target.category)} / 分子式: ${target.formula}`);
    }

    /**
     * 難易度名を取得
     */
    getDifficultyName(level) {
        const names = {
            1: '初心者',
            2: '基礎',
            3: '標準',
            4: '上位',
            5: '難関大',
            6: '上級',
            7: '東大'
        };
        return names[level] || '標準';
    }

    /**
     * カテゴリ表示名を取得
     */
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
}

// アプリ起動
window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
    
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(err => {
            console.log('SW registration failed:', err);
        });
    }
});


