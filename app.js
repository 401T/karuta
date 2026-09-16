/**
 * メインアプリケーションクラス
 */
class App {
    constructor() {
        this.engine = new GameEngine();
        this.speechEnabled = false;
        this.speechRate = 1.0;
        
        // DOM要素のキャッシュ
        this.dom = {
            screens: {
                menu: document.getElementById('screen-menu'),
                game: document.getElementById('screen-game'),
                result: document.getElementById('screen-result')
            },
            game: {
                grid: document.getElementById('card-grid'),
                scorePlayer: document.getElementById('score-player'),
                scoreCpu: document.getElementById('score-cpu'),
                clueText: document.getElementById('clue-text'),
                clueStage: document.getElementById('clue-stage'),
                timer: document.getElementById('timer'),
                combo: document.getElementById('combo')
            },
            result: {
                title: document.getElementById('result-title'),
                structure: document.getElementById('result-structure'),
                explanation: document.getElementById('result-explanation')
            },
            buttons: {
                hint: document.getElementById('btn-hint'),
                nextClue: document.getElementById('btn-next-clue'),
                backMenu: document.getElementById('btn-back-menu')
            }
        };

        this.init();
    }

    async init() {
        // データ読み込み
        const loaded = await this.engine.loadData();
        if (!loaded) {
            alert("データの読み込みに失敗しました。");
            return;
        }

        // イベント設定
        this.bindEvents();

        // TTS（音声読み上げ）の準備
        if ('speechSynthesis' in window) {
            this.speechEnabled = true;
        }

        // UIコールバックの設定
        this.engine.onUpdateUI = (data) => this.updateUI(data);

        console.log("App initialized.");
    }

    bindEvents() {
        // メニューボタン
        document.querySelectorAll('.menu-buttons .btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const mode = e.target.dataset.mode;
                this.startGame(mode);
            });
        });

        // ゲーム画面のカードタップ（イベントデリゲーション）
        this.dom.game.grid.addEventListener('click', (e) => {
            const card = e.target.closest('.card');
            if (card && !card.classList.contains('taken')) {
                const id = card.dataset.id;
                this.handleCardTap(id, card);
            }
        });

        // 結果画面のボタン
        this.dom.buttons.backMenu.addEventListener('click', () => {
            this.showScreen('menu');
        });

        // ヒント/次へボタン（練習モード用など）
        this.dom.buttons.nextClue.addEventListener('click', () => {
            if (this.engine.state === 'PLAYING' || this.engine.state === 'READING') {
                this.engine.nextClue();
            }
        });
    }

    startGame(mode) {
        // 設定（デフォルトではCPU Lv3）
        this.engine.configure({ cpuLevel: 3 });
        
        this.showScreen('game');
        this.resetGameUI();
        
        // 最初のラウンド開始
        this.engine.startNewRound();
    }

    resetGameUI() {
        this.dom.game.grid.innerHTML = '';
        this.dom.game.scorePlayer.innerText = '0';
        this.dom.game.scoreCpu.innerText = '0';
        this.dom.game.clueText.innerText = '準備中...';
        this.dom.game.clueStage.innerText = '';
    }

    /**
     * UI更新処理 (GameEngineからのコールバック)
     */
    updateUI(data) {
        // スコア更新
        this.dom.game.scorePlayer.innerText = data.scores.player;
        this.dom.game.scoreCpu.innerText = data.scores.cpu;

        // 状態ごとの処理
        switch (data.state) {
            case 'DEAL':
                this.renderCards(data.round.cards);
                this.dom.game.clueText.innerText = '読み札が始まります...';
                break;

            case 'READING':
                this.updateClue(data.round);
                break;

            case 'RESULT':
                this.showResult(data);
                break;
        }

        // フィードバック処理
        if (data.type === 'wrong') {
            this.flashCard(data.id, 'wrong');
        } else if (data.type === 'cpu_wrong') {
            this.flashCard(data.id, 'wrong');
        }
    }

    /**
     * カードを並べる
     */
    renderCards(cards) {
        this.dom.game.grid.innerHTML = '';
        cards.forEach(c => {
            const div = document.createElement('div');
            div.className = 'card';
            div.dataset.id = c.id;
            
            // 構造式描画
            const svgContainer = document.createElement('div');
            svgContainer.style.width = '100%';
            svgContainer.style.height = '100%';
            div.appendChild(svgContainer);
            
            this.dom.game.grid.appendChild(div);
            
            // 非同期描画
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
            this.dom.game.clueStage.innerText = `STAGE ${round.currentStage}`;
            this.dom.game.clueText.innerText = currentStageData.text;
            
            // 音声読み上げ
            this.speak(currentStageData.text);
        }
    }

    /**
     * カードタップ処理
     */
    handleCardTap(id, element) {
        this.engine.handlePlayerTap(id);
        
        // 正解時のエフェクト
        const isCorrect = (id === this.engine.currentRound.target.id);
        if (isCorrect) {
            element.classList.add('correct');
            setTimeout(() => element.classList.add('taken'), 500);
        }
    }

    /**
     * カードのフラッシュエフェクト
     */
    flashCard(id, type) {
        const card = document.querySelector(`.card[data-id="${id}"]`);
        if (card) {
            card.classList.add(type);
            setTimeout(() => card.classList.remove(type), 500);
        }
    }

    /**
     * 結果画面表示
     */
    showResult(data) {
        this.dom.result.title.innerText = data.playerWon ? '正解！ (Get!)' : 'CPUに先越された...';
        this.dom.result.title.style.color = data.playerWon ? 'var(--success-color)' : 'var(--danger-color)';
        
        // 正解の構造式表示
        this.dom.result.structure.innerHTML = '';
        const svgContainer = document.createElement('div');
        svgContainer.style.width = '100%';
        svgContainer.style.height = '150px';
        this.dom.result.structure.appendChild(svgContainer);
        StructureRenderer.render(svgContainer, data.target.smiles, 'light');

        // 解説表示
        this.dom.result.explanation.innerText = data.explanation;

        this.showScreen('result');
    }

    /**
     * 画面切り替え
     */
    showScreen(name) {
        Object.values(this.dom.screens).forEach(el => el.classList.remove('active'));
        this.dom.screens[name].classList.add('active');
    }

    /**
     * 音声読み上げ (TTS)
     */
    speak(text) {
        if (!this.speechEnabled) return;
        
        // 既存の読み上げをキャンセル
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ja-JP';
        utterance.rate = this.speechRate;
        
        // 日本語音声が見つからない場合はデフォルト
        const voices = window.speechSynthesis.getVoices();
        const jpVoice = voices.find(v => v.lang.startsWith('ja'));
        if (jpVoice) utterance.voice = jpVoice;

        window.speechSynthesis.speak(utterance);
    }
}

// アプリ起動
window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
    
    // Service Worker登録 (PWA)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(err => {
            console.log("SW registration failed:", err);
        });
    }
});
