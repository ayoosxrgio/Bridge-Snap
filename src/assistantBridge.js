// ═══════════════════════════════════════════════════════
//  STEM Assistant Bridge — Portal Integration
//
//  Sends standardized game events to the portal shell via
//  postMessage. The portal's GameIframeBridge listens for
//  { type: "ASSISTANT_GAME_EVENT", payload } messages and
//  forwards them to the AI tutor.
//
//  When running standalone (npm run dev), messages go to
//  window.parent (which is self) and are harmlessly ignored.
// ═══════════════════════════════════════════════════════

const GAME_ID = "bridge-snap";
const DEFAULT_CONCEPT = "structural_engineering";

let currentLevel = null;
let currentConcept = DEFAULT_CONCEPT;
let hintCount = 0;

// ─── Core send ──────────────────────────────────────────
function send(eventType, extra = {}) {
    const payload = {
        gameId: GAME_ID,
        eventType,
        levelId: currentLevel,
        targetConcept: currentConcept,
        hintCount,
        ...extra,
    };
    try {
        window.parent.postMessage({ type: "ASSISTANT_GAME_EVENT", payload }, "*");
    } catch (_) {
        // Silently ignore — not in a browser context (SSR, tests, etc.)
    }
}

// ─── Public API ─────────────────────────────────────────

/** Call once at startup (src/main.js). No-op but keeps the init pattern. */
export function initAssistantBridge() {
    // Bridge is ready as soon as the module loads.
    // If stem-assistant-bridge is ever installed as a package,
    // its initStemAssistantBridge({ gameId }) call goes here.
}

/** Player enters a new level. */
export function onLevelStart(levelId, targetConcept) {
    currentLevel = levelId;
    currentConcept = targetConcept || DEFAULT_CONCEPT;
    hintCount = 0;
    send("level_start");
}

/**
 * Bridge collapsed — vehicle fell or too many members broke.
 * @param {object} details  { summary, reason, cost, memberCount }
 */
export function onBridgeFailed(details = {}) {
    send("incorrect_submission", {
        playerAnswer: details.summary || "Bridge collapsed",
        mistakeCategory: details.reason || "structural_failure",
    });
}

/**
 * Vehicle crossed successfully.
 * @param {object} details  { summary, cost, grade }
 */
export function onBridgeSuccess(details = {}) {
    send("correct_submission", {
        playerAnswer: details.summary || "Bridge held",
    });
}

/** Level fully complete (called right after success). */
export function onLevelComplete(details = {}) {
    send("level_complete", {
        playerAnswer: details.summary || "",
    });
}

/** Player clicked the hint / "?" button. */
export function onHintRequest() {
    hintCount++;
    send("hint_request");
}

/** Player requested an AI recap / explanation. */
export function onRecapRequest() {
    send("recap_request");
}
