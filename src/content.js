(() => {
	'use strict';
	if (window.__pcStarted) return;
	window.__pcStarted = true;

	const ENDPOINT = '/rest/rate-limit/all';
	const POLL_MS = 60 * 1000;
	const STORE_KEY = 'pc:peaks';
	// GUESS: Perplexity does not publish one context limit; it varies by model. Edit to taste.
	const CONTEXT_LIMIT_TOKENS = 128000;
	const TOKEN_RECOUNT_MS = 2500;

	let rateItems = [];
	let rateError = null;
	let tokenCount = null; // null = not on a thread

	/* ---------- rate limits ---------- */

	function collect(obj, path = [], out = []) {
		if (!obj || typeof obj !== 'object') return out;
		for (const [k, v] of Object.entries(obj)) {
			if (typeof v === 'number' && Number.isFinite(v) && /^remaining_/i.test(k)) {
				out.push({ id: [...path, k].join('.'), label: k.replace(/^remaining_/i, '').replace(/_/g, ' '), remaining: v });
			} else if (v && typeof v === 'object') {
				collect(v, [...path, k], out);
			}
		}
		return out;
	}

	function loadPeaks() {
		try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; }
	}
	function savePeaks(p) {
		try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* ignore */ }
	}

	let inFlight = false;
	let loggedRaw = false;
	async function refreshRates() {
		if (inFlight) return;
		inFlight = true;
		try {
			const res = await fetch(ENDPOINT, { credentials: 'include' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			if (!loggedRaw) {
				console.log('[Perplexity Counter] raw rate-limit response:', json);
				loggedRaw = true;
			}
			rateItems = collect(json);
			rateError = null;
		} catch (e) {
			rateError = e.message;
		} finally {
			inFlight = false;
			render();
		}
	}

	/* ---------- tokens ---------- */

	function countTokens(text) {
		const t = globalThis.GPTTokenizer_o200k_base;
		if (!text || !t?.countTokens) return 0;
		try { return t.countTokens(text); } catch { return 0; }
	}

	function isThreadPage() {
		return /^\/search\//.test(location.pathname);
	}

	function recountTokens() {
		if (!isThreadPage()) {
			tokenCount = null;
		} else {
			const main = document.querySelector('main') || document.body;
			tokenCount = countTokens(main.innerText || '');
		}
		render();
	}

	let recountTimer = null;
	function scheduleRecount() {
		if (recountTimer) return;
		recountTimer = setTimeout(() => {
			recountTimer = null;
			recountTokens();
		}, TOKEN_RECOUNT_MS);
	}

	/* ---------- UI ---------- */

	const root = document.createElement('div');
	root.id = 'pc-root';
	document.documentElement.appendChild(root);

	function fmt(n) {
		if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`;
		return String(Math.round(n));
	}

	function makeItem(labelText, usedPct, pctText, warn) {
		const wrap = document.createElement('div');
		wrap.className = 'pc-item';

		const label = document.createElement('span');
		label.className = 'pc-label';
		label.textContent = labelText;

		const track = document.createElement('div');
		track.className = 'pc-track';
		const fill = document.createElement('div');
		fill.className = 'pc-fill' + (warn ? ' pc-warn' : '');
		fill.style.width = `${Math.max(0, Math.min(100, usedPct))}%`;
		track.appendChild(fill);

		const pct = document.createElement('span');
		pct.className = 'pc-label pc-pct';
		pct.textContent = pctText;

		wrap.append(label, track, pct);
		return wrap;
	}

	function render() {
		root.textContent = '';

		// Token item
		if (tokenCount === null) {
			root.appendChild(makeItem('Tokens: open a thread', 0, '', false));
		} else {
			const used = tokenCount;
			const left = Math.max(0, CONTEXT_LIMIT_TOKENS - used);
			const pct = (used / CONTEXT_LIMIT_TOKENS) * 100;
			root.appendChild(
				makeItem(`Tokens: ~${fmt(used)} used · ~${fmt(left)} left`, pct, `${pct.toFixed(1)}%`, pct >= 90)
			);
		}

		// Rate-limit items
		if (rateError) {
			root.appendChild(makeItem(`Usage unavailable (${rateError})`, 0, '', false));
		} else {
			const peaks = loadPeaks();
			for (const it of rateItems) {
				peaks[it.id] = Math.max(peaks[it.id] || 0, it.remaining);
				const cap = peaks[it.id] || 1;
				const usedPct = ((cap - it.remaining) / cap) * 100;
				root.appendChild(makeItem(`${it.label}: ${it.remaining} left`, usedPct, `${Math.round(usedPct)}% used`, usedPct >= 90));
			}
			savePeaks(peaks);
		}
		position();
	}

	// Align the strip with the chat input box when we can find it; otherwise full width.
	function position() {
		const input =
			document.querySelector('#ask-input') ||
			document.querySelector('textarea') ||
			document.querySelector('[contenteditable="true"]');
		const rect = input?.getBoundingClientRect();
		if (rect && rect.width > 300 && rect.bottom > 0 && rect.top < window.innerHeight) {
			const pad = 16;
			const left = Math.max(8, rect.left - pad);
			const width = Math.min(window.innerWidth - left - 8, rect.width + pad * 2);
			root.style.left = `${left}px`;
			root.style.width = `${width}px`;
			root.style.right = 'auto';
		} else {
			root.style.left = '0';
			root.style.right = '0';
			root.style.width = 'auto';
		}
	}

	/* ---------- wiring ---------- */

	window.addEventListener('message', (event) => {
		if (event.source !== window) return;
		const d = event.data;
		if (d && d.pc === 'PerplexityCounter' && d.type === 'done') {
			setTimeout(refreshRates, 1500);
			setTimeout(recountTokens, 800);
		}
	});

	new MutationObserver(scheduleRecount).observe(document.body, { childList: true, subtree: true, characterData: true });
	window.addEventListener('resize', position);

	let lastPath = location.pathname;
	setInterval(() => {
		if (location.pathname !== lastPath) {
			lastPath = location.pathname;
			recountTokens();
		}
		position();
	}, 1000);

	setInterval(() => { if (!document.hidden) refreshRates(); }, POLL_MS);

	render();
	recountTokens();
	refreshRates();
})();
