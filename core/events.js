(function() {
    'use strict';
    
    // ABSOLUTE MINIMUM EVENTS SYSTEM - NO FANCY CODE
    window.A = window.A || {};

    // Create events object directly on window.A
    window.A.events = {
        _events: {},
        _registered: [],
        
        // Simple register function
        register: function(name) {
            console.log('[Events] Registering:', name);
            if (!this._registered.includes(name)) {
                this._registered.push(name);
            }
            if (!this._events[name]) {
                this._events[name] = [];
            }
            return true;
        },
        
        // Add listener
        on: function(name, fn) {
            if (!this._events[name]) {
                this.register(name);
            }
            this._events[name].push(fn);
            return true;
        },
        
        // Remove listener
        off: function(name, fn) {
            if (!this._events[name]) return false;
            if (fn) {
                this._events[name] = this._events[name].filter(f => f !== fn);
            } else {
                this._events[name] = [];
            }
            return true;
        },
        
        // Emit event
        emit: function(name, data) {
            if (!this._events[name]) {
                this.register(name);
            }
            for (let fn of this._events[name]) {
                try {
                    fn(data);
                } catch(e) {
                    console.error('[Events] Error in handler:', e);
                }
            }
            return true;
        },
        
        // Get registered events
        getRegisteredEvents: function() {
            return this._registered;
        }
    };

    // Register system events
    window.A.events.register('system:ready');
    window.A.events.register('system:error');

    console.log('[Events] System initialized');
    console.log('[Events] Register function exists:', typeof window.A.events.register === 'function');
})();