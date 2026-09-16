/**
 * CPUプレイヤーの思考と行動を管理するクラス
 */
class CPUPlayer {
    constructor(level = 3) {
        this.level = level; // 1-7
        this.isThinking = false;
        this.thinkingTimer = null;
        
        // レベルごとの基本パラメータ
        this.params = this._getParams(level);
    }

    /**
     * レベルパラメータの定義
     * baseTime: 基本反応時間(ms)
     * stageReduction: Clueが1段階進むごとに短縮される時間
     * errorRate: 誤答率 (0.0 - 1.0)
     * insightStage: 何Stage目で正解に辿り着くか（東大レベルは1で確定）
     */
    _getParams(level) {
        const profiles = {
            1: { baseTime: 4000, stageReduction: 200, errorRate: 0.4, insightStage: 4 },
            2: { baseTime: 3000, stageReduction: 400, errorRate: 0.3, insightStage: 3 },
            3: { baseTime: 2000, stageReduction: 500, errorRate: 0.15, insightStage: 3 },
            4: { baseTime: 1500, stageReduction: 600, errorRate: 0.05, insightStage: 2 },
            5: { baseTime: 1000, stageReduction: 700, errorRate: 0.02, insightStage: 2 },
            6: { baseTime: 600,  stageReduction: 800, errorRate: 0.01, insightStage: 1 },
            7: { baseTime: 300,  stageReduction: 1000, errorRate: 0.0, insightStage: 1 } // 東大レベル：分子式で即答
        };
        return profiles[level] || profiles[3];
    }

    /**
     * 思考を開始する
     * @param {string} targetId - 正解の化合物ID
     * @param {Array} cards - 場のカード情報
     * @param {number} currentStage - 現在のClue Stage
     * @param {Function} onComplete - 行動完了時のコールバック (actionType, cardId)
     */
    startThinking(targetId, cards, currentStage, onComplete) {
        if (this.isThinking) return;
        this.isThinking = true;

        // 1. 正解に辿り着けるStageか判定
        const canSolve = currentStage >= this.params.insightStage;
        
        // 2. 誤答するかの判定
        const willMakeMistake = !canSolve && Math.random() < this.params.errorRate;

        // 3. 反応時間の計算
        // Stageが進むほど（情報が増えるほど）時間は短くなる
        let reactionTime = this.params.baseTime - (currentStage * this.params.stageReduction);
        
        // ノイズ（迷い）を追加
        reactionTime += (Math.random() * 500) - 250; 
        reactionTime = Math.max(200, reactionTime); // 最低0.2秒はかかる

        // 4. 行動の決定
        let targetActionId = targetId;
        let actionType = 'tap'; // 'tap' or 'wrong'

        if (willMakeMistake) {
            // 誤答ロジック：正解と「タグ（官能基）」が近いが「構造」が異なるものを選ぶ
            targetActionId = this._findDistractor(targetId, cards);
            actionType = 'wrong';
            reactionTime *= 1.2; // 誤答するときは少し迷う
        } else if (!canSolve) {
            // 正解だが、まだ確信が持てない場合は待機（何もしない）
            // ※待機している間にプレイヤーが取るか、次のClueが出る
            this.isThinking = false;
            return; 
        }

        // 5. タイマーセット
        this.thinkingTimer = setTimeout(() => {
            this.isThinking = false;
            onComplete(actionType, targetActionId);
        }, reactionTime);
    }

    /**
     * 誤答候補（ Distractor ）を見つける
     * 正解の化合物と「タグ」が1つ以上一致し、かつIDが異なるものからランダム選択
     */
    _findDistractor(targetId, cards) {
        const targetCard = cards.find(c => c.id === targetId);
        if (!targetCard) return targetId;

        // タグの類似度を計算
        const candidates = cards.filter(c => {
            if (c.id === targetId) return false;
            // 少なくとも1つのタグ（官能基など）が共通しているものを候補にする
            const commonTags = c.tags.filter(tag => targetCard.tags.includes(tag));
            return commonTags.length > 0;
        });

        if (candidates.length === 0) return targetId; // 候補がいなければ正解を選ぶ（誤答不可）
        
        // ランダムに1つ選択
        return candidates[Math.floor(Math.random() * candidates.length)].id;
    }

    /**
     * 思考を中断する（プレイヤーが先に正解した場合など）
     */
    cancelThinking() {
        if (this.thinkingTimer) {
            clearTimeout(this.thinkingTimer);
            this.thinkingTimer = null;
        }
        this.isThinking = false;
    }
}
