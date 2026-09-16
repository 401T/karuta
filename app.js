/**
 * App - メインアプリケーションクラス
 * UI制御、画面遷移、イベント処理、統計表示を統合管理
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
                formula: document.getElementById('result-formula'),
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
        // ローディング表示
        this.showLoading(true);

        // データ読み込み
        const loaded = await this.engine.loadData();
        
        if (!loaded) {
            alert('データの読み込みに失敗しました。');
            return;
        }

        // 構造式描画エンジンの初期化
        StructureRenderer.init();
        
        // 音声マネージャーの初期化
        AudioManager.init();

        // ストレージマネージャーの初期化
        StorageManager.init();

        // 設定をロード
        this.loadSettings();

        // UI更新コールバックの設定
        this.engine.onUpdate = (data) => this.updateGameUI(data);
        this.engine.onRoundEnd = (data) => this.showResult(data);
        this.engine.onGameEnd = (data) => this.showGameEnd(data);

        // イベント設定
        this.bindEvents();

        // メニューの化合物数表示
        this.dom.menu.compoundCount.textContent = this.engine.getCompoundCount();

        // ローディング非表示
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
        // メニューボタン
        document.querySelectorAll('.menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const mode = e.currentTarget.dataset.mode;
                this.handleMenuClick(mode);
            });
        });

        // 戻るボタン
        document.querySelectorAll('.back-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.showScreen('menu');
            });
        });

        // ゲーム設定画面
        this.dom.setup.startBtn.addEventListener('click', () => {
            this.startGame();
        });

        // ゲーム画面
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

        // 結果画面
        this.dom.result.nextBtn.addEventListener('click', () => {
            this.showScreen('game');
            this.engine.startNewRound();
        });

        this.dom.result.finishBtn.addEventListener('click', () => {
            this.showScreen('menu');
        });

        // 一時停止画面
        document.getElementById('btn-resume').addEventListener('click', () => {
            this.resumeGame();
        });

        document.getElementById('btn-quit').addEventListener('click', () => {
            this.showScreen('menu');
        });

        // 設定画面
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
            if (confirm('統計データをリセットしますか？')) {
                StorageManager.resetAll();
                alert('リセットしました。');
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
            training: '構造決定トレーニング'
        };

        this.dom.setup.title.textContent = titles[mode] || 'ゲーム設定';

        // 難易度選択
        this.dom.setup.difficultyGrid.innerHTML = '';
        for (let i = 1; i <= 7; i++) {
            const btn = document.createElement('button');
            btn.className = 'difficulty-btn' + (i === this.selectedDifficulty ? ' selected' : '');
            btn.innerHTML = `
                <div class="difficulty-level">Lv.${i}</div>
                <div class="difficulty-name">${this.getDifficultyName(i)}</div>
            `;
            btn.addEventListener('click', () => {
                this.selectedDifficulty = i;
                document.querySelectorAll('.difficulty-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
            });
            this.dom.setup.difficultyGrid.appendChild(btn);
        }

        // カテゴリ選択
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
        // スコア更新
        this.dom.game.scorePlayer.textContent = data.scores.player;
        this.dom.game.scoreCpu.textContent = data.scores.cpu;

        // ラウンド情報
        this.dom.game.roundInfo.textContent = `${data.roundNumber} / ${data.totalRounds}`;

        // コンボ表示
        if (data.combo > 1) {
            this.dom.game.combo.textContent = `${data.combo} COMBO!`;
        } else {
            this.dom.game.combo.textContent = '';
        }

        // 状態ごとの処理
        switch (data.state) {
            case 'DEAL':
                this.renderCards(data.round.cards);
                this.dom.game.clueStage.textContent = '準備中...';
                this.dom.game.clueText.textContent = '読み札が始まります';
                break;

            case 'READING':
                this.updateClue(data.round);
                break;

            case 'RESULT':
                this.stopTimer();
                break;
        }

        // フィードバック
        if (data.type === 'wrong') {
            this.flashCard(data.id, 'wrong');
        } else if (data.type === 'cpu_wrong') {
            this.flashCard(data.id, 'wrong');
        }
    }

    /**
     * カードを描画
     */
    renderCards(cards) {
        this.dom.game.cardGrid.innerHTML = '';

        cards.forEach(c => {
            const div = document.createElement('div');
            div.className = 'card';
            div.dataset.id = c.id;

            const svgContainer = document.createElement('div');
            svgContainer.style.width = '100%';
            svgContainer.style.height = '100%';
            div.appendChild(svgContainer);

            this.dom.game.cardGrid.appendChild(div);

            // 非同期で構造式を描画
            requestAnimationFrame(() => {
                StructureRenderer.render(svgContainer, c.smiles, 'light');
            });
        });
    }

    /**
     * 読み札を更新
     */
    updateClue(round) {
        const clueData = this.engine.clues[round.target.id];
        if (!clueData) return;

        const currentStageData = clueData.stages.find(s => s.stage === round.currentStage);
        if (currentStageData) {
            this.dom.game.clueStage.textContent = `STAGE ${round.currentStage}`;
            this.dom.game.clueText.textContent = currentStageData.text;
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
            ? 'var(--accent-gradient)' 
            : 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';

        this.dom.result.title.textContent = playerWon ? '正解！' : '不正解...';
        this.dom.result.title.style.color = playerWon ? 'var(--success)' : 'var(--danger)';

        // スコア表示（プレイヤーが正解した場合のみ）
        if (playerWon) {
            const gained = this.engine.scores.player - (this.engine.scores.player - 1000); // 簡易計算
            this.dom.result.score.textContent = `+${gained}`;
        } else {
            this.dom.result.score.textContent = '';
        }

        // 構造式表示
        this.dom.result.structure.innerHTML = '';
        const svgContainer = document.createElement('div');
        svgContainer.style.width = '100%';
        svgContainer.style.height = '150px';
        this.dom.result.structure.appendChild(svgContainer);
        StructureRenderer.render(svgContainer, data.target.smiles, 'light');

        // 詳細情報
        this.dom.result.name.textContent = data.target.name;
        this.dom.result.formula.textContent = data.target.formula;
        
        const reactionTime = ((Date.now() - this.engine.currentRound.startTime) / 1000).toFixed(2);
        this.dom.result.time.textContent = `${reactionTime}s`;

        // 解説
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
        
        alert(`ゲーム終了\n${message}\n\nプレイヤー: ${data.playerScore}点\nCPU: ${data.cpuScore}点\n最大コンボ: ${data.maxCombo}`);
        
        this.showScreen('menu');
    }

    /**
     * 統計表示
     */
    showStats() {
        const summary = StorageManager.getSummary();
        
        this.dom.stats.todayGames.textContent = summary.totalGames;
        this.dom.stats.todayAccuracy.textContent = `${summary.accuracy}%`;
        this.dom.stats.todayAvgTime.textContent = `${summary.avgTime}s`;

        // 分野別正答率
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

        // 苦手分野
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
     * ヒント表示（簡易実装）
     */
    showHint() {
        const target = this.engine.currentRound.target;
        alert(`ヒント: ${target.category} / 分子式: ${target.formula}`);
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
            nucleobase: '核酸塩基'
        };
        return names[category] || category;
    }
}

// アプリ起動
window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
    
    // Service Worker登録 (PWA)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(err => {
            console.log('SW registration failed:', err);
        });
    }
});

