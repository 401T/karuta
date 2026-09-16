/**
 * ゲームエンジン：状態管理とルール適用
 */
class GameEngine {
    constructor() {
        this.state = 'INIT'; // INIT, DEAL, READING, PLAYING, RESULT
        this.compounds = []; // 全化合物データ
        this.clues = {};     // 読み札データ (compound_idをキーにした辞書)
        
        // 現在のラウンド状態
        this.currentRound = {
            target: null,      // 正解の化合物オブジェクト
            cards: [],         // 場のカードリスト
            currentStage: 0,   // 現在のClue Stage (1始まり)
            maxStage: 4,
            isActive: false
        };

        this.scores = { player: 0, cpu: 0 };
        this.cpu = new CPUPlayer(3); // デフォルトLv3
        this.onUpdateUI = null; // UI更新用コールバック
    }

    /**
     * データを読み込む
     */
    async loadData() {
        try {
            const [compRes, clueRes] = await Promise.all([
                fetch('data/compounds.json'),
                fetch('data/clues.json')
            ]);
            this.compounds = await compRes.json();
            const clueArray = await clueRes.json();
            
            // ClueデータをIDで引けるように変換
            clueArray.forEach(c => { this.clues[c.compound_id] = c; });
            return true;
        } catch (e) {
            console.error("データ読み込みエラー:", e);
            return false;
        }
    }

    /**
     * ゲーム設定
     */
    configure(settings) {
        if (settings.cpuLevel) {
            this.cpu = new CPUPlayer(settings.cpuLevel);
        }
    }

    /**
     * ラウンド開始準備
     */
    startNewRound() {
        // 1. 正解をランダムに選ぶ
        const target = this.compounds[Math.floor(Math.random() * this.compounds.length)];
        
        // 2. 場のカードを作る (正解含む12枚)
        const others = this.compounds
            .filter(c => c.id !== target.id)
            .sort(() => Math.random() - 0.5)
            .slice(0, 11);
        
        const cards = [target, ...others].sort(() => Math.random() - 0.5); // シャッフル

        this.currentRound = {
            target: target,
            cards: cards,
            currentStage: 0,
            maxStage: this.clues[target.id] ? this.clues[target.id].stages.length : 4,
            isActive: true
        };

        this.state = 'DEAL';
        this._notifyUI();
        
        // 少し間を置いて読み札開始
        setTimeout(() => this.nextClue(), 1000);
    }

    /**
     * 読み札を1段階進める
     */
    nextClue() {
        if (!this.currentRound.isActive) return;
        
        this.currentRound.currentStage++;
        this.state = 'READING';
        this._notifyUI();

        // CPUの思考開始
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

    /**
     * プレイヤーのタップ処理
     */
    handlePlayerTap(cardId) {
        if (!this.currentRound.isActive) return;

        const isCorrect = (cardId === this.currentRound.target.id);
        
        if (isCorrect) {
            this.cpu.cancelThinking(); // CPUが考えていても中断
            this._calculateScore(true, this.currentRound.currentStage);
            this._finishRound(true);
        } else {
            this._calculateScore(false, 0);
            this._notifyUI({ type: 'wrong', id: cardId });
        }
    }

    /**
     * CPUの回答処理
     */
    handleCpuAnswer(cardId, isCorrect) {
        if (!this.currentRound.isActive) return;

        if (isCorrect) {
            this.currentRound.isActive = false; // 試合終了
            this._calculateScore(true, this.currentRound.currentStage, 'cpu');
            this._finishRound(false); // プレイヤー敗北
        } else {
            // CPUの誤答
            this._notifyUI({ type: 'cpu_wrong', id: cardId });
            // CPUが誤答した場合、ペナルティとして次のClueへ進むチャンスを与える（あるいは即終了）
            // ここでは「CPUミス＝プレイヤー有利」とし、次のClueへ自動進行させる
            setTimeout(() => this.nextClue(), 1500);
        }
    }

    /**
     * スコア計算
     * 早いStageほど高得点
     */
    _calculateScore(isCorrect, stage, who = 'player') {
        if (!isCorrect) {
            if (who === 'player') this.scores.player = Math.max(0, this.scores.player - 50);
            return;
        }

        // 基本点 1000点
        // Stage 1で正解: 1000
        // Stage 2で正解: 800
        // Stage 3で正解: 600 ...
        const baseScore = 1000;
        const penalty = (stage - 1) * 200;
        const gained = Math.max(100, baseScore - penalty);

        // 難易度ボーナス
        const diffBonus = this.currentRound.target.difficulty * 50;

        if (who === 'player') {
            this.scores.player += gained + diffBonus;
        } else {
            this.scores.cpu += gained + diffBonus;
        }
        
        this._notifyUI({ type: 'score_update' });
    }

    /**
     * ラウンド終了処理
     */
    _finishRound(playerWon) {
        this.currentRound.isActive = false;
        this.state = 'RESULT';
        this._notifyUI({ 
            type: 'round_end', 
            playerWon: playerWon,
            target: this.currentRound.target,
            explanation: this.clues[this.currentRound.target.id]?.explanation || "解説データなし"
        });
    }

    /**
     * UI更新通知
     */
    _notifyUI(data = {}) {
        if (this.onUpdateUI) {
            this.onUpdateUI({
                state: this.state,
                round: this.currentRound,
                scores: this.scores,
                ...data
            });
        }
    }
}
