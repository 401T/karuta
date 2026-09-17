/**
 * App - メインアプリケーションクラス
 * 画面遷移、ゲーム制御、UI更新を統合管理
 */
class App {
    constructor() {
        this.engine = new GameEngine();
        this.currentMode = 'cpu';
        this.selectedDifficulty = 3;
        this.timerInterval = null;
        this.gameStartTime = 0;
        this.lastTapTime = 0;
        
        this.init();
    }

    async init() {
        // データ読み込み
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
        this.engine.onRoundEnd = (data) => this.showRoundResult(data);
        this.engine.onGameEnd = (data) => this.showGameEnd(data);

        this.bindEvents();
        
        document.getElementById('compound-count').textContent = this.engine.getCompoundCount();

        setTimeout(() => {
            document.getElementById('loading-screen').classList.remove('active');
            this.showScreen('screen-title');
        }, 1500);
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

        // 難易度カード (シングルタップで選択、ダブルタップで開始)
        document.querySelectorAll('.diff-card').forEach(card => {
            card.addEventListener('click', (e) => {
                const now = Date.now();
                const timeDiff = now - this.lastTapTime;
                
                document.querySelectorAll('.diff-card').forEach(c => c.classList.remove('selected'));
                e.currentTarget.classList.add('selected');
                this.selectedDifficulty = parseInt(e.currentTarget.dataset.level);
                
                if (timeDiff < 300 && timeDiff > 0) {
                    // ダブルタップ detected
                    this.startGame();
                }
                
                this.lastTapTime = now;
            });
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
            cardCount: StorageManager.loadSettings().cardCount || 9,
            categories: []
        };

        this.engine.configure(settings);
        this.engine.startGame(10);

        this.showScreen('screen-game');
        this.startTimer();
    }

    async updateGameUI(data) {
        document.getElementById('score-player').textContent = data.scores.player;
        document.getElementById('score-cpu').textContent = data.scores.cpu;
        document.getElementById('round-info').textContent = `${data.roundNumber} / ${data.totalRounds}`;

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

    updateClueWithHistory(round) {
        const clueData = this.engine.clues[round.target.id];
        if (!clueData) return;

        const currentStageData = clueData.stages.find(s => s.stage === round.currentStage);
        
        if (currentStageData) {
            document.getElementById('clue-stage').textContent = `STAGE ${round.currentStage}`;
            document.getElementById('clue-text').textContent = currentStageData.text;

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
                    
                    const cluePanel = document.querySelector('.clue-panel');
                    if (cluePanel) {
                        cluePanel.scrollTop = cluePanel.scrollHeight;
                    }
                }
            }

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
        
        // 動的に結果モーダルを生成
        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.innerHTML = `
            <div class="modal-content" style="background: rgba(15, 20, 25, 0.95); border: 2px solid ${playerWon ? 'var(--success)' : 'var(--danger)'}; border-radius: 16px; padding: 30px; max-width: 400px; width: 90%; text-align: center; box-shadow: 0 0 40px ${playerWon ? 'rgba(0,255,136,0.3)' : 'rgba(255,51,102,0.3)'};">
                <h2 style="font-size: 2rem; margin-bottom: 20px; color: ${playerWon ? 'var(--success)' : 'var(--danger)'};">${playerWon ? '正解!' : '不正解...'}</h2>
                <div style="background: rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; margin-bottom: 20px; min-height: 150px; display: flex; align-items: center; justify-content: center;">
                    <div id="modal-structure" style="width: 100%; height: 100%;"></div>
                </div>
                <div style="font-size: 1.2rem; margin-bottom: 10px; color: var(--text-white);">${compound.name}</div>
                <div style="font-size: 0.9rem; color: var(--text-gray); margin-bottom: 20px;">${compound.formula}</div>
                <div style="font-size: 0.9rem; color: var(--text-gray); line-height: 1.6; margin-bottom: 30px; text-align: left; background: rgba(0,240,255,0.05); padding: 15px; border-radius: 8px; border-left: 3px solid var(--accent-cyan);">${data.explanation}</div>
                <button class="btn btn-primary" id="modal-next-btn" style="width: 100%;">次の問題へ</button>
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
        
        const message = data.winner === 'player' ? '勝利!' : 
                       data.winner === 'cpu' ? '敗北...' : '引き分け';
        
        const modal = document.createElement('div');
        modal.className = 'screen active modal-screen';
        modal.style.zIndex = '1000';
        modal.innerHTML = `
            <div class="modal-content" style="background: rgba(15, 20, 25, 0.95); border: 2px solid var(--accent-cyan); border-radius: 16px; padding: 30px; max-width: 400px; width: 90%; text-align: center;">
                <h2 style="font-size: 2rem; margin-bottom: 20px; color: var(--accent-cyan);">ゲーム終了</h2>
                <div style="font-size: 1.5rem; margin-bottom: 20px; color: var(--text-white);">${message}</div>
                <div style="display: flex; justify-content: space-around; margin-bottom: 30px;">
                    <div>
                        <div style="font-size: 0.8rem; color: var(--text-gray);">PLAYER</div>
                        <div style="font-size: 1.8rem; color: var(--accent-cyan); font-family: 'Orbitron';">${data.playerScore}</div>
                    </div>
                    <div>
                        <div style="font-size: 0.8rem; color: var(--text-gray);">CPU</div>
                        <div style="font-size: 1.8rem; color: var(--accent-pink); font-family: 'Orbitron';">${data.cpuScore}</div>
                    </div>
                </div>
                <button class="btn btn-primary" id="modal-finish-btn" style="width: 100%;">タイトルへ戻る</button>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        document.getElementById('modal-finish-btn').addEventListener('click', () => {
            modal.remove();
            this.showScreen('screen-title');
        });
    }

    showHint() {
        const target = this.engine.currentRound.target;
        alert(`ヒント: ${target.category} / 分子式: ${target.formula}`);
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
            const elapsed = Math.floor((Date.now() - this.gameStartTime) / 1000);
            const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const seconds = (elapsed % 60).toString().padStart(2, '0');
            document.getElementById('timer').textContent = `${minutes}:${seconds}`;
        }, 1000);
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
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
    window.app = new App();
});


