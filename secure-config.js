(function() {
    console.log('[Security] Loading secure config');
    
    // Obfuscate credentials through encoding
    const _s = {
        '_c1': atob('NzcxZWUyY2MyMGYwOTI0ODEyOTExNGI3NTM1YjJjYzk='), // cloudflare_id encoded
        '_c2': atob('eXFRcy1VV19Eamc1U3luNWxwT0hhZ1dwUXJ3NXZxdnFSajV3RDBwdw=='), // cloudflare_api_key encoded
    };
    
    // Secure getter with validation
    window._getSecureConfig = function(key, token) {
        // Simple validation to prevent casual inspection
        const validToken = ((Date.now() % 86400000) / 1000).toFixed(0);
        if (token !== validToken) {
            console.warn('[Security] Invalid access attempt');
            return null;
        }
        return _s[key] || null;
    };
    
    console.log('[Security] Secure config loaded');
})();