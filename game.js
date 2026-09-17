/**
 * GameEngine - ゲームの核となる状態管理とルール適用
 * オンライン同期・停止バグ修正版
 */
class GameEngine {
    constructor() {
        this.state = 'IDLE';
        this.mode = 'cpu';
        this.isOnline = false;
        this.isHost = false;
        
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
        
        this.scores = { player: 0, opponent: 0 };
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
        this.onOnlineStateChange = null;
    }

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
                    trimmed[trimmedKey] = value.map(v => typeof v === 'string' ? v.trim() : v);
                } else if (typeof value === 'object' && value !== null) {
                    trimmed[trimmedKey] = this._trimObject(value);
                } else {
                    trimmed[trimmedKey] = value;
                }
            }
        }
        return trimmed;
    }

    async loadData() {
        try {
            const basePath = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname + '/';
            const [compRes, clueRes] = await Promise.all([
                fetch(basePath + 'data/compounds.json'),
                fetch(basePath + 'data/clues.json')
            ]);
            
            if (!compRes.ok) throw new Error(`compounds.json: ${compRes.status}`);
            if (!clueRes.ok) throw new Error(`clues.json: ${clueRes.status}`);
            
            const rawCompounds = await compRes.json();
            const rawClues = await clueRes.json();
            
            this.compounds = rawCompounds.map(c => this._trimObject(c));
            const trimmedClues = rawClues.map(c => this._trimObject(c));
            
            trimmedClues.forEach(c => { 
                if (c.compound_id) this.clues[c.compound_id] = c; 
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

    configure(settings) {
        this.settings = { ...this.settings, ...settings };
        if (settings.isOnline !== undefined) this.isOnline = settings.isOnline;
        if (settings.isHost !== undefined) this.isHost = settings.isHost;
        if (settings.cpuLevel) this.cpu = new CPUPlayer(settings.cpuLevel);
        if (settings.mode) this.mode = settings.mode;
    }

    startGame(totalRounds = 10) {
        this.totalRounds = totalRounds;
        this.roundNumber = 0;
        this.scores = { player: 0, opponent: 0 };
        this.combo = 0;
        this.maxCombo = 0;
        this._notify();
        this.startNewRound();
    }

    startNewRound() {
        if (this.roundNumber >= this.totalRounds) {
            this.endGame();
            return;
        }
        
        this.roundNumber++;
        
        let candidates = this.compounds;
        if (this.settings.categories.length > 0) {
            candidates = candidates.filter(c => this.settings.categories.includes(c.category));
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
        
        // オンラインモードでホストの場合、状態を通知
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

    startReading() {
        if (!this.currentRound.isActive) return;
        if (this.state !== 'DEAL') return;
        setTimeout(() => this.nextClue(), 1500);
    }

    nextClue() {
        if (!this.currentRound.isActive) return;
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
                            const hasNext = clueData.stages.some(s => s.stage === this.currentRound.currentStage + 1);
                            if (hasNext) {
                                setTimeout(() => this.nextClue(), 1000);
                            }
                        }
                    }
                });
            }
        }
        
        this._notify();
        
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'stage_update',
                currentStage: this.currentRound.currentStage,
                target: this.currentRound.target
            });
        }
        
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

    handlePlayerTap(cardId) {
        if (!this.currentRound.isActive) return;
        
        const targetId = (this.currentRound.target.id || '').trim();
        const tapId = (cardId || '').trim();
        const isCorrect = (tapId === targetId);
        const reactionTime = Date.now() - this.currentRound.startTime;
        
        if (isCorrect) {
            if (!this.isOnline || this.isHost) {
                if (this.cpu) this.cpu.cancelThinking();
                this.combo++;
                if (this.combo > this.maxCombo) this.maxCombo = this.combo;
                this._calculateScore(true, this.currentRound.currentStage, 'player', reactionTime);
                AudioManager.playSound(this.combo > 1 ? 'combo' : 'correct');
                
                if (!this.isOnline) {
                    try {
                        StorageManager.recordGameResult({
                            isCorrect: true,
                            time: reactionTime,
                            compoundId: targetId,
                            category: this.currentRound.target.category || '',
                            difficulty: this.settings.cpuLevel || this.currentRound.target.difficulty || 1,
                            stage: this.currentRound.currentStage,
                            combo: this.combo
                        });
                    } catch (e) {
                        console.error('Storage error:', e);
                    }
                }
                this._finishRound(true);
            }
        } else {
            if (!this.isOnline || this.isHost) {
                this.combo = 0;
                this._calculateScore(false, 0, 'player', reactionTime);
                AudioManager.playSound('wrong');
                
                if (!this.isOnline) {
                    try {
                        StorageManager.recordGameResult({
                            isCorrect: false,
                            time: reactionTime,
                            compoundId: targetId,
                            category: this.currentRound.target.category || '',
                            difficulty: this.settings.cpuLevel || this.currentRound.target.difficulty || 1,
                            stage: this.currentRound.currentStage,
                            combo: 0
                        });
                    } catch (e) {
                        console.error('Storage error:', e);
                    }
                }
                this._notify({ type: 'wrong', id: tapId });
                // 誤答時の自動 nextClue を削除（オンライン同期を乱すため）
            }
        }
        
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'player_tap',
                cardId: tapId,
                isCorrect: isCorrect
            });
        }
    }

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

    _calculateScore(isCorrect, stage, who = 'player', reactionTime = 0) {
        if (!isCorrect) {
            if (who === 'player') this.scores.player = Math.max(0, this.scores.player - 50);
            return;
        }
        
        const baseScore = 1000;
        const penalty = (stage - 1) * 200;
        let gained = Math.max(100, baseScore - penalty);
        const diffBonus = (this.currentRound.target.difficulty || 1) * 50;
        gained += diffBonus;
        
        if (who === 'player' && this.combo > 1) {
            gained += Math.min(this.combo * 50, 500);
        }
        if (who === 'player' && reactionTime < 3000) {
            gained += Math.floor((3000 - reactionTime) / 100) * 10;
        }
        
        if (who === 'player') {
            this.scores.player += gained;
        } else {
            this.scores.opponent += gained;
        }
        this._notify({ type: 'score_update', gained: gained });
    }

    _finishRound(playerWon) {
        this.currentRound.isActive = false;
        this.state = 'RESULT';
        
        const targetId = (this.currentRound.target.id || '').trim();
        const clueData = this.clues[targetId];
        const explanation = clueData && clueData.explanation ? clueData.explanation : '解説データなし';
        
        this._notify({ 
            type: 'round_end', 
            playerWon: playerWon,
            target: this.currentRound.target,
            explanation: explanation,
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

        // オンラインモードでホストの場合、ラウンド終了を通知
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'round_end',
                playerWon: playerWon,
                target: this.currentRound.target,
                scores: this.scores
            });
        }
    }

    endGame() {
        this.state = 'IDLE';
        const summary = {
            totalRounds: this.totalRounds,
            playerScore: this.scores.player,
            cpuScore: this.scores.opponent,
            maxCombo: this.maxCombo,
            winner: this.scores.player > this.scores.opponent ? 'player' : 
                    this.scores.player < this.scores.opponent ? 'cpu' : 'draw'
        };
        this._notify({ type: 'game_end', summary: summary });
        if (this.onGameEnd) this.onGameEnd(summary);
        
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({ type: 'game_end', scores: this.scores });
        }
    }

    skipRound() {
        if (!this.currentRound.isActive) return;
        if (this.cpu) this.cpu.cancelThinking();
        this.combo = 0;
        this._finishRound(false);
    }

    pause() {
        if (this.cpu) this.cpu.cancelThinking();
        AudioManager.stop();
    }

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

    getCategories() { return Array.from(this.categories).sort(); }
    getCompoundCount() { return this.compounds.length; }
}