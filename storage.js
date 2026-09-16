/**
 * StorageManager - データの永続化と統計管理
 */
const StorageManager = {
    KEYS: {
        SETTINGS: 'kettei_settings',
        STATS: 'kettei_stats',
        HISTORY: 'kettei_history'
    },

    defaultSettings: {
        voiceEnabled: true,
        voiceSpeed: 1.0,
        cardCount: 9,
        cpuLevel: 3
    },

    defaultStats: {
        totalGames: 0,
        totalCorrect: 0,
        totalWrong: 0,
        totalTime: 0,
        categoryStats: {}, // { "alcohol": { correct: 0, wrong: 0 }, ... }
        compoundStats: {}  // { "ethanol": { correct: 0, wrong: 0, totalTime: 0 }, ... }
    },

    /**
     * 初期化
     */
    init() {
        if (!this.loadSettings()) {
            this.saveSettings(this.defaultSettings);
        }
        if (!this.loadStats()) {
            this.saveStats(this.defaultStats);
        }
    },

    // --- Settings ---

    saveSettings(settings) {
        try {
            localStorage.setItem(this.KEYS.SETTINGS, JSON.stringify(settings));
        } catch (e) {
            console.error('Failed to save settings:', e);
        }
    },

    loadSettings() {
        try {
            const data = localStorage.getItem(this.KEYS.SETTINGS);
            return data ? JSON.parse(data) : null;
        } catch (e) {
            console.error('Failed to load settings:', e);
            return null;
        }
    },

    updateSetting(key, value) {
        const settings = this.loadSettings() || this.defaultSettings;
        settings[key] = value;
        this.saveSettings(settings);
    },

    // --- Stats ---

    saveStats(stats) {
        try {
            localStorage.setItem(this.KEYS.STATS, JSON.stringify(stats));
        } catch (e) {
            console.error('Failed to save stats:', e);
        }
    },

    loadStats() {
        try {
            const data = localStorage.getItem(this.KEYS.STATS);
            return data ? JSON.parse(data) : null;
        } catch (e) {
            console.error('Failed to load stats:', e);
            return null;
        }
    },

    /**
     * ゲーム結果を記録
     * @param {Object} result - { isCorrect, time, compoundId, category }
     */
    recordGameResult(result) {
        const stats = this.loadStats() || this.defaultStats;

        // 全体統計
        stats.totalGames++;
        if (result.isCorrect) {
            stats.totalCorrect++;
        } else {
            stats.totalWrong++;
        }
        stats.totalTime += result.time;

        // カテゴリ別統計
        if (result.category) {
            if (!stats.categoryStats[result.category]) {
                stats.categoryStats[result.category] = { correct: 0, wrong: 0 };
            }
            if (result.isCorrect) {
                stats.categoryStats[result.category].correct++;
            } else {
                stats.categoryStats[result.category].wrong++;
            }
        }

        // 化合物別統計
        if (result.compoundId) {
            if (!stats.compoundStats[result.compoundId]) {
                stats.compoundStats[result.compoundId] = { correct: 0, wrong: 0, totalTime: 0 };
            }
            if (result.isCorrect) {
                stats.compoundStats[result.compoundId].correct++;
            } else {
                stats.compoundStats[result.compoundId].wrong++;
            }
            stats.compoundStats[result.compoundId].totalTime += result.time;
        }

        this.saveStats(stats);
    },

    /**
     * 統計サマリーを取得
     * @returns {Object}
     */
    getSummary() {
        const stats = this.loadStats() || this.defaultStats;
        const total = stats.totalCorrect + stats.totalWrong;
        const accuracy = total > 0 ? (stats.totalCorrect / total) * 100 : 0;
        const avgTime = stats.totalGames > 0 ? stats.totalTime / stats.totalGames : 0;

        return {
            totalGames: stats.totalGames,
            accuracy: accuracy.toFixed(1),
            avgTime: avgTime.toFixed(2),
            totalCorrect: stats.totalCorrect,
            totalWrong: stats.totalWrong
        };
    },

    /**
     * 分野別正答率を取得
     * @returns {Array}
     */
    getCategoryAccuracy() {
        const stats = this.loadStats() || this.defaultStats;
        const result = [];

        for (const [category, data] of Object.entries(stats.categoryStats)) {
            const total = data.correct + data.wrong;
            const accuracy = total > 0 ? (data.correct / total) * 100 : 0;
            result.push({
                category: category,
                accuracy: accuracy.toFixed(1),
                total: total
            });
        }

        // 正答率の低い順（苦手な順）にソート
        return result.sort((a, b) => parseFloat(a.accuracy) - parseFloat(b.accuracy));
    },

    /**
     * 苦手な化合物トップNを取得
     * @param {number} n
     * @returns {Array}
     */
    getWeakCompounds(n = 5) {
        const stats = this.loadStats() || this.defaultStats;
        const result = [];

        for (const [id, data] of Object.entries(stats.compoundStats)) {
            const total = data.correct + data.wrong;
            if (total < 3) continue; // 3回未満は除外（サンプル数不足）
            
            const accuracy = (data.correct / total) * 100;
            const avgTime = data.totalTime / total;

            result.push({
                id: id,
                accuracy: accuracy.toFixed(1),
                avgTime: avgTime.toFixed(2),
                total: total
            });
        }

        // 正答率の低い順にソート
        return result.sort((a, b) => parseFloat(a.accuracy) - parseFloat(b.accuracy)).slice(0, n);
    },

    /**
     * 全データをリセット
     */
    resetAll() {
        try {
            localStorage.removeItem(this.KEYS.SETTINGS);
            localStorage.removeItem(this.KEYS.STATS);
            localStorage.removeItem(this.KEYS.HISTORY);
            this.init();
            return true;
        } catch (e) {
            console.error('Failed to reset:', e);
            return false;
        }
    }
};

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    StorageManager.init();
});
