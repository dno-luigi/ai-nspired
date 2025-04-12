A.registry = {
    _commands: new Map(),
    _modules: new Map(),
    _errors: new Map(),

    registerCommand(namespace, command) {
        const id = `${namespace}:${command.name}`;
        this._commands.set(id, command);
        A.log(`Command registered: ${id}`);
    },

    registerModule(id, module) {
        // Standardize path - remove 'modules/' prefix and '/index' suffix
        const path = id.replace('modules/', '')
                      .replace('/index', '');
        
        if (this._modules.has(path)) {
            A.log(`Module ${path} already registered, skipping`);
            return;
        }

        this._modules.set(path, module);
        A.log(`Module registered: ${path}`);
        A.events.emit('system:module:registered', { id: path });
    },

    getModule(id) {
        // Match the registration path format
        const path = id.replace('modules/', '')
                      .replace('/index', '');
        const module = this._modules.get(path);
        A.log(`Getting module ${path}: ${module ? 'found' : 'not found'}`);
        return module;
    },

    listModules() {
        A.log('Registered modules:');
        this._modules.forEach((module, id) => {
            A.log(` - ${id}`);
        });
    }
};

// Debug check
A.log('Registry loaded with methods:', Object.keys(A.registry));