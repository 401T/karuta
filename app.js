class App {
    constructor() {
        this.engine = new GameEngine();
        this.currentMode = 'cpu';
        this.selectedDifficulty = 3;
        this.timerInterval = null;
        
        this.init();
    }

    async init() {
        // データ読み込み
        await this.engine.loadData();
        StructureRenderer.init();
        AudioManager.init();
        StorageManager.init();

        // 画面遷移イベント
        this.bindNavigation();
        
        // ローディング終了
        setTimeout(() => {
            document.getElementById('loading-screen').classList.remove('active');
            this.showScreen('screen-title');
        }, 1500);
    }

    bindNavigation() {
        // data-next 属性を持つボタン
        document.querySelectorAll('[data-next]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const nextScreen = e.currentTarget.dataset.next;
                const mode = e.currentTarget.dataset.mode;
                
                if (mode) this.currentMode = mode;
                
                // 難易度選択画面の場合は、選択状態を維持
                if (nextScreen === 'screen-difficulty') {
                    this.updateDifficultySelection();
                }
                
                this.showScreen(nextScreen);
            });
        });

        // 戻るボタン
        document.querySelectorAll('[data-back]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.showScreen(e.currentTarget.dataset.back);
            });
        });

        // 難易度カード
        document.querySelectorAll('.diff-card').forEach(card => {
            card.addEventListener('click', (e) => {
                document.querySelectorAll('.diff-card').forEach(c => c.classList.remove('selected'));
                e.currentTarget.classList.add('selected');
                this.selectedDifficulty = parseInt(e.currentTarget.dataset.level);
            });
        });

        // ゲーム開始（難易度選択画面でカードをクリックしたら開始）
        document.querySelectorAll('.diff-card').forEach(card => {
            card.addEventListener('dblclick', (e) => {
                // ダブルクリックで開始（誤操作防止）
                this.startGame();
            });
        });

        // ゲーム画面のボタン
        document.getElementById('btn-skip').addEventListener('click', () => {
            this.engine.skipRound();
        });

        document.getElementById('btn-pause').addEventListener('click', () => {
            this.showScreen('screen-title'); // 簡易的にタイトルへ戻る
        });

        // 設定
        document.getElementById('setting-voice').addEventListener('change', (e) => {
            AudioManager.updateSettings({ enabled: e.target.checked });
        });
    }

    updateDifficultySelection() {
        document.querySelectorAll('.diff-card').forEach(card => {
            card.classList.remove('selected');
            if (parseInt(card.dataset.level) === this.selectedDifficulty) {
                card.classList.add('selected');
            }
        });
    }

    startGame() {
        const settings = {
            mode: this.currentMode,
            cpuLevel: this.selectedDifficulty,
            cardCount: 9
        };

        this.engine.configure(settings);
        this.engine.startGame(10);

        this.showScreen('screen-game');
        this.startTimer();
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(screenId).classList.add('active');
    }

    startTimer() {
        let seconds = 0;
        this.timerInterval = setInterval(() => {
            seconds++;
            const m = Math.floor(seconds / 60).toString().padStart(2, '0');
            const s = (seconds % 60).toString().padStart(2, '0');
            document.getElementById('timer').textContent = `${m}:${s}`;
        }, 1000);
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});


