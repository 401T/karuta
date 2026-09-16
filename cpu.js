/**
 * CPUPlayer - CPU対戦相手の思考と行動を管理
 * 
 * 【思考モデル】
 * 1. 情報認識: 読み札のStageを確認
 * 2. 推論: 自分のレベル(insightStage)に達しているか判定
 * 3. 確信: 達していれば正解を確信、達していなければ迷うor誤答
 * 4. 反応: 計算された時間後にアクションを実行
 */
class CPUPlayer {
    constructor(level = 3) {
        this.level = level;
        this.isThinking = false;
        this.thinkingTimer = null;
        this.params = this._getParams(level);
    }

    /**
     * レベル別パラメータ定義
     * @param {number} level - 1〜7
     * @returns {Object} パラメータオブジェクト
     */
    _getParams(level) {
        const profiles = {
            1: { name: '初心者', baseTime: 4000, stageReduction: 200, errorRate: 0.4, insightStage: 4 },
            2: { name: '基礎',   baseTime: 3000, stageReduction: 400, errorRate: 0.3, insightStage: 3 },
            3: { name: '標準',   baseTime: 2000, stageReduction: 500, errorRate: 0.15, insightStage: 3 },
            4: { name: '上位',   baseTime: 1500, stageReduction: 600, errorRate: 0.05, insightStage: 2 },
            5: { name: '難関大', baseTime: 1000, stageReduction: 700, errorRate: 0.02, insightStage: 2 },
            6: { name: '上級',   baseTime: 600,  stageReduction: 800, errorRate: 0.01, insightStage: 1 },
            7: { name: '東大',   baseTime: 300,  stageReduction: 1000, errorRate: 0.0, insightStage: 1 } // 分子式で即答
        };
        return profiles[level] || profiles[3];
    }

    /**
     * 思考開始
     * @param {string} targetId - 正解の化合物ID
     * @param {Array} cards - 場のカードリスト
     * @param {number} currentStage - 現在の読み札Stage
     * @param {Function} onComplete - 完了コールバック (actionType, cardId)
     */
    startThinking(targetId, cards, currentStage, onComplete) {
        if (this.isThinking) return;
        this.isThinking = true;

        // 1. 正解に辿り着けるStageか判定
        const canSolve = currentStage >= this.params.insightStage;
        
        // 2. 誤答するかの判定
        // 「まだ確信が持てない(currentStage < insightStage)」かつ「誤答率」を満たす場合
        const willMakeMistake = !canSolve && Math.random() < this.params.errorRate;

        // 3. 反応時間の計算
        // Stageが進むほど（情報が増えるほど）時間は短くなる
        let reactionTime = this.params.baseTime - (currentStage * this.params.stageReduction);
        
        // ノイズ（迷い）を追加
        reactionTime += (Math.random() * 400) - 200; 
        reactionTime = Math.max(200, reactionTime); // 最低0.2秒はかかる

        // 4. 行動の決定
        let targetActionId = targetId;
        let actionType = 'tap'; // 'tap' (正解) or 'wrong' (誤答) or 'wait' (待機)

        if (willMakeMistake) {
            // 誤答ロジック：正解と「タグ（官能基）」が近いが「構造」が異なるものを選ぶ
            targetActionId = this._findDistractor(targetId, cards);
            actionType = 'wrong';
            reactionTime *= 1.2; // 誤答するときは少し迷う（時間がかかる）
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
     * 正解の化合物と「タグ（官能基など）」が1つ以上一致し、かつIDが異なるものからランダム選択
     * これにより「アルコールとフェノールの取り違え」「アルデヒドとケトンの取り違え」などを再現
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

