const A = window.A || {};

A.loader = {
    _loaded: {},
    _definitions: {},
    _errors: new Map(),

    // Enhanced init function with better debugging
    async init() {
        try {
            console.log('[Loader] Starting initialization...');
            
            // Make system config available globally
            A.config = {}; // Initialize A.config as an empty object
            console.log('[Loader] System config loaded');

            if (A.events && typeof A.events.emit === 'function') {
                A.events.emit('system:ready');
            }
            
            return true;
        } catch (error) {
            this.handleError('init', error);
            return false;
        }
    },

    async initializeFromConfig() {
        try {
            A.config = {}; // Initialize A.config as an empty object
            return {};
        } catch (error) {
            this.handleError('config', error);
            throw error;
        }
    },

    loadModule(path) {
        console.log('[DEBUG] Attempting to load module:', path);
        return new Promise((resolve, reject) => {
            // Check file existence with a HEAD request first
            fetch(path + '.js', { method: 'HEAD' })
                .then(response => {
                    if (response.ok) {
                        console.log('[DEBUG] File exists:', path + '.js');
                    } else {
                        console.error('[DEBUG] File does not exist:', path + '.js');
                    }
                    
                    // Continue loading the script
                    const script = document.createElement('script');
                    script.src = path + '.js';
                    console.log('[DEBUG] Loading script from:', script.src);
                    
                    script.onload = () => {
                        console.log('[DEBUG] Successfully loaded:', path);
                        resolve();
                    };
                    script.onerror = (e) => {
                        console.error('[DEBUG] Failed to load module:', path, e);
                        reject(new Error(`Failed to load ${path}`));
                    };
                    document.head.appendChild(script);
                })
                .catch(error => {
                    console.error('[DEBUG] Error checking file:', path, error);
                    reject(error);
                });
        });
    },

    handleError(type, error) {
        console.error(`[Loader] Error in ${type}:`, error);
        this._errors.set(type, error);
        
        // Emit error event if events system is available
        if (A.events && typeof A.events.emit === 'function') {
            A.events.emit('system:error', { type, error });
        }
        
        // Log helpful diagnostic information
        console.error('[Loader] Diagnostic information:');
        console.error('- A.events exists:', !!A.events);
        if (A.events) {
            console.error('- A.events.register exists:', typeof A.events.register === 'function');
            console.error('- Registered events:', A.events.getRegisteredEvents ? A.events.getRegisteredEvents() : 'N/A');
        }
        
        return false;
    },

    define(id, dependencies, factory) {
        A.log(`Defining module: ${id}`);
        this._definitions[id] = { dependencies, factory };
        
        // Auto-initialize module after definition
        this.initializeModule(id).catch(error => {
            this.handleError('define', error, { id });
        });
    },

    async initializeModule(id) {
        const def = this._definitions[id];
        if (!def) {
            throw new Error(`Module ${id} not defined`);
        }

        try {
            // Create module instance
            const module = def.factory(A.events);
            
            // Initialize if has init method
            if (module && typeof module.init === 'function') {
                await module.init();
            }

            // Register with registry
            A.registry.registerModule(id, module);
            
            this._loaded[id] = true;
            A.log(`Module initialized: ${id}`);

        } catch (error) {
            this.handleError('init', error, { id });
            throw error;
        }
    }
};
