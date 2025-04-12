const A = window.A || {};

A.loader = {
    _loaded: {},
    _definitions: {},
    _errors: new Map(),

    // Enhanced init function with better debugging
    async init() {
        try {
            console.log('[Loader] Starting initialization...');
            
            // Use the correct relative path to fetch project.ini
            const response = await fetch('./functions/project.ini');
            if (!response.ok) {
                throw new Error(`Failed to fetch project.ini: ${response.status} ${response.statusText}`);
            }
            
            const text = await response.text();
            console.log('[Loader] Loaded project.ini with length:', text.length);
            
            const config = this.parseIni(text);
            
            // Make system config available globally
            A.config = config.system;
            console.log('[Loader] System config loaded');

            // Check for modules array
            if (config.init && Array.isArray(config.init.modules) && config.init.modules.length > 0) {
                console.log('[Loader] Found', config.init.modules.length, 'modules to load');
                
                for (const modulePath of config.init.modules) {
                    console.log(`[Loader] Loading module: ${modulePath}`);
                    
                    try {
                        await this.loadModule(modulePath);
                        console.log(`[Loader] Successfully loaded: ${modulePath}`);
                    } catch (error) {
                        console.error(`[Loader] Failed to load module ${modulePath}:`, error);
                    }
                }
            } else {
                console.error('[Loader] No modules[] array found in project.ini!');
                console.error('[Loader] Check the [init] section in project.ini');
            }

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
            // Use the correct relative path to fetch project.ini
            const response = await fetch('./functions/project.ini');
            if (!response.ok) {
                throw new Error(`Failed to fetch project.ini: ${response.status} ${response.statusText}`);
            }
            const text = await response.text();
            const config = this.parseIni(text);
            A.config = config.system; // Make config available globally
            return config;
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

    parseIni: function(content) {
        const config = {};
        let currentSection = null;
        
        // Split into lines and process each line
        const lines = content.split("\n");
        
        for (let line of lines) {
            line = line.trim();
            
            // Skip empty lines and comments
            if (!line || line.startsWith(';')) continue;
            
            // Section headers
            if (line.startsWith('[') && line.endsWith(']')) {
                currentSection = line.slice(1, -1).trim();
                config[currentSection] = {};
                continue;
            }
            
            // We need a section to store values
            if (!currentSection) continue;
            
            // Handle modules[] array
            if (line.startsWith('modules[')) {
                if (!config[currentSection].modules) {
                    config[currentSection].modules = [];
                }
                
                // Extract the value between quotes
                const matches = line.match(/"([^"]+)"/);
                if (matches && matches[1]) {
                    config[currentSection].modules.push(matches[1]);
                    console.log(`[Loader] Found module in INI: ${matches[1]}`);
                }
                continue;
            }
            
            // Regular key=value pairs
            const equalPos = line.indexOf('=');
            if (equalPos > 0) {
                const key = line.slice(0, equalPos).trim();
                let value = line.slice(equalPos + 1).trim();
                
                // Strip quotes if present
                if (value.startsWith("'") && value.endsWith("'")) {
                    value = value.slice(1, -1);
                }
                
                config[currentSection][key] = value;
            }
        }
        
        console.log('[Loader] Parsed INI file, found sections:', Object.keys(config));
        if (config.init && config.init.modules) {
            console.log('[Loader] Found modules[] array with', config.init.modules.length, 'entries');
        } else {
            console.warn('[Loader] No modules[] array found in the INI file');
        }
        
        return config;
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