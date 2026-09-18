/* =========================================================================
game.js  —  GameEngine（修正版 v4）あ
【今回の修正: オンラインで「ゲストが正解しても得点が入らない」】
原因:
  ゲストは「phase=result」を先に書き、「taps」を後に書いていた。
  → ホストは result スナップショットで forceRoundEndLocal() を実行し
    currentRound.isActive = false になる
  → 直後に届くゲストの taps を handleRemoteTaps が
    「!isActive だから return」で捨てていた
  → scoreOpponentCorrect() が一度も呼ばれず、ゲストの得点が永久に 0

対策（エンジン側）:
・scoreOpponentCorrect() に「勝敗確定済み / 加算済み」判定を集約し、
   isActive の状態に依存せず 1 回だけ確実に加算できるようにした
・currentRound.winner を導入（ホストが先に正解した場合は相手に加点しない）
・scoreOpponentWrong() を追加（ホストと同じ -50 を相手にも適用＝対称化）
・getAuthoritativeScores() を追加（DB書き戻し用）
========================================================================= */
class GameEngine {
    constructor() {
        this.state = 'IDLE';
        this.mode = 'cpu';
        this.isOnline = false;
        this.isHost = false;
        this.compounds = [];
        this.clues = {};
        this.categories = new Set();
        this.currentRound = this._emptyRound();
        this.scores = { player: 0, opponent: 0 };
        this.roundNumber = 0;
        this.totalRounds = 10;
        this.combo = 0;
        this.maxCombo = 0;
        this.cpu = null;
        this.settings = { cardCount: 9, cpuLevel: 3, categories: [] };
        this.onUpdate = null;
        this.onRoundEnd = null;
        this.onGameEnd = null;
        this.onOnlineStateChange = null;
        this._readTimer = null;
        this._clueTimer = null;
        this._watchdogTimer = null;
        this._roundToken = 0;
        this._lastClueAt = 0;
        this._opponentScoredRound = -1;   // ★ v4: 相手得点の加算済みラウンド
    }
    _emptyRound() {
        return {
            target: null,
            cards: [],
            currentStage: 0,
            maxStage: 4,
            isActive: false,
            startTime: 0,
            token: 0,
            winner: null        // ★ v4: null | 'player' | 'opponent'
        };
    }
    _clearReadTimer() {
        if (this._readTimer) { clearTimeout(this._readTimer); this._readTimer = null; }
    }
    _clearClueTimer() {
        if (this._clueTimer) { clearTimeout(this._clueTimer); this._clueTimer = null; }
    }
    _clearWatchdog() {
        if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
    }
    _clearTimers() {
        this._clearReadTimer();
        this._clearClueTimer();
        this._clearWatchdog();
    }
    /** 進行ウォッチドッグ（v3踏襲） */
    _startWatchdog(token) {
        this._clearWatchdog();
        if (this.isOnline && !this.isHost) return;
        this._lastClueAt = Date.now();
        this._watchdogTimer = setInterval(() => {
            const r = this.currentRound;
            if (!r || r.token !== token || !r.isActive) { this._clearWatchdog(); return; }
            if (this.isOnline && !this.isHost) { this._clearWatchdog(); return; }
            const idle = Date.now() - (this._lastClueAt || r.startTime || Date.now());
            if (r.currentStage === 0) {
                if (idle > 4000) {
                    console.warn('[watchdog] reading never started -> force nextClue (round ' + this.roundNumber + ')');
                    this._clearReadTimer();
                    this._lastClueAt = Date.now();
                    this.nextClue();
                }
            } else if (idle > 16000) {
                console.warn('[watchdog] reading stalled at stage ' + r.currentStage + ' -> force nextClue');
                this._lastClueAt = Date.now();
                this.nextClue();
            }
        }, 1000);
    }
    ensureReading() {
        if (!this.currentRound || !this.currentRound.isActive) return;
        if (this.isOnline && !this.isHost) return;
        if (this.currentRound.currentStage === 0 && !this._readTimer) this.startReading(true);
    }
    _clueOf(targetId) {
        return this.clues[String(targetId || '').trim()] || null;
    }
    _maxStage(target) {
        const clueData = this._clueOf(target ? target.id : '');
        if (clueData && Array.isArray(clueData.stages) && clueData.stages.length > 0) {
            return clueData.stages.length;
        }
        return 4;
    }
    _trimObject(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(item => this._trimObject(item));
        const trimmed = {};
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                const trimmedKey = key.trim();
                const value = obj[key];
                if (typeof value === 'string') trimmed[trimmedKey] = value.trim();
                else if (Array.isArray(value)) trimmed[trimmedKey] = value.map(v => typeof v === 'string' ? v.trim() : v);
                else if (typeof value === 'object' && value !== null) trimmed[trimmedKey] = this._trimObject(value);
                else trimmed[trimmedKey] = value;
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
            trimmedClues.forEach(c => { if (c.compound_id) this.clues[c.compound_id] = c; });
            this.compounds.forEach(c => { if (c.category) this.categories.add(c.category); });
            console.log(`✓ Loaded ${this.compounds.length} compounds, ${Object.keys(this.clues).length} clues`);
            return true;
        } catch (e) {
            console.error('✗ Data load error:', e);
            return false;
        }
    }
    configure(settings) {
        this.settings = Object.assign({}, this.settings, settings || {});
        if (settings && settings.isOnline !== undefined) this.isOnline = settings.isOnline;
        if (settings && settings.isHost !== undefined) this.isHost = settings.isHost;
        if (settings && settings.cpuLevel !== undefined) {
            this.cpu = settings.cpuLevel > 0 ? new CPUPlayer(settings.cpuLevel) : null;
        }
        if (settings && settings.mode) this.mode = settings.mode;
    }
    startGame(totalRounds = 10) {
        this._clearTimers();
        this.totalRounds = totalRounds;
        this.roundNumber = 0;
        this.scores = { player: 0, opponent: 0 };
        this.combo = 0;
        this.maxCombo = 0;
        this._opponentScoredRound = -1;   // ★ v4
        this.currentRound = this._emptyRound();
        this._notify();
        this.startNewRound();
    }
    startNewRound() {
        this._clearTimers();
        if (this.cpu) this.cpu.cancelThinking();
        if (this.roundNumber >= this.totalRounds) {
            this.endGame();
            return;
        }
        this.roundNumber++;
        this._roundToken++;
        this._opponentScoredRound = -1;   // ★ v4: ラウンドごとにリセット
        const token = this._roundToken;
        let candidates = this.compounds;
        if (this.settings.categories && this.settings.categories.length > 0) {
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
            .slice(0, Math.max(0, this.settings.cardCount - 1));
        const cards = [target].concat(others).sort(() => Math.random() - 0.5);
        this.currentRound = {
            target: target,
            cards: cards,
            currentStage: 0,
            maxStage: this._maxStage(target),
            isActive: true,
            startTime: Date.now(),
            token: token,
            winner: null            // ★ v4
        };
        this.state = 'DEAL';
        this._lastClueAt = Date.now();
        this._startWatchdog(token);
        this._notify();
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'round_start',
                round: this.roundNumber,
                totalRounds: this.totalRounds,
                cards: cards,
                target: target,
                scores: this.scores,
                phase: 'dealing'
            });
        }
    }
    startReading(force = false) {
        if (!this.currentRound.isActive) return;
        if (this.isOnline && !this.isHost) return;
        if (this.currentRound.currentStage > 0) return;
        if (this._readTimer) return;
        if (!force && this.state !== 'DEAL') return;
        const token = this.currentRound.token;
        this._readTimer = setTimeout(() => {
            this._readTimer = null;
            if (this.currentRound.token !== token) return;
            if (!this.currentRound.isActive) return;
            this.nextClue();
        }, 1500);
    }
    nextClue() {
        if (!this.currentRound.isActive) return;
        if (this.isOnline && !this.isHost) return;
        const target = this.currentRound.target;
        if (!target) return;
        const clueData = this._clueOf(target.id);
        const maxStage = this._maxStage(target);
        if (this.currentRound.currentStage >= maxStage) return;
        this._clearClueTimer();
        const token = this.currentRound.token;
        this.currentRound.currentStage++;
        this.state = 'READING';
        this._lastClueAt = Date.now();
        const stageNow = this.currentRound.currentStage;

        let advanced = false;
        const advance = () => {
            if (advanced) return;
            advanced = true;
            if (this.currentRound.token !== token) return;
            if (!this.currentRound.isActive) return;
            if (this.currentRound.currentStage !== stageNow) return;
            const hasNext = clueData && Array.isArray(clueData.stages)
                ? clueData.stages.some(s => s.stage === stageNow + 1) : false;
            if (!hasNext) return;
            this._clearClueTimer();
            this._clueTimer = setTimeout(() => {
                this._clueTimer = null;
                if (this.currentRound.token === token) this.nextClue();
            }, 1000);
        };
        this._clueTimer = setTimeout(() => { this._clueTimer = null; advance(); }, 15000);

        if (clueData) {
            const currentClue = clueData.stages.find(s => s.stage === stageNow);
            if (currentClue) {
                try {
                    AudioManager.playSound('stage');
                    AudioManager.speak(currentClue.text, { onEnd: () => advance() });
                } catch (e) {
                    console.error('speak error:', e);
                    advance();
                }
            } else {
                advance();
            }
        } else {
            advance();
        }

        this._notify();
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'stage_update',
                round: this.roundNumber,
                currentStage: stageNow,
                phase: 'reading'
            });
        }
        if (this.cpu && this.mode === 'cpu' && !this.isOnline) {
            this.cpu.startThinking(
                target.id,
                this.currentRound.cards,
                stageNow,
                (actionType, cardId) => {
                    if (this.currentRound.token !== token) return;
                    if (actionType === 'tap') this.handleCpuAnswer(cardId, true);
                    else this.handleCpuAnswer(cardId, false);
                }
            );
        }
    }
    _scheduleNextClue(delay = 1500) {
        if (!this.currentRound.isActive) return;
        if (this.isOnline && !this.isHost) return;
        const token = this.currentRound.token;
        this._clearClueTimer();
        this._clueTimer = setTimeout(() => {
            this._clueTimer = null;
            if (this.currentRound.token === token) this.nextClue();
        }, delay);
    }
    handlePlayerTap(cardId) {
        if (!this.currentRound.isActive) return;
        if (this.isOnline && !this.isHost) return;
        const targetId = String(this.currentRound.target ? this.currentRound.target.id : '').trim();
        const tapId = String(cardId || '').trim();
        const isCorrect = (tapId === targetId);
        const reactionTime = Date.now() - this.currentRound.startTime;
        const stageNow = this.currentRound.currentStage;
        if (isCorrect) {
            if (this.cpu) this.cpu.cancelThinking();
            this.combo++;
            if (this.combo > this.maxCombo) this.maxCombo = this.combo;
            this._calculateScore(true, stageNow, 'player', reactionTime);
            AudioManager.playSound(this.combo > 1 ? 'combo' : 'correct');
            if (!this.isOnline) {
                try {
                    StorageManager.recordGameResult({
                        isCorrect: true,
                        time: reactionTime,
                        compoundId: targetId,
                        category: this.currentRound.target.category || '',
                        difficulty: this.settings.cpuLevel || this.currentRound.target.difficulty || 1,
                        stage: stageNow,
                        combo: this.combo
                    });
                } catch (e) { console.error('Storage error:', e); }
            }
            this._finishRound(true);
        } else {
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
                        stage: stageNow,
                        combo: 0
                    });
                } catch (e) { console.error('Storage error:', e); }
            }
            this._notify({ type: 'wrong', id: tapId });
            this._scheduleNextClue(1500);
        }
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'player_tap',
                cardId: tapId,
                isCorrect: isCorrect,
                scores: this.scores      // ★ v4: 誤答ペナルティも即時反映
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
            this._scheduleNextClue(1500);
        }
    }
    /* =====================================================================
       ★ v4: オンライン相手（ゲスト）の得点 API
       isActive に依存せず、かつ「1ラウンド1回だけ」確実に加算する。
       ===================================================================== */
    /**
     * @returns {boolean} 加算できたかどうか（false = 加算不要／確定済み）
     */
    scoreOpponentCorrect(stage) {
        // ホストがすでに正解して勝敗が決まっている → 相手には加点しない
        if (this.currentRound.winner === 'player') return false;
        // 同一ラウンドで二重加算しない
        if (this._opponentScoredRound === this.roundNumber) return false;
        this._opponentScoredRound = this.roundNumber;
        this.currentRound.winner = 'opponent';
        this.combo = 0;
        const st = Number(stage) || this.currentRound.currentStage || 1;
        this._calculateScore(true, st, 'opponent', 0);
        return true;
    }
    /** ★ v4: 相手の誤答ペナルティ（ホストと同じ -50） */
    scoreOpponentWrong() {
        if (this.currentRound.winner) return false;
        this.scores.opponent = Math.max(0, this.scores.opponent - 50);
        this._notify({ type: 'score_update' });
        return true;
    }
    /** ★ v4: DB書き戻し用の正本スコア */
    getAuthoritativeScores() {
        return {
            player: Number(this.scores.player) || 0,
            opponent: Number(this.scores.opponent) || 0
        };
    }
    /** ラウンド番号照合付きローカル終了（v3踏襲） */
    forceRoundEndLocal(forRound) {
        if (typeof forRound === 'number' && forRound > 0 && forRound !== this.roundNumber) {
            console.warn('forceRoundEndLocal ignored: stale round', forRound, 'current', this.roundNumber);
            return false;
        }
        this._clearTimers();
        if (this.cpu) this.cpu.cancelThinking();
        this.currentRound.isActive = false;
        this.state = 'RESULT';
        return true;
    }
    _calculateScore(isCorrect, stage, who = 'player', reactionTime = 0) {
        if (!isCorrect) {
            if (who === 'player') this.scores.player = Math.max(0, this.scores.player - 50);
            return;
        }
        const baseScore = 1000;
        const penalty = (Math.max(1, stage) - 1) * 200;
        let gained = Math.max(100, baseScore - penalty);
        const diffBonus = (this.currentRound.target && this.currentRound.target.difficulty ? this.currentRound.target.difficulty : 1) * 50;
        gained += diffBonus;
        if (who === 'player' && this.combo > 1) gained += Math.min(this.combo * 50, 500);
        if (who === 'player' && reactionTime > 0 && reactionTime < 3000) {
            gained += Math.floor((3000 - reactionTime) / 100) * 10;
        }
        if (who === 'player') this.scores.player += gained;
        else this.scores.opponent += gained;
        this._notify({ type: 'score_update', gained: gained, who: who });
    }
    _finishRound(playerWon) {
        if (!this.currentRound.isActive) return;
        this._clearTimers();
        if (this.cpu) this.cpu.cancelThinking();
        this.currentRound.isActive = false;
        this.currentRound.winner = playerWon ? 'player' : 'opponent';   // ★ v4
        this.state = 'RESULT';
        const target = this.currentRound.target || {};
        const clueData = this._clueOf(target.id);
        const explanation = (clueData && clueData.explanation) ? clueData.explanation : '解説データなし';
        this._notify({
            type: 'round_end',
            playerWon: playerWon,
            target: target,
            explanation: explanation,
            stage: this.currentRound.currentStage,
            combo: this.combo
        });
        if (this.onRoundEnd) {
            this.onRoundEnd({ playerWon: playerWon, target: target, explanation: explanation });
        }
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'round_end',
                round: this.roundNumber,
                playerWon: playerWon,
                target: target,
                scores: this.getAuthoritativeScores(),   // ★ v4
                phase: 'result'
            });
        }
    }
    endGame() {
        this._clearTimers();
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
            this.onOnlineStateChange({
                type: 'game_end',
                scores: this.getAuthoritativeScores(),   // ★ v4
                phase: 'finished'
            });
        }
    }
    skipRound() {
        if (!this.currentRound.isActive) return;
        if (this.cpu) this.cpu.cancelThinking();
        this.combo = 0;
        this._finishRound(false);
    }
    pause() {
        this._clearTimers();
        if (this.cpu) this.cpu.cancelThinking();
        try { AudioManager.stop(); } catch (e) { }
    }
    _notify(data = {}) {
        if (this.onUpdate) {
            this.onUpdate(Object.assign({
                state: this.state,
                mode: this.mode,
                round: this.currentRound,
                scores: this.scores,
                roundNumber: this.roundNumber,
                totalRounds: this.totalRounds,
                combo: this.combo,
                maxCombo: this.maxCombo
            }, data));
        }
    }
    getCategories() { return Array.from(this.categories).sort(); }
    getCompoundCount() { return this.compounds.length; }
}