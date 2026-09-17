/**
 * GameEngine - ゲームの核となる状態管理とルール適用
 * オンラインモード対応版
 * 
 * 【状態遷移】
 * IDLE → DEAL → (カード画像読み込み完了待ち) → READING → PLAYING → RESULT → (next round or end)
 * 
 * 【オンラインモード】
 * - ホストのみがゲームロジックを実行
 * - ゲストはFirebaseから状態を取得して同期
 * - 得点計算・統計記録はホストのみ
 */
class GameEngine {
    constructor() {
        this.state = 'IDLE';
        this.mode = 'cpu';
        this.isOnline = false;
        this.isHost = false;
        
        // データ
        this.compounds = [];
        this.clues = {};
        this.categories = new Set();
        
        // ラウンド状態
        this.currentRound = {
            target: null,
            cards: [],
            currentStage: 0,
            maxStage: 4,
            isActive: false,
            startTime: 0
        };
        
        // ゲーム全体状態
        this.scores = { player: 0, opponent: 0 };
        this.roundNumber = 0;
        this.totalRounds = 10;
        this.combo = 0;
        this.maxCombo = 0;
        
        // CPU
        this.cpu = null;
        
        // 設定
        this.settings = {
            cardCount: 9,
            cpuLevel: 3,
            categories: []
        };
        
        // コールバック
        this.onUpdate = null;
        this.onRoundEnd = null;
        this.onGameEnd = null;
        this.onOnlineStateChange = null; // オンライン用コールバック
    }

    /**
     * オブジェクトのキー名と文字列値を再帰的にトリム
     */
    _trimObject(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        
        if (Array.isArray(obj)) {
            return obj.map(item => this._trimObject(item));
        }
        
        const trimmed = {};
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                const trimmedKey = key.trim();
                const value = obj[key];
                
                if (typeof value === 'string') {
                    trimmed[trimmedKey] = value.trim();
                } else if (Array.isArray(value)) {
                    trimmed[trimmedKey] = value.map(v => 
                        typeof v === 'string' ? v.trim() : v
                    );
                } else if (typeof value === 'object' && value !== null) {
                    trimmed[trimmedKey] = this._trimObject(value);
                } else {
                    trimmed[trimmedKey] = value;
                }
            }
        }
        return trimmed;
    }

    /**
     * データ読み込み（キー名トリム対応）
     */
    async loadData() {
        try {
            const basePath = window.location.pathname.endsWith('/') 
                ? window.location.pathname 
                : window.location.pathname + '/';
            
            console.log('Loading data from:', basePath + 'data/');
            
            const [compRes, clueRes] = await Promise.all([
                fetch(basePath + 'data/compounds.json'),
                fetch(basePath + 'data/clues.json')
            ]);
            
            if (!compRes.ok) {
                throw new Error(`compounds.json not found: ${compRes.status}`);
            }
            if (!clueRes.ok) {
                throw new Error(`clues.json not found: ${clueRes.status}`);
            }
            
            const rawCompounds = await compRes.json();
            const rawClues = await clueRes.json();
            
            this.compounds = rawCompounds.map(c => this._trimObject(c));
            const trimmedClues = rawClues.map(c => this._trimObject(c));
            
            trimmedClues.forEach(c => { 
                if (c.compound_id) {
                    this.clues[c.compound_id] = c; 
                }
            });
            
            this.compounds.forEach(c => {
                if (c.category) this.categories.add(c.category);
            });
            
            console.log(`✓ Loaded ${this.compounds.length} compounds, ${Object.keys(this.clues).length} clues`);
            return true;
        } catch (e) {
            console.error('✗ Data load error:', e);
            return false;
        }
    }

    /**
     * ゲーム設定
     */
    configure(settings) {
        this.settings = { ...this.settings, ...settings };
        
        if (settings.isOnline !== undefined) {
            this.isOnline = settings.isOnline;
        }
        
        if (settings.isHost !== undefined) {
            this.isHost = settings.isHost;
        }
        
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
        this.scores = { player: 0, opponent: 0 };
        this.combo = 0;
        this.maxCombo = 0;
        
        this._notify();
        this.startNewRound();
    }

    /**
     * 新ラウンド開始
     * オンラインモード時、ホストのみがカード配列を生成
     */
    startNewRound() {
        if (this.roundNumber >= this.totalRounds) {
            this.endGame();
            return;
        }
        
        this.roundNumber++;
        
        // 1. 正解をランダムに選ぶ
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
        
        // 2. 場のカードを作る
        const others = this.compounds
            .filter(c => c.id !== target.id)
            .sort(() => Math.random() - 0.5)
            .slice(0, this.settings.cardCount - 1);
        
        const cards = [target, ...others].sort(() => Math.random() - 0.5);
        
        // 3. ラウンド状態初期化
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
        
        // オンラインモード時、ホストは状態をFirebaseに保存
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'round_start',
                round: this.roundNumber,
                totalRounds: this.totalRounds,
                cards: cards,
                target: target,
                scores: this.scores
            });
        }
    }

    /**
     * 読み札を開始
     */
    startReading() {
        if (!this.currentRound.isActive) return;
        if (this.state !== 'DEAL') return;
        
        console.log('All cards loaded - starting reading');
        
        setTimeout(() => this.nextClue(), 1500);
    }

    /**
     * 読み札を1段階進める
     * オンラインモード時、ホストのみがstageを進める
     */
    nextClue() {
        if (!this.currentRound.isActive) return;
        
        // オンラインモードでゲストの場合は何もしない
        if (this.isOnline && !this.isHost) return;
        
        this.currentRound.currentStage++;
        this.state = 'READING';
        
        const clueData = this.clues[this.currentRound.target.id];
        if (clueData) {
            const currentClue = clueData.stages.find(s => s.stage === this.currentRound.currentStage);
            if (currentClue) {
                AudioManager.playSound('stage');
                
                AudioManager.speak(currentClue.text, {
                    onEnd: () => {
                        if (this.currentRound.isActive) {
                            const hasNext = clueData.stages.some(
                                s => s.stage === this.currentRound.currentStage + 1
                            );
                            if (hasNext) {
                                setTimeout(() => this.nextClue(), 1000);
                            }
                        }
                    }
                });
            }
        }
        
        this._notify();
        
        // オンラインモード時、ホストは状態をFirebaseに保存
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'stage_update',
                currentStage: this.currentRound.currentStage,
                target: this.currentRound.target
            });
        }
        
        // オンラインモード時はCPUを起動しない
        if (this.cpu && this.mode === 'cpu' && !this.isOnline) {
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
     * オンラインモード時、ホストのみが正誤判定と得点計算を行う
     */
    handlePlayerTap(cardId) {
        if (!this.currentRound.isActive) return;
        
        const isCorrect = (cardId === this.currentRound.target.id);
        const reactionTime = Date.now() - this.currentRound.startTime;
        
        if (isCorrect) {
            // オンラインモード時、ホストのみが得点計算
            if (!this.isOnline || this.isHost) {
                if (this.cpu) this.cpu.cancelThinking();
                
                this.combo++;
                if (this.combo > this.maxCombo) this.maxCombo = this.combo;
                
                this._calculateScore(true, this.currentRound.currentStage, 'player', reactionTime);
                AudioManager.playSound(this.combo > 1 ? 'combo' : 'correct');
                
                // 統計記録（オフライン時のみ）
                if (!this.isOnline) {
                    StorageManager.recordGameResult({
                        isCorrect: true,
                        time: reactionTime,
                        compoundId: this.currentRound.target.id,
                        category: this.currentRound.target.category
                    });
                }
                
                this._finishRound(true);
            }
        } else {
            // 誤答
            if (!this.isOnline || this.isHost) {
                this.combo = 0;
                this._calculateScore(false, 0, 'player', reactionTime);
                AudioManager.playSound('wrong');
                
                if (!this.isOnline) {
                    StorageManager.recordGameResult({
                        isCorrect: false,
                        time: reactionTime,
                        compoundId: this.currentRound.target.id,
                        category: this.currentRound.target.category
                    });
                }
                
                this._notify({ type: 'wrong', id: cardId });
            }
        }
        
        // オンラインモード時、ホストはタップ結果をFirebaseに保存
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'player_tap',
                cardId: cardId,
                isCorrect: isCorrect
            });
        }
    }

    /**
     * CPUの回答処理（オンラインモードでは使用しない）
     */
    handleCpuAnswer(cardId, isCorrect) {
        if (!this.currentRound.isActive) return;
        
        if (isCorrect) {
            this.currentRound.isActive = false;
            this.combo = 0;
            
            this._calculateScore(true, this.currentRound.currentStage, 'opponent', 0);
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
            this.scores.opponent += gained;
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
                target: this.currentRound.target,
                explanation: explanation
            });
        }
        
        // オンラインモード時、ホストは結果をFirebaseに保存
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'round_end',
                playerWon: playerWon,
                scores: this.scores
            });
        }
        
        if (this.onRoundEnd) {
            this.onRoundEnd({
                playerWon: playerWon,
                target: this.currentRound.target,
                explanation: explanation
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
            cpuScore: this.scores.opponent,
            maxCombo: this.maxCombo,
            winner: this.scores.player > this.scores.opponent ? 'player' : 
                    this.scores.player < this.scores.opponent ? 'opponent' : 'draw'
        };
        
        this._notify({ type: 'game_end', summary: summary });
        
        // オンラインモード時、ホストは最終結果をFirebaseに保存
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'game_end',
                scores: this.scores
            });
        }
        
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