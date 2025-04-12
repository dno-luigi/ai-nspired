A.loader.define('modules/commands/index', ['core/events'], function(events) {
    events.emit('system:module:loading', {
        type: 'core',
        name: 'commands'
    });

    return {
        initialized: false,
        errors: new Map(),

        init() {
            try {
                if (this.initialized) return;

                // Auto-register with registry
                A.registry.registerModule('commands', this);
                
                // Auto-setup event handlers
                this.setupEventHandlers();

                // Let the loader handle module loading order from project.ini
                A.loader.initializeFromConfig()
                    .then(() => {
                        this.initialized = true;
                        events.emit('system:module:ready', {
                            type: 'core',
                            name: 'commands'
                        });
                    })
                    .catch(error => {
                        this.handleError('init', error);
                    });

                return true;

            } catch (error) {
                this.handleError('init', error);
                return false;
            }
        },

        setupEventHandlers() {
            events.on('command:execute', ({ id, args }) => {
                const command = A.registry.getCommand(id);
                if (command?.execute) {
                    try {
                        command.execute(args);
                    } catch (error) {
                        events.emit('command:error', { id, error });
                    }
                }
            });
        },

        handleError(type, error) {
            console.error(`[A] Commands ${type} error:`, error);
            this.errors.set(Date.now(), { type, error });
            events.emit('system:error', {
                system: 'commands',
                type,
                error: error.message
            });
        },

        logRegisteredCommands() {
            console.log('[Commands] Auditing registered commands...');
            
            // Get all registered commands from the registry
            const registeredCommands = A.registry.getAllCommands?.() || [];
            console.log('[Commands] Currently registered commands:', registeredCommands);

            // Log the locations of command registrations
            // (This requires manual inspection of the codebase)
            console.log('[Commands] Command registration locations need to be reviewed manually.');
        }
    };
});