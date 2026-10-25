// Runs in the page context. Signals when an answer stream finishes so the bars refresh.
(() => {
	'use strict';
	if (window.__pcHooked) return;
	window.__pcHooked = true;
	const originalFetch = window.fetch;

	window.fetch = async (...args) => {
		const res = await originalFetch.apply(window, args);
		try {
			const req = args[0];
			const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req?.url || '';
			const method = String(args[1]?.method || req?.method || 'GET').toUpperCase();
			if (method === 'POST' && url.includes('/rest/sse/')) {
				const reader = res.clone().body?.getReader?.();
				if (reader) {
					(async () => {
						try {
							while (!(await reader.read()).done) { /* drain */ }
						} catch { /* ignore */ }
						window.postMessage({ pc: 'PerplexityCounter', type: 'done' }, '*');
					})();
				}
			}
		} catch { /* never break the page */ }
		return res;
	};
})();
