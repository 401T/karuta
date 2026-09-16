/**
 * AudioManager - 音声読み上げ・効果音管理
 * スマホ対応版（onEndイベントのフォールバック付き）
 */
const AudioManager = {
    enabled: true,
    rate: 1.0,
    voice: null,
    sounds: {},
    fallbackTimer: null,
    
    init() {
        if ('speechSynthesis' in window) {
            this.loadVoices();
            window.speechSynthesis.onvoiceschanged = () => {
                this.loadVoices();
            };
            console.log('AudioManager initialized');
        } else {
            console.warn('Web Speech API not supported');
            this.enabled = false;
        }
        
        this.initSoundEffects();
    },

    loadVoices() {
        const voices = window.speechSynthesis.getVoices();
        this.voice = voices.find(v => v.lang === 'ja-JP') ||
                     voices.find(v => v.lang.startsWith('ja')) ||
                     voices.find(v => v.lang.includes('ja')) ||
                     null;
        
        if (this.voice) {
            console.log('Japanese voice loaded:', this.voice.name);
        }
    },

    /**
     * テキストを読み上げ
     * @param {string} text - 読み上げるテキスト
     * @param {Object} options - オプション
     */
    speak(text, options = {}) {
        if (!this.enabled) {
            // 音声無効の場合は即座にonEndを呼ぶ
            if (options.onEnd) {
                setTimeout(() => options.onEnd(), 100);
            }
            return;
        }
        
        // 既存の読み上げをキャンセル
        window.speechSynthesis.cancel();
        
        // 既存のフォールバックタイマーをクリア
        if (this.fallbackTimer) {
            clearTimeout(this.fallbackTimer);
            this.fallbackTimer = null;
        }
        
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ja-JP';
        utterance.rate = options.rate || this.rate;
        utterance.pitch = options.pitch || 1.0;
        utterance.volume = options.volume || 1.0;
        
        if (this.voice) {
            utterance.voice = this.voice;
        }
        
        let onEndCalled = false;
        
        // onEndコールバック
        const callOnEnd = () => {
            if (onEndCalled) return;
            onEndCalled = true;
            
            if (this.fallbackTimer) {
                clearTimeout(this.fallbackTimer);
                this.fallbackTimer = null;
            }
            
            if (options.onEnd) {
                options.onEnd();
            }
        };
        
        utterance.onend = callOnEnd;
        utterance.onerror = (e) => {
            console.warn('Speech error:', e);
            callOnEnd();
        };
        
        // フォールバック：テキストの長さに基づいて推定時間を計算
        // 日本語は1秒あたり約3-4文字と仮定
        const estimatedDuration = Math.max(2000, (text.length / 3) * 1000 / this.rate);
        const fallbackTime = estimatedDuration + 1000; // 余裕を持って+1秒
        
        this.fallbackTimer = setTimeout(() => {
            console.log('Speech fallback timer triggered');
            callOnEnd();
        }, fallbackTime);
        
        window.speechSynthesis.speak(utterance);
        
        // iOS Safari対策：100ms後にspeaking状態をチェック
        setTimeout(() => {
            if (!window.speechSynthesis.speaking) {
                console.log('Speech not started, calling onEnd');
                callOnEnd();
            }
        }, 100);
    },

    stop() {
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
        if (this.fallbackTimer) {
            clearTimeout(this.fallbackTimer);
            this.fallbackTimer = null;
        }
    },

    isSpeaking() {
        return window.speechSynthesis.speaking;
    },

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

    initSoundEffects() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('Web Audio API not supported');
        }
    },

    playSound(type) {
        if (!this.audioContext) return;
        
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
        
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

document.addEventListener('DOMContentLoaded', () => {
    AudioManager.init();
});

