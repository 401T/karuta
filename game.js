/* =========================================================================
   game.js  —  GameEngine v6
   -------------------------------------------------------------------------
   【v6 の修正】
   ★修正3: 取り札が全て描画される前に読み上げが始まる
     ・cardsReady フラグを導入。startNewRound で false にし、
       UI 側が「全カード描画完了」を通知して初めて読み上げを許可する。
     ・startReading() は cardsReady でない場合は _pendingRead に保留。
     ・watchdog も cardsReady 前は stage0 の強制進行を行わない。
   【v5 からの継続修正】
     ・最終札到達 → 最終解答フェーズ（時間切れで自動終了＝ボタンが死なない）
     ・_finishRound の完全冪等化（settled）
     ・CPU 誤答にも -50（対称化）
     ・onCorrectAnswer フック（資料アンロック）
   ★修正4: cardCount を settings から確実に参照（0/NaN ガード付き）
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
        this.roundWins = { player: 0, opponent: 0, timeout: 0 };

        this.cpu = null;
        this.settings = { cardCount: 9, cpuLevel: 3, categories: [] };

        this.onUpdate = null;
        this.onRoundEnd = null;
        this.onGameEnd = null;
        this.onOnlineStateChange = null;
        this.onCorrectAnswer = null;

        this._readTimer = null;
        this._clueTimer = null;
        this._finalTimer = null;
        this._watchdogTimer = null;
        this._roundToken = 0;
        this._lastClueAt = 0;
        this._opponentScoredRound = -1;
        this._playerTimes = [];

        // ★ 修正3: カード描画完了ゲート
        this.cardsReady = false;
        this._pendingRead = false;

        this.finalDeadline = 0;
        this.FINAL_ANSWER_WINDOW = 10000;
        this.READ_START_DELAY = 1000;   // 札が揃ってから読み上げ開始までの間
    }

    /* ========================= ラウンド雛形 ========================= */
    _emptyRound() {
        return {
            target: null,
            cards: [],
            currentStage: 0,
            maxStage: 4,
            isActive: false,
            startTime: 0,
            token: 0,
            winner: null,
            settled: false,
            isFinal: false,
            finalPhase: false,
            reason: null
        };
    }

    /* ========================= タイマー管理 ========================= */
    _clearReadTimer() { if (this._readTimer) { clearTimeout(this._readTimer); this._readTimer = null; } }
    _clearClueTimer() { if (this._clueTimer) { clearTimeout(this._clueTimer); this._clueTimer = null; } }
    _clearFinalTimer() { if (this._finalTimer) { clearTimeout(this._finalTimer); this._finalTimer = null; } this.finalDeadline = 0; }
    _clearWatchdog() { if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; } }
    _clearTimers() { this._clearReadTimer(); this._clearClueTimer(); this._clearFinalTimer(); this._clearWatchdog(); }

    /** ★ 修正3: UI が「全カード描画完了」を通知する */
    setCardsReady(ready) {
        this.cardsReady = !!ready;
        if (this.cardsReady && this._pendingRead) {
            this._pendingRead = false;
            this.startReading(true);
        }
        this._notify({ type: 'cards_ready', cardsReady: this.cardsReady });
    }

    /** 進行ウォッチドッグ（読み上げが止まったときの保険） */
    _startWatchdog(token) {
        this._clearWatchdog();
        if (this.isOnline && !this.isHost) return;
        this._lastClueAt = Date.now();
        this._watchdogTimer = setInterval(() => {
            const r = this.currentRound;
            if (!r || r.token !== token || !r.isActive || r.settled) { this._clearWatchdog(); return; }
            if (this.isOnline && !this.isHost) { this._clearWatchdog(); return; }
            if (r.finalPhase) return;

            const idle = Date.now() - (this._lastClueAt || r.startTime || Date.now());
            if (r.currentStage === 0) {
                // ★ 修正3: カードが揃うまでは絶対に読み上げない
                if (!this.cardsReady) { this._lastClueAt = Date.now(); return; }
                if (idle > 5000) {
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
        if (!this.currentRound || !this.currentRound.isActive || this.currentRound.settled) return;
        if (this.isOnline && !this.isHost) return;
        if (!this.cardsReady) return;
        if (this.currentRound.currentStage === 0 && !this._readTimer) this.startReading(true);
    }

    /* ========================= データ ========================= */
    _clueOf(targetId) { return this.clues[String(targetId || '').trim()] || null; }

    _maxStage(target) {
        const clueData = this._clueOf(target ? target.id : '');
        if (clueData && Array.isArray(clueData.stages) && clueData.stages.length > 0) return clueData.stages.length;
        return 4;
    }

    /** ★ 修正4: カード枚数を安全に取得（NaN / 0 / 範囲外を防止） */
    getCardCount() {
        let n = parseInt(this.settings && this.settings.cardCount, 10);
        if (!isFinite(n) || n <= 0) n = 9;
        const max = Math.max(4, this.compounds.length || 9);
        return Math.max(4, Math.min(n, max));
    }

    _trimObject(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(item => this._trimObject(item));
        const trimmed = {};
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                const trimmedKey = String(key).trim();
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
            if (!compRes.ok) throw new Error('compounds.json: ' + compRes.status);
            if (!clueRes.ok) throw new Error('clues.json: ' + clueRes.status);

            const rawCompounds = await compRes.json();
            const rawClues = await clueRes.json();
            this.compounds = (rawCompounds || []).map(c => this._trimObject(c));
            (rawClues || []).map(c => this._trimObject(c)).forEach(c => { if (c.compound_id) this.clues[c.compound_id] = c; });
            this.compounds.forEach(c => { if (c.category) this.categories.add(c.category); });
            console.log('✓ Loaded ' + this.compounds.length + ' compounds, ' + Object.keys(this.clues).length + ' clues');
            return true;
        } catch (e) {
            console.error('✗ Data load error:', e);
            return false;
        }
    }

    /* ========================= 設定・開始 ========================= */
    configure(settings) {
        this.settings = Object.assign({}, this.settings, settings || {});
        if (settings && settings.isOnline !== undefined) this.isOnline = settings.isOnline;
        if (settings && settings.isHost !== undefined) this.isHost = settings.isHost;
        if (settings && settings.cpuLevel !== undefined) {
            this.cpu = settings.cpuLevel > 0 ? new CPUPlayer(settings.cpuLevel) : null;
        }
        if (settings && settings.mode) this.mode = settings.mode;
        // ★ 修正4: cardCount の型を強制
        if (settings && settings.cardCount !== undefined) {
            const n = parseInt(settings.cardCount, 10);
            this.settings.cardCount = isFinite(n) && n > 0 ? n : 9;
        }
    }

    startGame(totalRounds = 10) {
        this._clearTimers();
        this.totalRounds = totalRounds;
        this.roundNumber = 0;
        this.scores = { player: 0, opponent: 0 };
        this.combo = 0;
        this.maxCombo = 0;
        this.roundWins = { player: 0, opponent: 0, timeout: 0 };
        this._opponentScoredRound = -1;
        this._playerTimes = [];
        this.currentRound = this._emptyRound();
        this.cardsReady = false;
        this._pendingRead = false;
        if (this.cpu && this.cpu.reset) this.cpu.reset();
        this._notify();
        this.startNewRound();
    }

    startNewRound() {
        this._clearTimers();
        if (this.cpu) this.cpu.cancelThinking();

        if (this.roundNumber >= this.totalRounds) { this.endGame(); return; }

        this.roundNumber++;
        this._roundToken++;
        this._opponentScoredRound = -1;
        this.finalDeadline = 0;
        this.cardsReady = false;      // ★ 修正3: 毎ラウンド、描画完了を待つ
        this._pendingRead = false;
        const token = this._roundToken;

        const cardCount = this.getCardCount();

        let candidates = this.compounds;
        if (this.settings.categories && this.settings.categories.length > 0) {
            candidates = candidates.filter(c => this.settings.categories.includes(c.category));
        }
        if (candidates.length === 0) { console.error('No candidates available'); return; }

        const target = candidates[Math.floor(Math.random() * candidates.length)];
        const others = this.compounds
            .filter(c => c.id !== target.id)
            .sort(() => Math.random() - 0.5)
            .slice(0, Math.max(0, cardCount - 1));
        const cards = [target].concat(others).sort(() => Math.random() - 0.5);

        this.currentRound = {
            target: target,
            cards: cards,
            currentStage: 0,
            maxStage: this._maxStage(target),
            isActive: true,
            startTime: 0,
            token: token,
            winner: null,
            settled: false,
            isFinal: false,
            finalPhase: false,
            reason: null
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
        const r = this.currentRound;
        if (!r || !r.isActive || r.settled) return;
        if (this.isOnline && !this.isHost) return;
        if (r.currentStage > 0) return;
        if (this._readTimer) return;
        if (!force && this.state !== 'DEAL') return;

        // ★ 修正3: カードが揃っていなければ保留（setCardsReady で再開）
        if (!this.cardsReady) { this._pendingRead = true; return; }

        const token = r.token;
        r.startTime = Date.now();
        this._readTimer = setTimeout(() => {
            this._readTimer = null;
            if (this.currentRound.token !== token) return;
            if (!this.currentRound.isActive || this.currentRound.settled) return;
            this.nextClue();
        }, this.READ_START_DELAY);
    }

    /* ========================= 読み札進行 ========================= */
    nextClue() {
        const r = this.currentRound;
        if (!r || !r.isActive || r.settled) return;
        if (this.isOnline && !this.isHost) return;
        const target = r.target;
        if (!target) return;

        const clueData = this._clueOf(target.id);
        const maxStage = this._maxStage(target);

        // 最終札まで読み終えていたら最終解答フェーズへ
        if (r.currentStage >= maxStage) { this._enterFinalPhase(); return; }

        this._clearClueTimer();
        this._clearFinalTimer();
        const token = r.token;

        r.currentStage++;
        r.isFinal = (r.currentStage >= maxStage);
        this.state = 'READING';
        this._lastClueAt = Date.now();
        if (!r.startTime) r.startTime = Date.now();
        const stageNow = r.currentStage;

        let advanced = false;
        const advance = () => {
            if (advanced) return;
            advanced = true;
            if (this.currentRound.token !== token) return;
            if (!this.currentRound.isActive || this.currentRound.settled) return;
            if (this.currentRound.currentStage !== stageNow) return;

            if (r.isFinal) { this._enterFinalPhase(); return; }

            const hasNext = clueData && Array.isArray(clueData.stages)
                ? clueData.stages.some(s => s.stage === stageNow + 1) : false;
            if (!hasNext) { this._enterFinalPhase(); return; }

            this._clearClueTimer();
            this._clueTimer = setTimeout(() => {
                this._clueTimer = null;
                if (this.currentRound.token === token) this.nextClue();
            }, 1000);
        };

        // 読み上げが取得できなかった場合の保険
        this._clueTimer = setTimeout(() => { this._clueTimer = null; advance(); }, 15000);

        if (clueData) {
            const currentClue = Array.isArray(clueData.stages) ? clueData.stages.find(s => s.stage === stageNow) : null;
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
            this.cpu.startThinking(target.id, r.cards, stageNow, (actionType, cardId) => {
                if (this.currentRound.token !== token) return;
                if (this.currentRound.settled || !this.currentRound.isActive) return;
                if (actionType === 'tap') this.handleCpuAnswer(cardId, true);
                else this.handleCpuAnswer(cardId, false);
            }, this._cpuContext(r.isFinal));
        }
    }

    /** 最終解答フェーズ（読み札を出し切ったあとの制限時間） */
    _enterFinalPhase() {
        const r = this.currentRound;
        if (!r || !r.isActive || r.settled) return;
        if (r.finalPhase) return;
        r.finalPhase = true;
        r.isFinal = true;

        this._clearClueTimer();
        this._clearReadTimer();

        const token = r.token;
        this.finalDeadline = Date.now() + this.FINAL_ANSWER_WINDOW;
        this._finalTimer = setTimeout(() => {
            this._finalTimer = null;
            this.finalDeadline = 0;
            if (this.currentRound.token !== token) return;
            if (!this.currentRound.isActive || this.currentRound.settled) return;
            console.warn('[engine] final answer window expired -> timeout (round ' + this.roundNumber + ')');
            this.roundWins.timeout++;
            this._finishRound(false, 'timeout');
        }, this.FINAL_ANSWER_WINDOW);

        this._notify({ type: 'final_stage' });

        if (this.cpu && this.mode === 'cpu' && !this.isOnline && !this.cpu.isThinking) {
            this.cpu.startThinking(r.target ? r.target.id : '', r.cards, r.currentStage, (actionType, cardId) => {
                if (this.currentRound.token !== token) return;
                if (this.currentRound.settled || !this.currentRound.isActive) return;
                if (actionType === 'tap') this.handleCpuAnswer(cardId, true);
                else this.handleCpuAnswer(cardId, false);
            }, this._cpuContext(true));
        }
    }

    extendFinalWindow(ms = 4000) {
        const r = this.currentRound;
        if (!r || !r.finalPhase || r.settled) return;
        const token = r.token;
        this._clearFinalTimer();
        this.finalDeadline = Math.max(this.finalDeadline, Date.now()) + ms;
        const remain = Math.max(500, this.finalDeadline - Date.now());
        this._finalTimer = setTimeout(() => {
            this._finalTimer = null;
            this.finalDeadline = 0;
            if (this.currentRound.token !== token) return;
            if (!this.currentRound.isActive || this.currentRound.settled) return;
            this.roundWins.timeout++;
            this._finishRound(false, 'timeout');
        }, remain);
        this._notify({ type: 'final_stage' });
    }

    canNextClue() {
        const r = this.currentRound;
        if (!r || !r.isActive || r.settled) return false;
        if (this.isOnline && !this.isHost) return false;
        if (r.finalPhase) return false;
        if (!this.cardsReady) return false;
        return r.currentStage < this._maxStage(r.target);
    }

    isFinalStage() {
        const r = this.currentRound;
        return !!(r && (r.isFinal || r.finalPhase));
    }

    _scheduleNextClue(delay = 1600) {
        const r = this.currentRound;
        if (!r || !r.isActive || r.settled) return;
        if (this.isOnline && !this.isHost) return;
        if (r.finalPhase) return;
        const token = r.token;
        this._clearClueTimer();
        this._clueTimer = setTimeout(() => {
            this._clueTimer = null;
            if (this.currentRound.token === token) this.nextClue();
        }, delay);
    }

    _cpuContext(isFinal) {
        const r = this.currentRound;
        const maxStage = this._maxStage(r.target);
        return {
            playerScore: this.scores.player,
            cpuScore: this.scores.opponent,
            round: this.roundNumber,
            totalRounds: this.totalRounds,
            currentStage: r.currentStage,
            maxStage: maxStage,
            isFinalStage: !!isFinal || r.currentStage >= maxStage,
            playerAvgTime: this._playerTimes.length
                ? this._playerTimes.reduce((a, b) => a + b, 0) / this._playerTimes.length
                : 5000
        };
    }

    /* ========================= プレイヤー行動 ========================= */
    handlePlayerTap(cardId) {
        const r = this.currentRound;
        if (!r || !r.isActive || r.settled) return;
        if (this.state === 'RESULT') return;
        if (this.isOnline && !this.isHost) return;

        const target = r.target;
        const targetId = String(target ? target.id : '').trim();
        const tapId = String(cardId || '').trim();
        const isCorrect = (tapId === targetId);
        const reactionTime = Date.now() - (r.startTime || Date.now());
        const stageNow = r.currentStage;

        if (isCorrect) {
            if (this.cpu) this.cpu.cancelThinking();
            this.combo++;
            if (this.combo > this.maxCombo) this.maxCombo = this.combo;
            this._calculateScore(true, stageNow, 'player', reactionTime);
            AudioManager.playSound(this.combo > 1 ? 'combo' : 'correct');

            this._playerTimes.push(reactionTime);
            if (this._playerTimes.length > 6) this._playerTimes.shift();
            if (this.cpu && this.cpu.reportPlayerTime) this.cpu.reportPlayerTime(reactionTime);

            if (!this.isOnline) {
                try {
                    StorageManager.recordGameResult({
                        isCorrect: true, time: reactionTime, compoundId: targetId,
                        category: target.category || '',
                        difficulty: this.settings.cpuLevel || target.difficulty || 1,
                        stage: stageNow, combo: this.combo
                    });
                } catch (e) { console.error('Storage error:', e); }
            }

            if (this.onCorrectAnswer) {
                try {
                    this.onCorrectAnswer(target, {
                        mode: this.mode, isOnline: this.isOnline,
                        stage: stageNow, round: this.roundNumber,
                        difficulty: this.settings.cpuLevel || 0,
                        combo: this.combo, reactionTime: reactionTime
                    });
                } catch (e) { console.error('onCorrectAnswer error:', e); }
            }

            this._finishRound(true, 'player');
        } else {
            this.combo = 0;
            this._calculateScore(false, 0, 'player', reactionTime);
            AudioManager.playSound('wrong');
            if (!this.isOnline) {
                try {
                    StorageManager.recordGameResult({
                        isCorrect: false, time: reactionTime, compoundId: targetId,
                        category: target.category || '',
                        difficulty: this.settings.cpuLevel || target.difficulty || 1,
                        stage: stageNow, combo: 0
                    });
                } catch (e) { console.error('Storage error:', e); }
            }
            this._notify({ type: 'wrong', id: tapId });
            this._scheduleNextClue(1600);
        }

        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'player_tap', cardId: tapId, isCorrect: isCorrect, scores: this.scores
            });
        }
    }

    handleCpuAnswer(cardId, isCorrect) {
        const r = this.currentRound;
        if (!r || !r.isActive || r.settled) return;

        if (isCorrect) {
            this.combo = 0;
            this._calculateScore(true, r.currentStage, 'opponent', 0);
            AudioManager.playSound('wrong');
            this._finishRound(false, 'cpu');
        } else {
            this.scores.opponent = Math.max(0, this.scores.opponent - 50);
            this._notify({ type: 'cpu_wrong', id: cardId });
            AudioManager.playSound('wrong');
            this._scheduleNextClue(1600);
        }
    }

    /* ========================= オンライン相手得点 API ========================= */
    scoreOpponentCorrect(stage) {
        if (this.currentRound.winner === 'player') return false;
        if (this.currentRound.settled) return false;
        if (this._opponentScoredRound === this.roundNumber) return false;
        this._opponentScoredRound = this.roundNumber;
        this.currentRound.winner = 'opponent';
        this.combo = 0;
        const st = Number(stage) || this.currentRound.currentStage || 1;
        this._calculateScore(true, st, 'opponent', 0);
        return true;
    }

    scoreOpponentWrong() {
        if (this.currentRound.winner || this.currentRound.settled) return false;
        this.scores.opponent = Math.max(0, this.scores.opponent - 50);
        this._notify({ type: 'score_update' });
        return true;
    }

    getAuthoritativeScores() {
        return {
            player: Number(this.scores.player) || 0,
            opponent: Number(this.scores.opponent) || 0
        };
    }

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

    /* ========================= 得点 ========================= */
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

    /* ========================= ラウンド終了（冪等） ========================= */
    _finishRound(playerWon, reason) {
        const r = this.currentRound;
        if (!r || r.settled) return;
        this._clearTimers();
        if (this.cpu) this.cpu.cancelThinking();

        r.isActive = false;
        r.settled = true;
        r.winner = playerWon ? 'player' : 'opponent';
        r.reason = reason || (playerWon ? 'player' : 'opponent');
        this.state = 'RESULT';
        this.finalDeadline = 0;

        if (playerWon) this.roundWins.player++;
        else if (r.reason === 'timeout') this.roundWins.timeout++;
        else this.roundWins.opponent++;

        if (this.cpu && this.cpu.reportRound) this.cpu.reportRound(playerWon);

        const target = r.target || {};
        const clueData = this._clueOf(target.id);
        const explanation = (clueData && clueData.explanation) ? clueData.explanation : '解説データなし';

        this._notify({
            type: 'round_end',
            playerWon: playerWon,
            target: target,
            explanation: explanation,
            reason: r.reason,
            stage: r.currentStage,
            combo: this.combo
        });

        if (this.onRoundEnd) {
            this.onRoundEnd({
                playerWon: playerWon, target: target,
                explanation: explanation, reason: r.reason
            });
        }

        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({
                type: 'round_end',
                round: this.roundNumber,
                playerWon: playerWon,
                target: target,
                scores: this.getAuthoritativeScores(),
                phase: 'result'
            });
        }
    }

    endGame() {
        this._clearTimers();
        this.state = 'IDLE';
        this.finalDeadline = 0;
        this.cardsReady = false;
        const summary = {
            totalRounds: this.totalRounds,
            playerScore: this.scores.player,
            cpuScore: this.scores.opponent,
            maxCombo: this.maxCombo,
            roundWins: Object.assign({}, this.roundWins),
            difficulty: this.settings.cpuLevel || 0,
            winner: this.scores.player > this.scores.opponent ? 'player' :
                this.scores.player < this.scores.opponent ? 'cpu' : 'draw'
        };
        this._notify({ type: 'game_end', summary: summary });
        if (this.onGameEnd) this.onGameEnd(summary);
        if (this.isOnline && this.isHost && this.onOnlineStateChange) {
            this.onOnlineStateChange({ type: 'game_end', scores: this.getAuthoritativeScores(), phase: 'finished' });
        }
    }

    skipRound() {
        const r = this.currentRound;
        if (!r || !r.isActive || r.settled) return;
        if (this.cpu) this.cpu.cancelThinking();
        this.combo = 0;
        this._finishRound(false, 'skip');
    }

    pause() {
        this._clearTimers();
        this.finalDeadline = 0;
        this._pendingRead = false;
        if (this.cpu) this.cpu.cancelThinking();
        try { AudioManager.stop(); } catch (e) { }
    }

    /* ========================= 通知 ========================= */
    _notify(data = {}) {
        if (!this.onUpdate) return;
        const r = this.currentRound;
        this.onUpdate(Object.assign({
            state: this.state,
            mode: this.mode,
            round: r,
            scores: this.scores,
            roundNumber: this.roundNumber,
            totalRounds: this.totalRounds,
            combo: this.combo,
            maxCombo: this.maxCombo,
            roundWins: this.roundWins,
            canNext: this.canNextClue(),
            isFinal: this.isFinalStage(),
            finalDeadline: this.finalDeadline,
            cardsReady: this.cardsReady
        }, data));
    }

    getCategories() { return Array.from(this.categories).sort(); }
    getCompoundCount() { return this.compounds.length; }
}