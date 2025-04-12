A.loader.define('audio/speech-to-text', [], function() {
    console.log('[Speech] Module is being defined');
    
    // Private variables
    let recognition = null;
    let isRecognizing = false;
    let autoStop = true;
    let callbacks = {};
    
    // Create a new recognition instance
    function initRecognition() {
        try {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SpeechRecognition) {
                console.error('[Speech] Speech recognition not supported in this browser');
                return null;
            }
            return new SpeechRecognition();
        } catch (e) {
            console.error('[Speech] Error initializing speech recognition:', e);
            return null;
        }
    }
    
    // Class to handle speech recognition
    class SpeechToText {
        constructor() {
            this.autoStop = true;
        }
        
        start(options = {}) {
            console.log('[Speech] Starting recognition...');
            
            // Store callbacks
            callbacks = {
                onStart: options.onStart || function() {},
                onEnd: options.onEnd || function() {},
                onText: options.onText || function() {}
            };
            
            // Create recognition instance if needed
            if (!recognition) {
                recognition = initRecognition();
                
                if (!recognition) {
                    console.error('[Speech] Failed to initialize speech recognition');
                    callbacks.onEnd();
                    return false;
                }
                
                // Configure recognition
                recognition.continuous = false;
                recognition.interimResults = true;
                recognition.lang = 'en-US';
                
                // Set up handlers
                recognition.onstart = () => {
                    console.log('[Speech] Recognition started');
                    isRecognizing = true;
                    callbacks.onStart();
                    if (A.events && A.events.emit) {
                        A.events.emit('speech:start');
                    }
                };
                
                recognition.onend = () => {
                    console.log('[Speech] Recognition stopped');
                    isRecognizing = false;
                    callbacks.onEnd();
                    if (A.events && A.events.emit) {
                        A.events.emit('speech:end');
                    }
                };
                
                recognition.onresult = (event) => {
                    const result = event.results[0];
                    const transcript = result[0].transcript;
                    
                    if (result.isFinal) {
                        console.log('[Speech] Final result:', transcript);
                        callbacks.onText(transcript);
                        if (A.events && A.events.emit) {
                            A.events.emit('speech:text', transcript);
                        }
                        
                        // Auto-stop if configured
                        if (autoStop) {
                            this.stop();
                        }
                    }
                };
                
                recognition.onerror = (event) => {
                    console.error('[Speech] Recognition error:', event.error);
                    isRecognizing = false;
                    callbacks.onEnd();
                    if (A.events && A.events.emit) {
                        A.events.emit('speech:error', event.error);
                        A.events.emit('speech:end');
                    }
                };
            }
            
            // Start recognition
            try {
                recognition.start();
                return true;
            } catch (e) {
                console.error('[Speech] Error starting recognition:', e);
                isRecognizing = false;
                callbacks.onEnd();
                return false;
            }
        }
        
        stop() {
            if (recognition && isRecognizing) {
                try {
                    recognition.stop();
                } catch (e) {
                    console.error('[Speech] Error stopping recognition:', e);
                }
            }
        }
        
        isListening() {
            return isRecognizing;
        }
    }
    
    // Single instance
    let instance = null;
    
    // Return public API
    return {
        init() {
            console.log('[Speech] Module initializing');
            
            // Register speech events if possible
            if (A.events && typeof A.events.register === 'function') {
                try {
                    A.events.register('speech:start');
                    A.events.register('speech:end');
                    A.events.register('speech:text');
                    A.events.register('speech:error');
                } catch (e) {
                    console.warn('[Speech] Error registering events:', e);
                }
            }
            
            return true;
        },
        
        start(options) {
            if (!instance) {
                instance = new SpeechToText();
            }
            return instance.start(options);
        },
        
        stop() {
            if (instance) {
                instance.stop();
            }
        },
        
        isListening() {
            return instance ? instance.isListening() : false;
        },
        
        getInstance() {
            if (!instance) {
                instance = new SpeechToText();
            }
            return instance;
        }
    };
});