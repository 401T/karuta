/**
 * AudioManager - 音声読み上げ・効果音管理
 * 高品質ボイス（Natural/Premium）自動優先対応版
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
            // 音声リストの読み込みは非同期で行われるため、イベントを監視
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

    /**
     * 高品質な日本語音声を優先的に選択する
     */
    loadVoices() {
        const voices = window.speechSynthesis.getVoices();
        
        // 1. 日本語音声だけをフィルタリング
        const japaneseVoices = voices.filter(v => 
            v.lang === 'ja-JP' || v.lang.startsWith('ja')
        );

        // 2. 高品質ボイス（Natural, Premium, Google）を優先するスコアリング
        let bestVoice = null;
        let bestScore = -1;

        japaneseVoices.forEach(voice => {
            let score = 0;
            const name = voice.name.toLowerCase();
            
            // MicrosoftのNaturalボイス（最も自然）
            if (name.includes('natural')) score += 100;
            // MicrosoftのOnline/Premiumボイス
            else if (name.includes('online') || name.includes('premium')) score += 80;
            // Googleの日本語音声
            else if (name.includes('google')) score += 60;
            // その他の日本語音声
            else score += 10;

            if (score > bestScore) {
                bestScore = score;
                bestVoice = voice;
            }
        });

        this.voice = bestVoice;
        
        if (this.voice) {
            console.log('✓ Selected high-quality voice:', this.voice.name);
        } else {
            console.warn('✗ No Japanese voice found');
        }
    },

    /**
     * テキストを読み上げ
     */
    speak(text, options = {}) {
        if (!this.enabled) {
            if (options.onEnd) {
                setTimeout(() => options.onEnd(), 100);
            }
            return;
        }
        
        // 既存の読み上げをキャンセル
        window.speechSynthesis.cancel();
        if (this.fallbackTimer) {
            clearTimeout(this.fallbackTimer);
            this.fallbackTimer = null;
        }
        
        // テキストの前処理（読み上げを自然にする）
        const processedText = this._preprocessText(text);

        const utterance = new SpeechSynthesisUtterance(processedText);
        utterance.lang = 'ja-JP';
        utterance.rate = options.rate || this.rate;
        utterance.pitch = options.pitch || 1.0;
        utterance.volume = options.volume || 1.0;
        
        if (this.voice) {
            utterance.voice = this.voice;
        }
        
        let onEndCalled = false;
        const callOnEnd = () => {
            if (onEndCalled) return;
            onEndCalled = true;
            if (this.fallbackTimer) {
                clearTimeout(this.fallbackTimer);
                this.fallbackTimer = null;
            }
            if (options.onEnd) options.onEnd();
        };
        
        utterance.onend = callOnEnd;
        utterance.onerror = (e) => {
            console.warn('Speech error:', e);
            callOnEnd();
        };
        
        // フォールバックタイマー（テキストの長さに基づく推定時間）
        const estimatedDuration = Math.max(2000, (processedText.length / 3.5) * 1000 / this.rate);
        this.fallbackTimer = setTimeout(() => {
            console.log('Speech fallback timer triggered');
            callOnEnd();
        }, estimatedDuration + 1000);
        
        window.speechSynthesis.speak(utterance);
        
        // iOS Safari対策
        setTimeout(() => {
            if (!window.speechSynthesis.speaking) {
                console.log('Speech not started, calling onEnd');
                callOnEnd();
            }
        }, 100);
    },

    /**
     * 読み上げテキストの前処理（自然さを向上させる）
     */
    _preprocessText(text) {
        if (!text) return '';
        let processed = text;
        
        // 句読点の補完（文末に「。」がない場合は追加）
        if (!processed.endsWith('。') && !processed.endsWith('！') && !processed.endsWith('？')) {
            processed += '。';
        }
        
        // 数字の読み上げ改善（例: "C6H12O6" -> "シーろく えいち じゅうに おーろく" と読まれるのを防ぐための簡易処理）
        // 化学式などはそのままの方が良い場合が多いが、必要に応じて調整
        
        return processed;
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
            if (!this.enabled) this.stop();
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

