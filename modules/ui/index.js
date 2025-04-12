A.loader.define('ui', [], function() {
    console.log('[UI] Module is being defined');
    
    let streamingState = {
        isStreaming: false,
        buffer: '',
        displayedText: '',
        currentPosition: 0,
        timer: null,
        element: null,
        charSpeed: 1,
        frameDelay: 25,     // Original value of 25ms
        typewriterMode: true,
        waitingForTTS: false
    };

    // Safe event registration helper
    function safeRegisterEvent(eventName) {
        if (A.events && typeof A.events.register === 'function') {
            A.events.register(eventName);
        }
    }
    
    // Safe event listener helper
    function safeAddListener(eventName, callback) {
        if (A.events && typeof A.events.on === 'function') {
            A.events.on(eventName, callback);
        }
    }
    
    // Safe event listener removal helper
    function safeRemoveListener(eventName) {
        if (A.events && typeof A.events.off === 'function') {
            A.events.off(eventName);
        }
    }
    
    // Clear duplicate handlers and set up proper event listening
    function clearExcessButtons() {
        // Remove any existing listeners
        safeRemoveListener('ai:query:complete');
        safeRemoveListener('ai:response');
        
        // Add one clean handler for COMPLETE responses
        safeAddListener('ai:query:complete', function(data) {
            console.log('[UI] Query complete, response length:', data.response?.length);
            
            // CRITICAL FIX: Always use the FULL response text
            if (data.response) {
                console.log('[UI] Setting complete response text');
                
                // Store the full response in the buffer
                streamingState.buffer = data.response;
                
                // Get the content element
                const contentElement = document.querySelector('.truth-content');
                if (contentElement) {
                    // Apply the full response text with proper formatting
                    contentElement.innerHTML = formatMarkdown(data.response);
                    
                    // Remove any cursor elements
                    const cursor = contentElement.querySelector('.cursor');
                    if (cursor) cursor.remove();
                    
                    // IMPORTANT: Always try TTS with the FULL response
                    try {
                        const savedSettings = JSON.parse(localStorage.getItem('voiceSettings') || '{}');
                        if (savedSettings.autoPlayTTS !== false) {
                            console.log('[UI] Auto-playing TTS with full response text');
                            const tts = A.registry.getModule('audio/tts');
                            if (tts?.getInstance) {
                                const instance = tts.getInstance();
                                if (instance) {
                                    instance.speak(data.response);
                                }
                            }
                        }
                    } catch (e) {
                        console.error('[UI] Error auto-playing TTS:', e);
                    }
                }
                
                // Set up buttons
                setupButtons(data.response);
            }
        });
    }
    
    // Proper markdown formatter with support for all formatting
    function formatMarkdown(text) {
        // First, make all text lowercase but preserve formatting symbols
        text = text.toLowerCase();
        
        // Enforce brand spelling
        text = text.replace(/ai[\s-]?nspired/gi, "ai-nspired");
        
        // Now apply all the formatting
        
        // Headers
        text = text.replace(/^# (.*?)$/gm, '<h1>$1</h1>');
        text = text.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
        text = text.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
        text = text.replace(/^#### (.*?)$/gm, '<h4>$1</h4>');
        
        // Code blocks (must come before inline code)
        text = text.replace(/```([^`]+)```/gs, '<pre><code>$1</code></pre>');
        
        // Blockquotes
        text = text.replace(/^> (.*?)$/gm, '<blockquote>$1</blockquote>');
        
        // Bold
        text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        
        // Italics
        text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
        
        // Inline code
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
        
        // Links
        text = text.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>');
        
        // Unordered list items
        text = text.replace(/^\s*-\s+(.*)$/gm, '<li>$1</li>');
        
        // Ordered list items
        text = text.replace(/^\s*(\d+)\.\s+(.*?)$/gm, '<li>$2</li>');
        
        // Wrap consecutive list items in <ul> or <ol>
        text = text.replace(/(<li>.*?<\/li>)\s*(?=<li>)/gs, '$1');
        text = text.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
        
        // Convert double newlines to paragraph breaks
        text = text.replace(/\n{2,}/g, '</p><p>');
        
        // Wrap the whole output in paragraphs
        if (!text.startsWith('<')) {
            text = '<p>' + text + '</p>';
        }
        
        return text;
    }

    function partialFormatMarkdown(text) {
        // First, force our brand spelling
        text = text.replace(/ai[\s-]?nspired/gi, "ai-nspired");
        // Then force any standalone "AI" (in any case) to lowercase:
        text = text.replace(/\bAI\b/gi, "ai");
        
        return text
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>');
    }

    // Check for speech recognition support
    function checkSpeechSupport() {
        const hasSpeechRecognition = 
            window.SpeechRecognition || 
            window.webkitSpeechRecognition ||
            window.mozSpeechRecognition ||
            window.msSpeechRecognition;
        
        if (!hasSpeechRecognition) {
            console.warn('[UI] Speech recognition not supported in this browser');
            
            // Hide or disable the voice button
            const voiceButton = document.getElementById('voice-button');
            if (voiceButton) {
                voiceButton.style.display = 'none';
            }
            
            return false;
        }
        
        return true;
    }
    
    // Initialize UI components
    function init() {
        console.log('[UI] Initializing UI components');
        
        try {
            clearExcessButtons(); // Call ONCE only
            checkSpeechSupport();
            setupStreaming();
            initializeSettingsModal();
            initializeVoiceButton();
            initializeSearchForm();
            
        } catch (error) {
            console.error('[UI] Initialization error:', error);
        }
        
        return true;
    }
    
    // Set up the settings modal
    function initializeSettingsModal() {
        console.log('[UI] Setting up modal');
        const settingsButton = document.getElementById('settings-button');
        const modal = document.getElementById('voice-settings-modal');
        const closeModalBtn = modal?.querySelector('.modal-close');
        const saveSettingsBtn = document.getElementById('save-settings');
        
        if (!settingsButton || !modal) {
            console.error('[UI] Settings button or modal not found!');
            return;
        }
        
        // Force close the modal on page load
        modal.style.display = 'none';
        
        // Direct DOM manipulation for simplicity
        settingsButton.addEventListener('click', function() {
            console.log('[UI] Settings button clicked');
            modal.style.display = 'block';
        });
        
        closeModalBtn?.addEventListener('click', function() {
            console.log('[UI] Close button clicked');
            modal.style.display = 'none';
        });
        
        // Close when clicking outside the modal
        window.addEventListener('click', function(event) {
            if (event.target === modal) {
                modal.style.display = 'none';
            }
        });
        
        // ADD THE CHECKBOX - simplified approach
        setTimeout(() => {
            // Find the settings content area - try different approaches
            const settingsContent = modal.querySelector('.modal-content') || 
                                  modal.querySelector('.settings-form') || 
                                  modal;
            
            // Only add if it doesn't exist
            if (!document.getElementById('auto-play-tts-container')) {
                console.log('[UI] Adding auto-play TTS checkbox');
                
                // Create container with clear styling
                const container = document.createElement('div');
                container.id = 'auto-play-tts-container';
                container.style.margin = '20px 0';
                container.style.display = 'flex';
                container.style.alignItems = 'center';
                
                // Create checkbox
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = 'auto-play-tts';
                checkbox.style.marginRight = '10px';
                checkbox.checked = true; // DEFAULT TO CHECKED
                
                // Create label
                const label = document.createElement('label');
                label.htmlFor = 'auto-play-tts';
                label.textContent = 'auto-play text to speech for responses';
                
                // Assemble
                container.appendChild(checkbox);
                container.appendChild(label);
                
                // Just append to the settings content
                settingsContent.appendChild(container);
                
                // Set initial state from saved settings
                try {
                    const savedSettings = JSON.parse(localStorage.getItem('voiceSettings') || '{}');
                    if (savedSettings.autoPlayTTS === undefined) {
                        savedSettings.autoPlayTTS = true;
                        localStorage.setItem('voiceSettings', JSON.stringify(savedSettings));
                    }
                    checkbox.checked = savedSettings.autoPlayTTS !== false;
                } catch (e) {
                    console.error('[UI] Error loading settings:', e);
                    checkbox.checked = true; // Still default to true on error
                }
            }
        }, 100);
        
        // Save settings button
        saveSettingsBtn?.addEventListener('click', function() {
            console.log('[UI] Save settings button clicked');
            
            // Get settings values
            const autoStop = document.getElementById('auto-stop-recognition')?.checked;
            const ttsVoice = document.getElementById('tts-voice')?.value;
            const autoPlayTTS = document.getElementById('auto-play-tts')?.checked;
            const modelSelection = document.querySelector('input[name="model-selection"]:checked')?.value || 'Wildcard'; // Get selected model

            // Save to localStorage
            const settings = { autoStop, ttsVoice, autoPlayTTS, modelSelection };
            localStorage.setItem('voiceSettings', JSON.stringify(settings));
            
            // Apply settings
            applySettings(settings);
            
            // Close modal
            modal.style.display = 'none';
        });

        // Add this to your existing save-settings button click handler
        document.getElementById('save-settings').addEventListener('click', function() {
            // Get existing settings
            const settings = JSON.parse(localStorage.getItem('voiceSettings') || '{}');
            
            // Add the new typewriter settings
            settings.typewriterEnabled = document.getElementById('typewriter-toggle').checked;
            settings.typingSpeed = document.getElementById('typing-speed').value;
            
            // Save all settings
            localStorage.setItem('voiceSettings', JSON.stringify(settings));
            
            // Apply the settings
            if (typeof streamingState !== 'undefined') {
              streamingState.typewriterMode = settings.typewriterEnabled;
              
              // Set speed based on selection
              switch(settings.typingSpeed) {
                case 'slow':
                  streamingState.frameDelay = 40; // Slower
                  break;
                case 'medium':
                  streamingState.frameDelay = 25; // Default
                  break;
                case 'fast':
                  streamingState.frameDelay = 10; // Faster
                  break;
              }
            }
            
            // Close the modal
            document.getElementById('voice-settings-modal').style.display = 'none';
        });
    }
    
    // Apply settings to the respective modules
    function applySettings(settings) {
        // Apply STT settings
        if (settings.autoStop !== undefined) {
            const stt = A.registry.getModule('audio/speech-to-text');
            if (stt && stt.getInstance) {
                const instance = stt.getInstance();
                if (instance) {
                    instance.autoStop = settings.autoStop;
                    console.log('[UI] Applied autoStop setting:', settings.autoStop);
                }
            }
        }
        
        // Apply TTS settings
        if (settings.ttsVoice) {
            const tts = A.registry.getModule('audio/tts');
            if (tts && tts.getInstance) {
                const instance = tts.getInstance();
                if (instance) {
                    instance.voice = settings.ttsVoice;
                    console.log('[UI] Applied TTS voice setting:', settings.ttsVoice);
                }
            }
        }

        // Apply Model Selection setting
        if (settings.modelSelection) {
            console.log('[UI] Applied Model Selection setting:', settings.modelSelection);
            // No direct module update needed, just store for fetchSearchResults
        }
    }
    
    // Set up voice button
    function initializeVoiceButton() {
        console.log('[UI] Setting up speech button');
        const voiceButton = document.getElementById('voice-button');
        if (!voiceButton) return;
        
        voiceButton.addEventListener('click', function() {
            console.log('[UI] Voice button clicked');
            
            // Get the speech-to-text module
            const speech = A.registry.getModule('audio/speech-to-text');
            
            if (!speech) {
                console.error('[UI] Speech module not found');
                return;
            }
            
            console.log('[UI] Found speech module, toggling...');
            
            // Check if currently listening
            const isListening = typeof speech.isListening === 'function' && speech.isListening();
            
            if (isListening) {
                // Stop listening
                speech.stop();
                voiceButton.classList.remove('active');
                // Remove the word "speak" by setting status to empty
                voiceButton.querySelector('.voice-status').textContent = '';
            } else {
                // Start listening
                speech.start({
                    onStart: function() {
                        console.log('[UI] Speech started');
                        voiceButton.classList.add('active');
                        voiceButton.querySelector('.voice-status').textContent = 'listening...';
                    },
                    onEnd: function() {
                        console.log('[UI] Speech ended');
                        voiceButton.classList.remove('active');
                        // Remove the word "speak" from onEnd as well
                        voiceButton.querySelector('.voice-status').textContent = '';
                    },
                    onText: function(text) {
                        console.log('[UI] Speech text received:', text);
                        
                        // Set the text in the search input
                        const searchInput = document.getElementById('search-input');
                        if (searchInput) {
                            searchInput.value = text;
                            
                            // Trigger search
                            const searchForm = document.getElementById('search-form');
                            if (searchForm) {
                                searchForm.dispatchEvent(new Event('submit'));
                            }
                        }
                    }
                });
            }
        });
        
        // Register speech events
        safeRegisterEvent('speech:start');
        safeRegisterEvent('speech:end');
        safeRegisterEvent('speech:text');
    }
    
    // Set up search form
    function initializeSearchForm() {
        console.log('[UI] Setting up search form');
        const searchForm = document.getElementById('search-form');
        const searchInput = document.getElementById('search-input');
        const resultsContainer = document.getElementById('results-container');
        const searchButton = document.querySelector('.search-controls button'); // ADD THIS LINE

        if (!searchForm || !searchInput || !resultsContainer) {
            console.error('[UI] Search form elements not found!');
            return;
        }
    
        searchForm.addEventListener('submit', async function (e) {
            e.preventDefault();
    
            const query = searchInput.value.trim();
            if (!query) return;
    
            // Add has-results class to container
            document.querySelector('.search-container').classList.add('has-results');
    
            // Show loading
            resultsContainer.innerHTML = `
                <div class="search-loading">
                    <div class="loading-spinner"></div>
                    <p>searching for truth...</p>
                </div>
            `;
    
            try {
                // Get the selected model from localStorage
                const savedSettings = JSON.parse(localStorage.getItem('voiceSettings') || '{}');
                const selectedModel = savedSettings.modelSelection || 'Wildcard';

                // We only need to send the initial query - don't modify the HTML here
                await fetchSearchResults(query, selectedModel); // Pass selectedModel to fetchSearchResults
                
                // The streaming handler takes care of updating the UI
                
                // Just set up buttons after streaming is complete
                const playbackControls = document.getElementById('playback-controls');
                if (playbackControls) {
                    playbackControls.style.display = 'flex';
                }
            } catch (error) {
                resultsContainer.innerHTML = `
                    <div class="search-error">
                        <p>Error: ${error.message}</p>
                    </div>
                `;
            }
        });

        // Example: When the search button is clicked
        searchButton.addEventListener('click', function() {
            const ai = A.registry.getModule('ai/inference');
            if (ai) {
                const selectedModel = localStorage.getItem('selectedModel') || 'Wildcard'; // Get from local storage
                ai.query(searchInput.value, selectedModel); // Pass the selectedModel
            }
        });
    }
    
    // Function to fetch search results
    async function fetchSearchResults(query, selectedModel) { // ADD selectedModel PARAMETER
        console.log('[UI] Fetching search results for:', query, 'with model:', selectedModel);
        
        try {
            const ai = A.registry.getModule('ai/inference');
            if (!ai) {
                throw new Error('AI inference module not found');
            }

            // The response will be streamed via ai:query:chunk events
            const response = await ai.query(query, selectedModel);
            
            return response;
        } catch (error) {
            console.error('[UI] Error fetching search results:', error);
            throw error;
        }
    }

    // Initialize streaming
    function setupStreaming() {
        // Register for AI chunk events
        safeRegisterEvent('ai:query:chunk');
        
        // Listen for chunks from AI
        safeAddListener('ai:query:chunk', handleStreamingChunk);
    }

    // Handle streaming chunks - CLEAN VERSION
    function handleStreamingChunk(data) {
        if (!streamingState.isStreaming) {
            // Start new streaming session
            streamingState.isStreaming = true;
            streamingState.buffer = '';
            streamingState.displayedText = '';
            streamingState.currentPosition = 0;
            
            // Setup container with cursor
            streamingState.element = document.getElementById('results-container');
            streamingState.element.innerHTML = `
                <div class="search-result">
                    <div class="truth-content"><div class="cursor"></div></div>
                </div>
            `;
            streamingState.element = streamingState.element.querySelector('.truth-content');
        }
        
        // Add new content to buffer
        streamingState.buffer += data.text || '';
        
        // Start typewriter effect if not already running
        if (!streamingState.timer) {
            startStreamingDisplay();
        }
    }

    // Start streaming display
    function startStreamingDisplay() {
        // Prevent multiple timers
        if (streamingState.timer) return;
        
        streamingState.timer = setInterval(() => {
            // True typewriter effect - exactly ONE character at a time
            if (streamingState.typewriterMode) {
                if (streamingState.currentPosition < streamingState.buffer.length) {
                    // Process one character
                    const completeText = streamingState.buffer.substring(0, streamingState.currentPosition + 1);
                    const fullyFormattedText = formatMarkdown(completeText);
                    
                    // Remove existing cursor
                    const existingCursor = streamingState.element.querySelector('.cursor');
                    if (existingCursor) existingCursor.remove();
                    
                    // Set the formatted content
                    streamingState.element.innerHTML = fullyFormattedText;
                    
                    // Add the cursor back
                    streamingState.element.insertAdjacentHTML('beforeend', '<span class="cursor"></span>');
                    
                    // Move to next character
                    streamingState.currentPosition++;
                    
                    // Auto-scroll
                    const resultContainer = document.querySelector('.search-container');
                    if (resultContainer) {
                        resultContainer.scrollTop = resultContainer.scrollHeight;
                    }
                } else {
                    // When we reach the end, remove the cursor
                    const cursor = document.querySelector('.cursor');
                    if (cursor) cursor.remove();
                }
            } else {
                // Original code for batched characters
                // (Keep this for compatibility but not used with typewriterMode=true)
                const newText = streamingState.buffer.substring(streamingState.displayedText.length);
                if (newText) {
                    streamingState.displayedText += newText;
                    streamingState.element.innerHTML += partialFormatMarkdown(newText);
                    
                    // Auto-scroll as content is added
                    const resultContainer = document.querySelector('.search-container');
                    if (resultContainer) {
                        resultContainer.scrollTop = resultContainer.scrollHeight;
                    }
                }
            }
        }, streamingState.frameDelay);
    }

    // Helper function to strip HTML tags
    function stripHTML(html) {
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = html;
        return tempDiv.textContent || tempDiv.innerText || "";
    }
    
    // Show toast message
    function showToast(message) {
        // Check if toast container exists
        let toastContainer = document.querySelector('.toast-container');
        if (!toastContainer) {
            // Create toast container
            toastContainer = document.createElement('div');
            toastContainer.className = 'toast-container';
            document.body.appendChild(toastContainer);
        }
        
        // Create toast
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        toastContainer.appendChild(toast);
        
        // Fade in
        setTimeout(() => {
            toast.classList.add('show');
        }, 10);
        
        // Remove after delay
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                toastContainer.removeChild(toast);
                if (toastContainer.children.length === 0) {
                    document.body.removeChild(toastContainer);
                }
            }, 300);
        }, 3000);
    }

    // Set up buttons
    function setupButtons(formattedResponse) {
        console.log('[UI] Setting up buttons');
        
        // Clear playback controls first
        const playbackControls = document.getElementById('playback-controls');
        if (!playbackControls) return;
        
        // Clear existing buttons
        playbackControls.innerHTML = '';
        playbackControls.style.display = 'flex';
        
        // Add only the essential buttons
        
        // 1. TTS button
        const ttsButton = document.createElement('button');
        ttsButton.id = 'tts-button';
        ttsButton.className = 'action-button';
        ttsButton.innerHTML = '<span class="icon">🔊</span>';
        ttsButton.title = "Read aloud";
        playbackControls.appendChild(ttsButton);
        
        ttsButton.addEventListener('click', async function() {
            console.log('[UI] TTS button clicked');
            const tts = A.registry.getModule('audio/tts');
            if (!tts) {
                console.error('[UI] TTS module not found');
                return;
            }

            const instance = tts.getInstance();
            if (instance.isPlaying) {
                console.log('[UI] Stopping TTS playback');
                instance.stop();
                ttsButton.innerHTML = '<span class="icon">🔊</span>';
            } else {
                console.log('[UI] Starting TTS playback');
                
                // Get clean text without markdown from the DOM
                const truthContainer = document.querySelector('.truth-content');
                if (!truthContainer) {
                    console.warn('[UI] No truth-content element found');
                    return;
                }
                
                // Create a temporary div to strip formatting
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = truthContainer.innerHTML;
                
                // Remove any cursor elements
                const cursorElements = tempDiv.querySelectorAll('.cursor');
                cursorElements.forEach(el => el.remove());
                
                // Get clean text without markdown symbols
                const cleanText = tempDiv.textContent || tempDiv.innerText;
                
                // Use clean text for TTS
                const success = await instance.speak(cleanText.trim());
                
                if (success) {
                    ttsButton.innerHTML = '<span class="icon">⏹️</span>';
                }
            }
        });
        
        // 2. Copy button
        const copyButton = document.createElement('button');
        copyButton.id = 'copy-button';
        copyButton.className = 'action-button';
        copyButton.innerHTML = '<span class="icon">📋</span>';
        copyButton.title = "Copy to clipboard";
        playbackControls.appendChild(copyButton);
        
        copyButton.addEventListener('click', function() {
            console.log('[UI] Copy button clicked');
            
            // Get the actual text content from the results
            const truthContainer = document.querySelector('.truth-content');
            if (!truthContainer) {
                console.warn('[UI] No truth-content element found');
                return;
            }
            
            // Create a temporary div to strip out any cursor or special elements
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = truthContainer.innerHTML;
            
            // Remove any cursor elements that might be present
            const cursorElements = tempDiv.querySelectorAll('.cursor');
            cursorElements.forEach(el => el.remove());
            
            // Get clean text
            const cleanText = tempDiv.textContent || tempDiv.innerText;
            
            // Copy to clipboard
            if (cleanText && cleanText.trim()) {
                navigator.clipboard.writeText(cleanText.trim())
                    .then(() => {
                        console.log('[UI] Text copied to clipboard');
                        showToast('Copied to clipboard!');
                    })
                    .catch(err => {
                        console.error('[UI] Failed to copy text:', err);
                        
                        // Fallback copy method if the Clipboard API fails
                        try {
                            const textarea = document.createElement('textarea');
                            textarea.value = cleanText.trim();
                            textarea.style.position = 'fixed';
                            document.body.appendChild(textarea);
                            textarea.focus();
                            textarea.select();
                            document.execCommand('copy');
                            document.body.removeChild(textarea);
                            showToast('Copied to clipboard!');
                        } catch (e) {
                            console.error('[UI] Fallback copy failed:', e);
                        }
                    });
            } else {
                console.warn('[UI] No text to copy');
            }
        });
        
        // 3. Download button
        const downloadButton = document.createElement('button');
        downloadButton.id = 'download-button';
        downloadButton.className = 'action-button';
        downloadButton.innerHTML = '<span class="icon">⬇️</span>';
        downloadButton.title = "Download response";
        playbackControls.appendChild(downloadButton);
        
        downloadButton.addEventListener('click', async function() {
            console.log('[UI] Download button clicked');
            const tts = A.registry.getModule('audio/tts');
            
            if (!tts) {
                console.error('[UI] TTS module not found');
                return;
            }
            
            try {
                const instance = tts.getInstance();
                
                // Check if audio element exists and has a source
                if (!instance.audioElement || !instance.audioElement.src) {
                    showToast('Play audio first to enable download');
                    return;
                }
                
                // Download the audio file
                const audioUrl = instance.audioElement.src;
                const response = await fetch(audioUrl);
                const audioBlob = await response.blob();
                const url = URL.createObjectURL(audioBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'ai-response.mp3';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } catch (error) {
                console.error('[UI] Audio download error:', error);
            }
        });

        // 4. Follow-up button 
        const followUpButton = document.createElement('button');
        followUpButton.id = 'follow-up-button';
        followUpButton.className = 'action-button';
        followUpButton.innerHTML = '<span class="icon">↩️</span>';
        followUpButton.title = "Ask a follow-up question";
        playbackControls.appendChild(followUpButton);
        
        followUpButton.addEventListener('click', function() {
            console.log('[UI] Follow-up button clicked');
            
            // Create input container
            const inputContainer = document.createElement('div');
            inputContainer.className = 'follow-up-input-container';
            
            // Create input field
            const followUpInput = document.createElement('input');
            followUpInput.type = 'text';
            followUpInput.className = 'follow-up-input';
            followUpInput.placeholder = 'Ask a follow-up question...';
            
            // Add to page
            inputContainer.appendChild(followUpInput);
            const resultsContainer = document.getElementById('results-container');
            resultsContainer.appendChild(inputContainer);
            followUpInput.focus();
            
            // Handle enter key
            followUpInput.addEventListener('keydown', function(event) {
                if (event.key === 'Enter') {
                    const followUpText = followUpInput.value.trim();
                    if (followUpText) {
                        inputContainer.remove();
                        const ai = A.registry.getModule('ai/inference');
                        if (ai) {
                            ai.query(followUpText, true);
                        }
                    }
                }
            });
        });
    } // Properly close setupButtons function
    
    // Return the public API for this module
    return {
        init: init
    };
}); // Properly close module definition

// Also load these settings on page load
document.addEventListener('DOMContentLoaded', function() {
    try {
      const savedSettings = JSON.parse(localStorage.getItem('voiceSettings') || '{}');
      
      // Set the typewriter toggle
      if (document.getElementById('typewriter-toggle')) {
        document.getElementById('typewriter-toggle').checked = 
          savedSettings.typewriterEnabled !== false; // Default to true
      }
      
      // Set the speed dropdown
      if (document.getElementById('typing-speed')) {
        const speed = savedSettings.typingSpeed || 'medium';
        document.getElementById('typing-speed').value = speed;
      }
      
      // Apply to streaming state if it exists
      if (typeof streamingState !== 'undefined') {
        streamingState.typewriterMode = savedSettings.typewriterEnabled !== false;
        
        // Set speed based on selection
        switch(savedSettings.typingSpeed) {
          case 'slow':
            streamingState.frameDelay = 40; // Slower
            break;
          case 'medium':
            streamingState.frameDelay = 25; // Default
            break;
          case 'fast':
            streamingState.frameDelay = 10; // Faster
            break;
        }
      }
    } catch (e) {
      console.error('[UI] Error loading typewriter settings:', e);
    }

  // Function to populate model selection options
  function populateModelSelectionOptions() {
    const modelSelectionOptions = document.getElementById('model-selection-options');
    if (!modelSelectionOptions) {
      console.error('[UI] Model selection options container not found!');
      return;
    }

    // Get the inference configurations from A.config
    const inferenceConfigs = A.registry.getModule('ai/inference').inferenceConfigs;

    // Loop through the inference configurations and create radio buttons
    modelSelectionOptions.innerHTML = ''; // Clear existing options
    inferenceConfigs.forEach(config => {
      const label = document.createElement('label');
      label.innerHTML = `
        <input type="radio" name="model-selection" value="${config.name}" ${config.name === 'Wildcard' ? 'checked' : ''}>
        ${config.name}
      `;
      modelSelectionOptions.appendChild(label);
    });
  }

  // Call the function to populate the model selection options
  populateModelSelectionOptions();

  // Add event listener to the "Save" button in the settings modal
  const saveSettingsButton = document.getElementById('save-settings');
  saveSettingsButton.addEventListener('click', function() {
    // Get the selected model
    const selectedModel = document.querySelector('input[name="model-selection"]:checked').value;

    // Save the selected model to local storage or a variable
    localStorage.setItem('selectedModel', selectedModel);

    // Close the settings modal
    const settingsModal = document.getElementById('voice-settings-modal');
    settingsModal.style.display = 'none';

    // Log the selected model
    console.log('Selected model:', selectedModel);
  });
});