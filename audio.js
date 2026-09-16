/**
 * AudioManager - 音声読み上げ・効果音管理
 */
const AudioManager = {
    enabled: true,
    rate: 1.0,
    voice: null,
    sounds: {},
    
    /**
     * 初期化
     */
    init() {
        // Web Speech API の可用性チェック
        if ('speechSynthesis' in window) {
            this.loadVoices();
            
            // 音声リストが非同期で読み込まれる場合がある
            window.speechSynthesis.onvoiceschanged = () => {
                this.loadVoices();
            };
            
            console.log('AudioManager initialized');
        } else {
            console.warn('Web Speech API not supported');
            this.enabled = false;
        }
        
        // 効果音の生成（Web Audio API）
        this.initSoundEffects();
    },

    /**
     * 日本語音声をロード
     */
    loadVoices() {
        const voices = window.speechSynthesis.getVoices();
        
        // 日本語音声を優先的に選択
        this.voice = voices.find(v => v.lang === 'ja-JP') ||
                     voices.find(v => v.lang.startsWith('ja')) ||
                     voices.find(v => v.lang.includes('ja')) ||
                     null;
        
        if (this.voice) {
            console.log('Japanese voice loaded:', this.voice.name);
        } else {
            console.warn('Japanese voice not found, using default');
        }
    },

    /**
     * テキストを読み上げ
     * @param {string} text - 読み上げるテキスト
     * @param {Object} options - オプション
     */
    speak(text, options = {}) {
        if (!this.enabled) return;
        
        // 既存の読み上げをキャンセル
        window.speechSynthesis.cancel();
        
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ja-JP';
        utterance.rate = options.rate || this.rate;
        utterance.pitch = options.pitch || 1.0;
        utterance.volume = options.volume || 1.0;
        
        if (this.voice) {
            utterance.voice = this.voice;
        }
        
        // コールバック
        if (options.onEnd) {
            utterance.onend = options.onEnd;
        }
        
        window.speechSynthesis.speak(utterance);
    },

    /**
     * 読み上げを停止
     */
    stop() {
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
    },

    /**
     * 読み上げ中かどうか
     * @returns {boolean}
     */
    isSpeaking() {
        return window.speechSynthesis.speaking;
    },

    /**
     * 設定を更新
     * @param {Object} settings
     */
    updateSettings(settings) {
        if (settings.enabled !== undefined) {
            this.enabled = settings.enabled;
            if (!this.enabled) {
                this.stop();
            }
        }
        if (settings.rate !== undefined) {
            this.rate = parseFloat(settings.rate);
        }
    },

    /**
     * 効果音の初期化（Web Audio API）
     */
    initSoundEffects() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('Web Audio API not supported');
        }
    },

    /**
     * 効果音を再生
     * @param {string} type - 'correct', 'wrong', 'combo', 'click'
     */
    playSound(type) {
        if (!this.audioContext) return;
        
        // AudioContext が suspended 状態の場合、resume する
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
        
        const now = this.audioContext.currentTime;
        
        switch (type) {
            case 'correct':
                this.playTone([523.25, 659.25, 783.99], [0, 0.1, 0.2], 0.1, 'sine');
                break;
            case 'wrong':
                this.playTone([200, 150], [0, 0.1], 0.15, 'sawtooth');
                break;
            case 'combo':
                this.playTone([783.99, 987.77, 1174.66], [0, 0.05, 0.1], 0.08, 'sine');
                break;
            case 'click':
                this.playTone([800], [0], 0.05, 'sine');
                break;
            case 'stage':
                this.playTone([440, 554.37], [0, 0.1], 0.1, 'triangle');
                break;
        }
    },

    /**
     * 単音を再生
     * @param {Array<number>} frequencies - 周波数の配列
     * @param {Array<number>} startTimes - 開始時間の配列
     * @param {number} duration - 各音の長さ
     * @param {string} type - 波形タイプ
     */
    playTone(frequencies, startTimes, duration, type = 'sine') {
        frequencies.forEach((freq, i) => {
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            oscillator.type = type;
            oscillator.frequency.value = freq;
            
            const startTime = this.audioContext.currentTime + startTimes[i];
            
            gainNode.gain.setValueAtTime(0, startTime);
            gainNode.gain.linearRampToValueAtTime(0.3, startTime + 0.01);
            gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
            
            oscillator.start(startTime);
            oscillator.stop(startTime + duration);
        });
    }
};

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    AudioManager.init();
});
