window.A = window.A || {};

// Debug log before setting config
console.log('[Config] Starting config load...');

A.config = {
//    openRouterKey: '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',
    debug: true,
    name: 'a-code',
    version: '1.0.0'
};

// Debug log after setting config
console.log('[Config] A.config set:', {
    hasKey: !!A.config?.openRouterKey,
    keyLength: A.config?.openRouterKey?.length,
    allKeys: Object.keys(A.config)
});