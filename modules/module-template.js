/**
 * Module Template
 * Use this as a starting point for all modules to ensure consistency
 */
(function() {
    // Attach events object to window.A
    window.A = window.A || {};
    window.A.events = {
        register(eventName) {
            if (typeof eventName !== 'string') {
                console.error('[Events] Event name must be a string');
                return false;
            }
            console.log(`[Events] Registered event: ${eventName}`);
            return true;
        },
        emit(eventName, data) {
            if (typeof eventName !== 'string') {
                console.error('[Events] Event name must be a string');
                return false;
            }
            console.log(`[Events] Emitted event: ${eventName}`, data);
            return true;
        }
    };

    // Check that register function exists
    if (typeof window.A.events.register !== 'function') {
        console.error('[Events] Register function is not available!');
    }
})();