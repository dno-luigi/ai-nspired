A.loader.define('modules/ai/inference/index', ['core/events'], function(events) {
    // Direct config setup
    A.config = A.config || {};

    const inferenceConfigs = [
        {
            name: 'Adaptive AI Director',
            model: 'mistralai/mistral-7b-instruct',
            systemPrompt: `You are the first of your kind - an adaptive AI director representing AI-nspired. Our company, AI-nspired, was founded by an attorney with over two decades of experience in the legal field. We built our foundation to equalize access to AI and empower everyone through a pragmatic, personal, and private AI experience. Our roots are in law, but our mission is to inspire and support everyone with AI. Our goal here is to help everyone, regardless of background, harness the power of AI.`,
            description: 'The primary AI director for AI-nspired, providing guidance and support.'
        },
        {
            name: 'Engaging Chat Companion',
            model: 'openai/gpt-4o-mini',
            systemPrompt: `You are a friendly and engaging AI companion from AI-nspired. Your purpose is to provide helpful and informative answers while maintaining a conversational tone. Encourage users to explore AI-nspired's capabilities and ask follow-up questions.`,
            description: 'A friendly and engaging AI companion designed to provide helpful and informative answers.'
        },
        {
            name: 'Role Player',
            model: 'liquid/lfm-7b',
            systemPrompt: `You are a versatile role-playing AI from AI-nspired. If a specific role is defined, embody that role within the context of AI-nspired's mission. Otherwise, function as a helpful listener and supportive AI assistant.`,
            description: 'A versatile AI that can take on different roles or provide general support within the AI-nspired framework.'
        },
        {
            name: 'Wildcard',
            model: 'perplexity/llama-3.1-sonar-small-128k-online',
            systemPrompt: `You are a wildcard AI from AI-nspired, capable of handling a wide range of tasks and questions. Use your knowledge and creativity to provide the best possible response while representing AI-nspired's values.`,
            description: 'A general-purpose AI that can handle a variety of tasks within the AI-nspired ecosystem.'
        },
        {
            name: 'Legal Expert',
            model: 'meta-llama/llama-3.2-1b-instruct',
            systemPrompt: `You are a legal expert from AI-nspired, specializing in strategizing case outcomes. Provide informed and insightful advice based on legal principles and precedents, always within the context of AI-nspired's mission to equalize access to AI.`,
            description: 'An AI specializing in legal strategy and case analysis within the AI-nspired framework.'
        }
    ];

    return {
        initialized: false,
        errors: new Map(), // Ensure this line is present
        apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: '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', // Set your OpenRouter API key here
        availableModels: inferenceConfigs.map(config => ({
            id: config.model,
            name: config.name,
            description: config.description
        })),
        currentModelIndex: 0, // Track the current model
        selectedInferenceConfig: 'Wildcard', // Default inference configuration
        selectedModel: 'perplexity/llama-3.1-sonar-small-128k-online', // Default model for main search
        selectedModelIndex: 0, // Track the selected model index
        model: 'perplexity/llama-3.1-sonar-small-128k-online', // Default model for main search
        conversationHistory: [],
        inferenceConfigs: inferenceConfigs, // Add inferenceConfigs to the public API

        async init() {
            try {
                if (this.initialized) return;
                
                // Debug config state
                console.log('[AI] Config state:', {
                    hasConfig: !!A.config,
                    configKeys: A.config ? Object.keys(A.config) : [],
                    hasKey: !!A.config?.openRouterKey,
                    keyStart: A.config?.openRouterKey?.slice(0,8)
                });

                // Auto-register with registry
                A.registry.registerModule('ai/inference', this);

                this.initialized = true;
                events.emit('ai:ready');
                return true;

            } catch (error) {
                this.handleError('init', error);
                return false;
            }
        },

        async query(input, configName = 'Wildcard', isFollowUp = false) {
            try {
                A.log('Making API request with key:', this.apiKey.slice(0, 12) + '...');

                // Find the selected inference configuration
                const selectedConfig = inferenceConfigs.find(config => config.name === configName);

                if (!selectedConfig) {
                    throw new Error(`Inference configuration not found: ${configName}`);
                }

                // Create messages array with system prompt
                let messages = [
                    {
                        role: 'system',
                        content: selectedConfig.systemPrompt
                    }
                ];

                // If it's a follow-up, use conversation history
                if (isFollowUp && this.conversationHistory.length > 0) {
                    messages = messages.concat(this.conversationHistory);
                }

                // Add the current input
                messages.push({ role: 'user', content: input });

                events.emit('ai:query:start', { input, model: selectedConfig.model });

                const response = await fetch('https://gateway.ai.cloudflare.com/v1/771ee2cc20f09248129114b7535b2cc9/ai-nspired/openrouter', { // Replace with your AI Gateway endpoint
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.apiKey}` // Use your OpenRouter API key
                    },
                    body: JSON.stringify({
                        model: selectedConfig.model,
                        messages: messages,
                        stream: true
                    })
                });

                // Handle streaming chunks
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6);
                            if (data === '[DONE]') continue;
                            
                            try {
                                const parsed = JSON.parse(data);
                                const content = parsed.choices[0]?.delta?.content || '';
                                buffer += content;
                                events.emit('ai:query:chunk', { text: content });
                            } catch (e) {
                                console.error('Parse error:', e);
                            }
                        }
                    }
                }

                // Store in conversation history
                this.conversationHistory.push({ role: 'user', content: input });
                this.conversationHistory.push({ role: 'assistant', content: buffer });

                // Emit the query complete event with the response and flag for follow-up
                events.emit('ai:query:complete', { 
                    response: buffer, 
                    canFollowUp: true 
                });
                
                return buffer;

            } catch (error) {
                this.handleError('query', error);
                throw error;
            }
        },

        handleError(type, error) {
            console.error(`[AI] Error in ${type}:`, error); // Use console.error instead of A.error
            this._errors.set(type, error);
            
            // Emit error event if events system is available
            if (A.events && typeof A.events.emit === 'function') {
                A.events.emit('system:error', { type, error });
            }
            
            return false;
        }
    };
});