A.loader.define('audio/tts', [], function() {
    console.log('[DEBUG] TTS module is being defined');
    
    // Track global playback state
    let isCurrentlyPlaying = false;
    let activeAudioElement = null;
    
    class TextToSpeech {
        constructor(options = {}) {
            this.baseEndpoint = 'https://tts.ai-n.workers.dev/v1/audio/';
            this.endpointType = 'speech';
            this.ttsEndpoint = this.baseEndpoint + this.endpointType;
            
            this.audioElement = new Audio();
            this.isPlaying = false;
            this.voice = options.voice || 'alloy';
            this.speed = options.speed || 1.0;
            this.pitch = options.pitch || 1.0;
        }
        
        // Helper for logging
        log(...args) {
            console.log('[TTS]', ...args);
        }
        
        // Main speak method
        async speak(text, options = {}) {
            this.log(`Speaking text using endpoint: ${this.ttsEndpoint}`);
            this.log(`Using voice: ${options.voice || this.voice}`);
            
            // Stop any active playback
            if (isCurrentlyPlaying) {
                this.log('Stopping current playback');
                this.globalStop();
            }
            
            // Get audio data
            this.log('Fetching audio from API...');
            const audioData = await this.getAudio(text, options);
            
            if (!audioData) {
                this.log('Failed to get audio from API');
                return false;
            }
            
            // Play the audio
            this.audioElement.src = audioData.url;
            this.audioElement.play();
            this.isPlaying = true;
            isCurrentlyPlaying = true;
            activeAudioElement = this.audioElement;
            
            // Handle playback end
            this.audioElement.onended = () => {
                this.log('Audio playback ended');
                this.isPlaying = false;
                isCurrentlyPlaying = false;
                activeAudioElement = null;
                if (A.events && typeof A.events.emit === 'function') {
                    A.events.emit('tts:end');
                }
            };
            
            return true;
        }
        
        // Get audio from API
        async getAudio(text, options = {}) {
            try {
                this.log(`Making request to ${this.ttsEndpoint}`);
                
                const cleanedText = text.replace(/[^\w\s]/g, '').trim();
                const requestPayload = {
                    input: cleanedText,
                    voice: options.voice || this.voice,
                    speed: options.speed || this.speed,
                    pitch: options.pitch || this.pitch,
                    style: "general"
                };
                
                const response = await fetch(this.ttsEndpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestPayload)
                });
                
                if (!response.ok) {
                    throw new Error(`TTS API error: ${response.status}`);
                }
                
                const audioBlob = await response.blob();
                const audioUrl = URL.createObjectURL(audioBlob);
                return { url: audioUrl, blob: audioBlob };
            } catch (error) {
                console.error('[TTS] API request error:', error);
                return null;
            }
        }
        
        // Stop all TTS playback globally
        globalStop() {
            this.log('Stopping TTS playback globally');
            
            if (activeAudioElement) {
                activeAudioElement.pause();
                activeAudioElement.currentTime = 0;
            }
            
            isCurrentlyPlaying = false;
            activeAudioElement = null;
        }

        stop() {
            if (this.isPlaying) {
                console.log('[TTS] Stopping playback for this instance');
                this.audioElement.pause();
                this.audioElement.currentTime = 0;
                this.isPlaying = false;

                if (activeAudioElement === this.audioElement) {
                    isCurrentlyPlaying = false;
                    activeAudioElement = null;
                }
            }
        }
    }
    
    let instance = null;
    
    return {
        init() {
            console.log('[DEBUG] TTS module initializing...');
            return true;
        },
        
        speak(text, options = {}) {
            if (!instance) {
                instance = new TextToSpeech();
            }
            return instance.speak(text, options);
        },
        
        stop() {
            if (instance) {
                instance.globalStop();
            }
        },
        
        getInstance() {
            if (!instance) {
                instance = new TextToSpeech({});
            }
            return instance;
        }
    };
});

document.addEventListener('DOMContentLoaded', () => {
    const ttsModule = A.registry.getModule('audio/tts');
    const readAloudButton = document.getElementById('voice-button');
    let isPlaying = false;

    readAloudButton.addEventListener('click', () => {
        if (!ttsModule) {
            console.error('[UI] TTS module not found');
            return;
        }

        if (isPlaying) {
            console.log('[UI] Pausing TTS playback');
            ttsModule.pause();
            isPlaying = false;
        } else {
            const textToRead = document.getElementById('search-input').value || 'No text provided';
            console.log('[UI] Starting TTS playback');
            ttsModule.speak(textToRead);
            isPlaying = true;
        }
    });

    if (A.events && typeof A.events.on === 'function') {
        A.events.on('tts:end', () => {
            console.log('[UI] Playback ended');
            isPlaying = false;
        });
    }
});