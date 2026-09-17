/**
 * StorageManager - ローカルストレージ管理
 * 統計機能拡張版
 */
const StorageManager = {
    PREFIX: 'karuta_',
    
    init() {
        console.log('StorageManager initialized');
    },

    // ========== 設定 ==========
    
    loadSettings() {
        try {
            const data = localStorage.getItem(this.PREFIX + 'settings');
            if (data) {
                return JSON.parse(data);
            }
        } catch (e) {
            console.warn('Failed to load settings:', e);
        }
        // デフォルト値
        return {
            voiceEnabled: true,
            voiceSpeed: 1.0,
            cardCount: 9
        };
    },

    updateSetting(key, value) {
        const settings = this.loadSettings();
        settings[key] = value;
        try {
            localStorage.setItem(this.PREFIX + 'settings', JSON.stringify(settings));
        } catch (e) {
            console.warn('Failed to save setting:', e);
        }
    },

    // ========== 統計データ ==========

    /**
     * 統計データの構造
     * {
     *   totalGames: 総プレイ回数,
     *   totalCorrect: 総正解数,
     *   totalWrong: 総不正解数,
     *   totalScore: 総得点,
     *   maxCombo: 最高コンボ,
     *   cpuWins: CPU戦勝利数,
     *   cpuLosses: CPU戦敗北数,
     *   cpuDraws: CPU戦引き分け数,
     *   totalTime: 総プレイ時間(ms),
     *   byCategory: { [category]: { correct: n, wrong: n } },
     *   byDifficulty: { [difficulty]: { correct: n, wrong: n } },
     *   byStage: { [stage]: { correct: n, wrong: n } },
     *   history: [ { date, result, score, compoundId, category, stage, time } ]
     * }
     */
    loadStats() {
        try {
            const data = localStorage.getItem(this.PREFIX + 'stats');
            if (data) {
                return JSON.parse(data);
            }
        } catch (e) {
            console.warn('Failed to load stats:', e);
        }
        return this.getDefaultStats();
    },

    getDefaultStats() {
        return {
            totalGames: 0,
            totalCorrect: 0,
            totalWrong: 0,
            totalScore: 0,
            maxCombo: 0,
            cpuWins: 0,
            cpuLosses: 0,
            cpuDraws: 0,
            totalTime: 0,
            byCategory: {},
            byDifficulty: {},
            byStage: {},
            history: []
        };
    },

    saveStats(stats) {
        try {
            localStorage.setItem(this.PREFIX + 'stats', JSON.stringify(stats));
        } catch (e) {
            console.warn('Failed to save stats:', e);
        }
    },

    /**
     * ゲーム結果を記録
     */
    recordGameResult(result) {
        const stats = this.loadStats();
        
        stats.totalGames++;
        
        if (result.isCorrect) {
            stats.totalCorrect++;
        } else {
            stats.totalWrong++;
        }
        
        if (result.score) {
            stats.totalScore += result.score;
        }
        
        if (result.combo && result.combo > stats.maxCombo) {
            stats.maxCombo = result.combo;
        }
        
        if (result.time) {
            stats.totalTime += result.time;
        }
        
        // 単元別
        if (result.category) {
            if (!stats.byCategory[result.category]) {
                stats.byCategory[result.category] = { correct: 0, wrong: 0 };
            }
            if (result.isCorrect) {
                stats.byCategory[result.category].correct++;
            } else {
                stats.byCategory[result.category].wrong++;
            }
        }
        
        // 難易度別
        if (result.difficulty !== undefined) {
            if (!stats.byDifficulty[result.difficulty]) {
                stats.byDifficulty[result.difficulty] = { correct: 0, wrong: 0 };
            }
            if (result.isCorrect) {
                stats.byDifficulty[result.difficulty].correct++;
            } else {
                stats.byDifficulty[result.difficulty].wrong++;
            }
        }
        
        // ステージ別
        if (result.stage) {
            if (!stats.byStage[result.stage]) {
                stats.byStage[result.stage] = { correct: 0, wrong: 0 };
            }
            if (result.isCorrect) {
                stats.byStage[result.stage].correct++;
            } else {
                stats.byStage[result.stage].wrong++;
            }
        }
        
        // 履歴（最新100件）
        stats.history.unshift({
            date: new Date().toISOString(),
            result: result.isCorrect ? 'correct' : 'wrong',
            score: result.score || 0,
            compoundId: result.compoundId || '',
            category: result.category || '',
            stage: result.stage || 0,
            time: result.time || 0
        });
        if (stats.history.length > 100) {
            stats.history = stats.history.slice(0, 100);
        }
        
        this.saveStats(stats);
    },

    /**
     * CPU戦結果を記録
     */
    recordCpuResult(winner) {
        const stats = this.loadStats();
        if (winner === 'player') {
            stats.cpuWins++;
        } else if (winner === 'cpu') {
            stats.cpuLosses++;
        } else {
            stats.cpuDraws++;
        }
        this.saveStats(stats);
    },

    /**
     * 統計サマリーを取得
     */
    getSummary() {
        const stats = this.loadStats();
        const total = stats.totalCorrect + stats.totalWrong;
        const accuracy = total > 0 ? Math.round((stats.totalCorrect / total) * 100) : 0;
        const avgTime = stats.totalGames > 0 ? Math.round(stats.totalTime / stats.totalGames / 1000 * 10) / 10 : 0;
        
        return {
            totalGames: stats.totalGames,
            totalCorrect: stats.totalCorrect,
            totalWrong: stats.totalWrong,
            accuracy: accuracy,
            totalScore: stats.totalScore,
            maxCombo: stats.maxCombo,
            avgTime: avgTime,
            cpuWins: stats.cpuWins,
            cpuLosses: stats.cpuLosses,
            cpuDraws: stats.cpuDraws,
            cpuWinRate: stats.cpuWins + stats.cpuLosses > 0 
                ? Math.round((stats.cpuWins / (stats.cpuWins + stats.cpuLosses)) * 100) 
                : 0,
            byCategory: stats.byCategory,
            byDifficulty: stats.byDifficulty,
            byStage: stats.byStage,
            history: stats.history.slice(0, 10)
        };
    },

    /**
     * 全統計データをリセット
     */
    resetAll() {
        try {
            localStorage.removeItem(this.PREFIX + 'stats');
            localStorage.removeItem(this.PREFIX + 'settings');
        } catch (e) {
            console.warn('Failed to reset:', e);
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    StorageManager.init();
});
