// ═══════════════════════════════════════════════════════
//  Portal Game Data Bridge — game side
//
//  Talks to the parent portal frame via Protocol A:
//    Game → Portal: PORTAL_GAME_DATA_LOAD_REQUEST
//                   PORTAL_GAME_DATA_SAVE { payload }
//    Portal → Game: PORTAL_GAME_DATA_LOADED { payload }
//
//  Plus the leaderboard bridge messages defined in GameEmbed.tsx:
//    PORTAL_LEADERBOARD_LOAD_REQUEST  → PORTAL_LEADERBOARD_LOADED
//    PORTAL_LEADERBOARD_SUBMIT_SCORE  → PORTAL_LEADERBOARD_SUBMIT_RESULT
//
//  When running standalone (window.parent === window), all calls become
//  no-ops with a sensible fallback so dev/local play still works.
// ═══════════════════════════════════════════════════════

function inPortal() {
    try { return window.parent !== window; }
    catch { return false; }
}

let _gameDataReady = null;
let _cachedGameData = null;

const _loadListeners = new Set();
const _lbListeners = new Set();
const _submitListeners = new Set();

window.addEventListener("message", (event) => {
    const d = event.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "PORTAL_GAME_DATA_LOADED") {
        _cachedGameData = d.payload && typeof d.payload === "object" ? d.payload : {};
        for (const fn of _loadListeners) fn(_cachedGameData);
        _loadListeners.clear();
    }
    if (d.type === "PORTAL_LEADERBOARD_LOADED") {
        for (const fn of _lbListeners) fn(d.payload || {});
    }
    if (d.type === "PORTAL_LEADERBOARD_SUBMIT_RESULT") {
        for (const fn of _submitListeners) fn(d.payload || {});
    }
});

// ─── Per-user game_data ──────────────────────────────────
// Lazy: first call triggers a single load and caches the result. Resolves
// instantly on subsequent calls. In standalone mode resolves to {} so
// callers can fall back to localStorage or defaults.
export function loadPortalGameData(timeoutMs = 4000) {
    if (_cachedGameData) return Promise.resolve(_cachedGameData);
    if (_gameDataReady) return _gameDataReady;
    if (!inPortal()) {
        _cachedGameData = {};
        return Promise.resolve(_cachedGameData);
    }
    _gameDataReady = new Promise((resolve) => {
        const onLoaded = (payload) => resolve(payload);
        _loadListeners.add(onLoaded);
        try {
            window.parent.postMessage({ type: "PORTAL_GAME_DATA_LOAD_REQUEST" }, "*");
        } catch {
            _loadListeners.delete(onLoaded);
            resolve({});
            return;
        }
        // Timeout fallback so progression doesn't block forever
        setTimeout(() => {
            if (_loadListeners.has(onLoaded)) {
                _loadListeners.delete(onLoaded);
                resolve(_cachedGameData || {});
            }
        }, timeoutMs);
    });
    return _gameDataReady;
}

// Persist the entire game_data blob. Fire-and-forget — the portal save is
// idempotent so partial writes are fine. Local cache also updated.
export function savePortalGameData(data) {
    _cachedGameData = data;
    if (!inPortal()) return;
    try {
        window.parent.postMessage(
            { type: "PORTAL_GAME_DATA_SAVE", payload: data },
            "*"
        );
    } catch { /* swallow */ }
}

// ─── Cross-user leaderboard ──────────────────────────────
let _nextRequestId = 1;

export function fetchPortalLeaderboard(levelId, { limit = 10, timeoutMs = 5000 } = {}) {
    if (!inPortal()) return Promise.resolve({ ok: false, fallback: true });
    return new Promise((resolve) => {
        const requestId = _nextRequestId++;
        const onLoaded = (payload) => {
            if (payload.requestId !== requestId) return;
            _lbListeners.delete(onLoaded);
            resolve(payload);
        };
        _lbListeners.add(onLoaded);
        try {
            window.parent.postMessage(
                {
                    type: "PORTAL_LEADERBOARD_LOAD_REQUEST",
                    payload: { levelId, limit, requestId },
                },
                "*"
            );
        } catch {
            _lbListeners.delete(onLoaded);
            resolve({ ok: false, error: "postMessage failed" });
            return;
        }
        setTimeout(() => {
            if (_lbListeners.has(onLoaded)) {
                _lbListeners.delete(onLoaded);
                resolve({ ok: false, error: "timeout" });
            }
        }, timeoutMs);
    });
}

export function submitPortalScore(levelId, budgetUsed, grade, { timeoutMs = 5000 } = {}) {
    if (!inPortal()) return Promise.resolve({ ok: false, fallback: true });
    return new Promise((resolve) => {
        const requestId = _nextRequestId++;
        const onResult = (payload) => {
            if (payload.requestId !== requestId) return;
            _submitListeners.delete(onResult);
            resolve(payload);
        };
        _submitListeners.add(onResult);
        try {
            window.parent.postMessage(
                {
                    type: "PORTAL_LEADERBOARD_SUBMIT_SCORE",
                    payload: { levelId, budgetUsed, grade, requestId },
                },
                "*"
            );
        } catch {
            _submitListeners.delete(onResult);
            resolve({ ok: false, error: "postMessage failed" });
            return;
        }
        setTimeout(() => {
            if (_submitListeners.has(onResult)) {
                _submitListeners.delete(onResult);
                resolve({ ok: false, error: "timeout" });
            }
        }, timeoutMs);
    });
}

export function isInPortal() {
    return inPortal();
}
