/**
 * GameEngine - ゲームの核となる状態管理とルール適用
 * 読み札履歴表示・ステージ自動進行対応
 */
class GameEngine {
    constructor() {
        this.state = 'IDLE';
        this.mode = 'cpu';
        
        this.compounds = [];
        this.clues = {};
        this.categories = new Set();
        
        this.currentRound = {
            target: null,
            cards: [],
            currentStage: 0,
            maxStage: 4,
            isActive: false,
            startTime: 0
        };
        
        this.scores = { player: 0, cpu: 0 };
        this.roundNumber = 0;
        this.totalRounds = 10;
        this.combo = 0;
        this.maxCombo = 0;
        
        this.cpu = null;
        
        this.settings = {
            cardCount: 9,
            cpuLevel: 3,
            categories: []
        };
        
        this.onUpdate = null;
        this.onRoundEnd = null;
        this.onGameEnd = null;
    }

    /**
     * データ読み込み
     */
    async loadData() {
        try {
            const [compRes, clueRes] = await Promise.all([
                fetch('data/compounds.json'),
                fetch('data/clues.json')
            ]);
            
            this.compounds = await compRes.json();
            const clueArray = await clueRes.json();
            
            clueArray.forEach(c => { 
                this.clues[c.compound_id] = c; 
            });
            
            this.compounds.forEach(c => {
                if (c.category) this.categories.add(c.category);
            });
            
            console.log(`Loaded ${this.compounds.length} compounds, ${Object.keys(this.clues).length} clues`);
            return true;
        } catch (e) {
            console.error('Data load error:', e);
            return false;
        }
    }

    /**
     * ゲーム設定
     */
    configure(settings) {
        this.settings = { ...this.settings, ...settings };
        
        if (settings.cpuLevel) {
            this.cpu = new CPUPlayer(settings.cpuLevel);
        }
        
        if (settings.mode) {
            this.mode = settings.mode;
        }
    }

    /**
     * ゲーム開始
     */
    startGame(totalRounds = 10) {
        this.totalRounds = totalRounds;
        this.roundNumber = 0;
        this.scores = { player: 0, cpu: 0 };
        this.combo = 0;
        this.maxCombo = 0;
        
        this._notify();
        this.startNewRound();
    }

    /**
     * 新ラウンド開始
     */
    startNewRound() {
        if (this.roundNumber >= this.totalRounds) {
            this.endGame();
            return;
        }
        
        this.roundNumber++;
        
        let candidates = this.compounds;
        if (this.settings.categories.length > 0) {
            candidates = candidates.filter(c => 
                this.settings.categories.includes(c.category)
            );
        }
        
        if (candidates.length === 0) {
            console.error('No candidates available');
            return;
        }
        
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        
        const others = this.compounds
            .filter(c => c.id !== target.id)
            .sort(() => Math.random() - 0.5)
            .slice(0, this.settings.cardCount - 1);
        
        const cards = [target, ...others].sort(() => Math.random() - 0.5);
        
        this.currentRound = {
            target: target,
            cards: cards,
            currentStage: 0,
            maxStage: this.clues[target.id] ? this.clues[target.id].stages.length : 4,
            isActive: true,
            startTime: Date.now()
        };
        
        this.state = 'DEAL';
        this._notify();
        
        setTimeout(() => this.nextClue(), 1500);
    }

    /**
     * 読み札を1段階進める（音声読み上げ終了後に自動進行）
     */
    nextClue() {
        if (!this.currentRound.isActive) return;
        
        this.currentRound.currentStage++;
        this.state = 'READING';
        
        const clueData = this.clues[this.currentRound.target.id];
        if (clueData) {
            const currentClue = clueData.stages.find(s => s.stage === this.currentRound.currentStage);
            if (currentClue) {
                AudioManager.playSound('stage');
                
                // 音声読み上げ + 終了時に次のステージへ自動進行
                AudioManager.speak(currentClue.text, {
                    onEnd: () => {
                        // まだラウンドがアクティブなら次のステージへ
                        if (this.currentRound.isActive) {
                            const hasNext = clueData.stages.some(
                                s => s.stage === this.currentRound.currentStage + 1
                            );
                            if (hasNext) {
                                // 1秒待ってから次のステージへ
                                setTimeout(() => this.nextClue(), 1000);
                            }
                        }
                    }
                });
            }
        }
        
        this._notify();
        
        // CPUの思考開始
        if (this.cpu && this.mode === 'cpu') {
            this.cpu.startThinking(
                this.currentRound.target.id,
                this.currentRound.cards,
                this.currentRound.currentStage,
                (actionType, cardId) => {
                    if (actionType === 'tap') {
                        this.handleCpuAnswer(cardId, true);
                    } else {
                        this.handleCpuAnswer(cardId, false);
                    }
                }
            );
        }
    }

    /**
     * プレイヤーのタップ処理
     */
    handlePlayerTap(cardId) {
        if (!this.currentRound.isActive) return;
        
        const isCorrect = (cardId === this.currentRound.target.id);
        const reactionTime = Date.now() - this.currentRound.startTime;
        
        if (isCorrect) {
            if (this.cpu) this.cpu.cancelThinking();
            
            this.combo++;
            if (this.combo > this.maxCombo) this.maxCombo = this.combo;
            
            this._calculateScore(true, this.currentRound.currentStage, 'player', reactionTime);
            AudioManager.playSound(this.combo > 1 ? 'combo' : 'correct');
            
            StorageManager.recordGameResult({
                isCorrect: true,
                time: reactionTime,
                compoundId: this.currentRound.target.id,
                category: this.currentRound.target.category
            });
            
            this._finishRound(true);
        } else {
            this.combo = 0;
            this._calculateScore(false, 0, 'player', reactionTime);
            AudioManager.playSound('wrong');
            
            StorageManager.recordGameResult({
                isCorrect: false,
                time: reactionTime,
                compoundId: this.currentRound.target.id,
                category: this.currentRound.target.category
            });
            
            this._notify({ type: 'wrong', id: cardId });
        }
    }

    /**
     * CPUの回答処理
     */
    handleCpuAnswer(cardId, isCorrect) {
        if (!this.currentRound.isActive) return;
        
        if (isCorrect) {
            this.currentRound.isActive = false;
            this.combo = 0;
            
            this._calculateScore(true, this.currentRound.currentStage, 'cpu', 0);
            AudioManager.playSound('wrong');
            
            this._finishRound(false);
        } else {
            this._notify({ type: 'cpu_wrong', id: cardId });
            AudioManager.playSound('wrong');
            
            setTimeout(() => this.nextClue(), 1500);
        }
    }

    /**
     * スコア計算
     */
    _calculateScore(isCorrect, stage, who = 'player', reactionTime = 0) {
        if (!isCorrect) {
            if (who === 'player') {
                this.scores.player = Math.max(0, this.scores.player - 50);
            }
            return;
        }
        
        const baseScore = 1000;
        const penalty = (stage - 1) * 200;
        let gained = Math.max(100, baseScore - penalty);
        
        const diffBonus = (this.currentRound.target.difficulty || 1) * 50;
        gained += diffBonus;
        
        if (who === 'player' && this.combo > 1) {
            const comboBonus = Math.min(this.combo * 50, 500);
            gained += comboBonus;
        }
        
        if (who === 'player' && reactionTime < 3000) {
            const speedBonus = Math.floor((3000 - reactionTime) / 100) * 10;
            gained += speedBonus;
        }
        
        if (who === 'player') {
            this.scores.player += gained;
        } else {
            this.scores.cpu += gained;
        }
        
        this._notify({ type: 'score_update', gained: gained });
    }

    /**
     * ラウンド終了処理
     */
    _finishRound(playerWon) {
        this.currentRound.isActive = false;
        this.state = 'RESULT';
        
        const clueData = this.clues[this.currentRound.target.id];
        
        this._notify({ 
            type: 'round_end', 
            playerWon: playerWon,
            target: this.currentRound.target,
            explanation: clueData ? clueData.explanation : '解説データなし',
            stage: this.currentRound.currentStage,
            combo: this.combo
        });
        
        if (this.onRoundEnd) {
            this.onRoundEnd({
                playerWon: playerWon,
                target: this.currentRound.target
            });
        }
    }

    /**
     * ゲーム終了
     */
    endGame() {
        this.state = 'IDLE';
        
        const summary = {
            totalRounds: this.totalRounds,
            playerScore: this.scores.player,
            cpuScore: this.scores.cpu,
            maxCombo: this.maxCombo,
            winner: this.scores.player > this.scores.cpu ? 'player' : 
                    this.scores.player < this.scores.cpu ? 'cpu' : 'draw'
        };
        
        this._notify({ type: 'game_end', summary: summary });
        
        if (this.onGameEnd) {
            this.onGameEnd(summary);
        }
    }

    /**
     * スキップ
     */
    skipRound() {
        if (!this.currentRound.isActive) return;
        
        if (this.cpu) this.cpu.cancelThinking();
        this.combo = 0;
        
        this._finishRound(false);
    }

    /**
     * 一時停止
     */
    pause() {
        if (this.cpu) this.cpu.cancelThinking();
        AudioManager.stop();
    }

    /**
     * 再開
     */
    resume() {
        // 必要に応じてCPUの思考を再開
    }

    /**
     * UI更新通知
     */
    _notify(data = {}) {
        if (this.onUpdate) {
            this.onUpdate({
                state: this.state,
                mode: this.mode,
                round: this.currentRound,
                scores: this.scores,
                roundNumber: this.roundNumber,
                totalRounds: this.totalRounds,
                combo: this.combo,
                maxCombo: this.maxCombo,
                ...data
            });
        }
    }

    /**
     * 利用可能なカテゴリ一覧を取得
     */
    getCategories() {
        return Array.from(this.categories).sort();
    }

    /**
     * 化合物数を取得
     */
    getCompoundCount() {
        return this.compounds.length;
    }
}


