/**
 * GameEngine - ゲームの核となる状態管理とルール適用
 * キー名空白トリム対応版
 * 
 * 【状態遷移】
 * IDLE → DEAL → (カード画像読み込み完了待ち) → READING → PLAYING → RESULT → (next round or end)
 */
class GameEngine {
    constructor() {
        this.state = 'IDLE';
        this.mode = 'cpu';
        
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
        this.scores = { player: 0, cpu: 0 };
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
            categories: [] // 空 = 全て
        };
        
        // コールバック
        this.onUpdate = null;
        this.onRoundEnd = null;
        this.onGameEnd = null;
    }

    /**
     * オブジェクトのキー名と文字列値を再帰的にトリム
     * compounds.jsonのキー名に空白が含まれる問題への対応
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
            
            // キー名と値のトリム処理
            this.compounds = rawCompounds.map(c => this._trimObject(c));
            const trimmedClues = rawClues.map(c => this._trimObject(c));
            
            // ClueデータをIDで引ける辞書に変換（compound_idをトリム）
            trimmedClues.forEach(c => { 
                const compoundId = (c.compound_id || '').trim();
                if (compoundId) {
                    this.clues[compoundId] = c; 
                }
            });
            
            // カテゴリ一覧を抽出
            this.compounds.forEach(c => {
                if (c.category) this.categories.add(c.category);
            });
            
            console.log(`✓ Loaded ${this.compounds.length} compounds, ${Object.keys(this.clues).length} clues`);
            console.log('Sample compound id:', this.compounds[0]?.id);
            console.log('Sample clue key:', Object.keys(this.clues)[0]);
            return true;
        } catch (e) {
            console.error(' Data load error:', e);
            console.error('Please check:');
            console.error('1. data/compounds.json exists');
            console.error('2. data/clues.json exists');
            console.error('3. File paths are correct');
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
     * 【重要】ここでは nextClue() を呼ばない
     * app.js の renderCards() が全カード画像読み込み完了後に startReading() を呼ぶ
     */
    startNewRound() {
        if (this.roundNumber >= this.totalRounds) {
            this.endGame();
            return;
        }
        
        this.roundNumber++;
        
        // 1. 正解をランダムに選ぶ（カテゴリフィルタ適用）
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
        
        // 2. 場のカードを作る（正解含む N 枚）
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
        
        // ★ ここでは nextClue() を呼ばない
        // app.js の renderCards() が全カード画像読み込み完了後に startReading() を呼ぶ
    }

    /**
     * 読み札を開始（app.jsから呼ばれる）
     * 全カード画像の読み込みが完了した後に呼び出される
     */
    startReading() {
        if (!this.currentRound.isActive) return;
        if (this.state !== 'DEAL') return;
        
        console.log('All cards loaded - starting reading');
        
        // 1.5秒の間を置いてから読み上げ開始
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
            // 正解
            if (this.cpu) this.cpu.cancelThinking();
            
            this.combo++;
            if (this.combo > this.maxCombo) this.maxCombo = this.combo;
            
            this._calculateScore(true, this.currentRound.currentStage, 'player', reactionTime);
            AudioManager.playSound(this.combo > 1 ? 'combo' : 'correct');
            
            // 統計記録
            StorageManager.recordGameResult({
                isCorrect: true,
                time: reactionTime,
                compoundId: this.currentRound.target.id,
                category: this.currentRound.target.category
            });
            
            this._finishRound(true);
        } else {
            // 誤答
            this.combo = 0;
            this._calculateScore(false, 0, 'player', reactionTime);
            AudioManager.playSound('wrong');
            
            // 統計記録
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
            // CPU正解 → プレイヤー敗北
            this.currentRound.isActive = false;
            this.combo = 0;
            
            this._calculateScore(true, this.currentRound.currentStage, 'cpu', 0);
            AudioManager.playSound('wrong');
            
            this._finishRound(false);
        } else {
            // CPU誤答 → プレイヤーにチャンス
            this._notify({ type: 'cpu_wrong', id: cardId });
            AudioManager.playSound('wrong');
            
            // 次のClueへ自動進行
            setTimeout(() => this.nextClue(), 1500);
        }
    }

    /**
     * スコア計算
     * 早いStageほど高得点、コンボボーナスあり
     */
    _calculateScore(isCorrect, stage, who = 'player', reactionTime = 0) {
        if (!isCorrect) {
            if (who === 'player') {
                this.scores.player = Math.max(0, this.scores.player - 50);
            }
            return;
        }
        
        // 基本点 1000点
        // Stage 1で正解: 1000
        // Stage 2で正解: 800
        // Stage 3で正解: 600 ...
        const baseScore = 1000;
        const penalty = (stage - 1) * 200;
        let gained = Math.max(100, baseScore - penalty);
        
        // 難易度ボーナス
        const diffBonus = (this.currentRound.target.difficulty || 1) * 50;
        gained += diffBonus;
        
        // コンボボーナス（プレイヤーのみ）
        if (who === 'player' && this.combo > 1) {
            const comboBonus = Math.min(this.combo * 50, 500);
            gained += comboBonus;
        }
        
        // 高速回答ボーナス（3秒以内）
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
        
        // idを確実にトリムしてclueDataを取得
        const targetId = (this.currentRound.target.id || '').trim();
        const clueData = this.clues[targetId];
        
        // デバッグ用ログ
        if (!clueData) {
            console.warn('clueData not found for id:', targetId);
            console.log('Available clue keys:', Object.keys(this.clues).slice(0, 5));
        }
        
        this._notify({ 
            type: 'round_end', 
            playerWon: playerWon,
            target: this.currentRound.target,
            explanation: clueData && clueData.explanation ? clueData.explanation : '解説はありません。',
            stage: this.currentRound.currentStage,
            combo: this.combo
        });
        
        if (this.onRoundEnd) {
            this.onRoundEnd({
                playerWon: playerWon,
                target: this.currentRound.target,
                explanation: clueData && clueData.explanation ? clueData.explanation : '解説はありません。'
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
     * スキップ（正解を見せる）
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