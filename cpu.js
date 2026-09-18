/* =========================================================================
   cpu.js  —  CPUPlayer v2.1 「ユーザーと競る」バランス型 AI
   -------------------------------------------------------------------------
   【設計方針】
     1) 反応時間は人間の「読み＋判断」レンジ（1.2〜9.5秒）に収める
     2) insightStage（気づく読み札）を 1〜3 に設定
     3) hesitate（迷って1札見送る）で取りこぼしを作る
     4) errorRate で官能基が近い別札を叩かせる（人間と同じミス）
     5) ラバーバンド: 点差・連勝に応じて ±25% の範囲でのみ強さを動かす
     6) 最終札では必ずアクションする（進行が止まらない）
   【v2.1 変更】
     ・startThinking の ctx 未指定時も this.ctx を使って安全に動くよう修正
     ・cancelThinking 後に isThinking が残るケースを明示的にクリア
========================================================================= */
class CPUPlayer {
    constructor(level = 3) {
        this.level = Number(level) || 3;
        this.isThinking = false;
        this.thinkingTimer = null;
        this.params = this._getParams(this.level);
        this.ctx = {
            playerScore: 0, cpuScore: 0, round: 0, totalRounds: 10,
            currentStage: 0, maxStage: 4, isFinalStage: false, playerAvgTime: 5000
        };
        this.streak = { cpu: 0, player: 0 };
        this.speedMult = 1;
        this.errorMult = 1;
        this.log = [];
    }

    /** レベル別プロファイル（0 = 練習モードは CPU なし） */
    _getParams(level) {
        const profiles = {
            1: { name: '易しい', insightStage: 3, baseTime: 5400, stageReduction: 800, hesitate: 0.45, errorRate: 0.26, finalErrorRate: 0.14, minTime: 2000, maxTime: 9500 },
            2: { name: '初級',   insightStage: 3, baseTime: 4600, stageReduction: 800, hesitate: 0.36, errorRate: 0.20, finalErrorRate: 0.10, minTime: 1800, maxTime: 9000 },
            3: { name: '普通',   insightStage: 2, baseTime: 4300, stageReduction: 900, hesitate: 0.30, errorRate: 0.14, finalErrorRate: 0.07, minTime: 1500, maxTime: 8500 },
            4: { name: '上位',   insightStage: 2, baseTime: 3600, stageReduction: 800, hesitate: 0.24, errorRate: 0.11, finalErrorRate: 0.06, minTime: 1400, maxTime: 8000 },
            5: { name: '難関',   insightStage: 2, baseTime: 3100, stageReduction: 700, hesitate: 0.18, errorRate: 0.09, finalErrorRate: 0.05, minTime: 1300, maxTime: 7000 },
            6: { name: '上級',   insightStage: 1, baseTime: 3300, stageReduction: 650, hesitate: 0.14, errorRate: 0.07, finalErrorRate: 0.04, minTime: 1250, maxTime: 6500 },
            7: { name: '難しい', insightStage: 1, baseTime: 2700, stageReduction: 550, hesitate: 0.10, errorRate: 0.05, finalErrorRate: 0.03, minTime: 1200, maxTime: 6000 }
        };
        return profiles[level] || profiles[3];
    }

    setContext(ctx) {
        if (!ctx) return;
        this.ctx = Object.assign({}, this.ctx, ctx);
        this._recalculate();
    }

    /** ラバーバンド：点差と連勝から speed / error の倍率を決める */
    _recalculate() {
        const c = this.ctx;
        const diff = (Number(c.cpuScore) || 0) - (Number(c.playerScore) || 0);
        let speed = 1, err = 1;

        if (diff > 900)       { speed = 1.28; err = 1.60; }
        else if (diff > 450)  { speed = 1.16; err = 1.30; }
        else if (diff > 150)  { speed = 1.06; err = 1.12; }
        else if (diff < -900) { speed = 0.78; err = 0.55; }
        else if (diff < -450) { speed = 0.86; err = 0.72; }
        else if (diff < -150) { speed = 0.94; err = 0.88; }

        if (this.streak.cpu >= 3)          { speed *= 1.18; err *= 1.45; }
        else if (this.streak.cpu === 2)    { speed *= 1.08; err *= 1.18; }
        if (this.streak.player >= 3)       { speed *= 0.84; err *= 0.70; }
        else if (this.streak.player === 2) { speed *= 0.93; err *= 0.86; }

        const remain = (Number(c.totalRounds) || 10) - (Number(c.round) || 0);
        if (remain <= 2 && Math.abs(diff) <= 200) { speed *= 0.95; err *= 0.9; }

        this.speedMult = Math.max(0.75, Math.min(1.35, speed));
        this.errorMult = Math.max(0.45, Math.min(1.9, err));
    }

    reportRound(playerWon) {
        if (playerWon) { this.streak.player++; this.streak.cpu = 0; }
        else           { this.streak.cpu++;    this.streak.player = 0; }
        this._recalculate();
    }

    reportPlayerTime(ms) {
        const t = Number(ms);
        if (!isFinite(t) || t <= 0) return;
        this.log.push(t);
        if (this.log.length > 6) this.log.shift();
        this.ctx.playerAvgTime = this.log.reduce((a, b) => a + b, 0) / this.log.length;
    }

    /**
     * 思考開始
     * @param {string} targetId    正解カードID
     * @param {Array}  cards       場のカード
     * @param {number} currentStage 現在の読み札ステージ
     * @param {Function} onComplete (actionType, cardId) => void
     * @param {Object} [ctx]       状況コンテキスト
     */
    startThinking(targetId, cards, currentStage, onComplete, ctx) {
        if (ctx) this.setContext(ctx);
        if (this.isThinking) return;
        if (typeof onComplete !== 'function') return;

        const p = this.params;
        const stage = Number(currentStage) || 0;
        const maxStage = Number(this.ctx.maxStage) || 4;
        const isFinal = !!(this.ctx && this.ctx.isFinalStage) || stage >= maxStage;

        // 1) まだ気づいていない → 待機
        const canSolve = (stage >= p.insightStage) || isFinal;
        if (!canSolve) { this.isThinking = false; return; }

        // 2) 迷い（確信できたばかりの札では見送ることがある）
        if (!isFinal && stage === p.insightStage && Math.random() < p.hesitate * this.errorMult) {
            this.isThinking = false;
            return;
        }

        this.isThinking = true;

        // 3) 反応時間
        const over = Math.max(0, stage - p.insightStage);
        let reactionTime = p.baseTime - over * p.stageReduction;
        reactionTime *= this.speedMult;
        reactionTime += (Math.random() * 700) - 250;
        const avg = Number(this.ctx.playerAvgTime) || 5000;
        if (avg < 2500) reactionTime *= 0.92;
        reactionTime = Math.max(p.minTime, Math.min(p.maxTime, reactionTime));

        // 4) 正誤判定
        const baseErr = isFinal ? p.finalErrorRate : p.errorRate;
        const willMiss = Math.random() < (baseErr * this.errorMult);

        let actionType = 'tap';
        let actionId = targetId;
        if (willMiss) {
            actionType = 'wrong';
            actionId = this._findDistractor(targetId, cards);
            reactionTime *= 1.12;
        }

        this.thinkingTimer = setTimeout(() => {
            this.thinkingTimer = null;
            this.isThinking = false;
            try { onComplete(actionType, actionId); }
            catch (e) { console.error('CPU callback error:', e); }
        }, reactionTime);
    }

    /** 誤答候補（タグ・単元・分子式が近いものを優先） */
    _findDistractor(targetId, cards) {
        const list = Array.isArray(cards) ? cards.filter(c => c && String(c.id) !== String(targetId)) : [];
        if (list.length === 0) return targetId;

        const target = (cards || []).find(c => c && String(c.id) === String(targetId)) || null;
        if (!target) return list[Math.floor(Math.random() * list.length)].id;

        const targetTags = Array.isArray(target.tags) ? target.tags.map(String) : [];
        const scored = list.map(c => {
            let s = Math.random() * 1.5;
            const tags = Array.isArray(c.tags) ? c.tags.map(String) : [];
            s += tags.filter(t => targetTags.includes(t)).length * 3;
            if (c.category && target.category && c.category === target.category) s += 2;
            if (c.formula && target.formula && c.formula === target.formula) s += 4;
            return { id: c.id, s: s };
        }).sort((a, b) => b.s - a.s);

        const pool = scored.slice(0, Math.min(3, scored.length));
        return pool[Math.floor(Math.random() * pool.length)].id;
    }

    cancelThinking() {
        if (this.thinkingTimer) { clearTimeout(this.thinkingTimer); this.thinkingTimer = null; }
        this.isThinking = false;
    }

    reset() {
        this.cancelThinking();
        this.streak = { cpu: 0, player: 0 };
        this.log = [];
        this.speedMult = 1;
        this.errorMult = 1;
    }
}

