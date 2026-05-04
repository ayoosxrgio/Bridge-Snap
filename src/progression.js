// Progression system — localStorage first (synchronous reads from anywhere
// in the game) with a one-shot portal-side hydrate on boot. When running
// inside the portal iframe, completed levels and grades round-trip through
// `game_data.data_json` so they survive across devices and sign-ins.

import { loadPortalGameData, savePortalGameData, submitPortalScore, isInPortal } from "./portalGameData.js";

const STORAGE_KEY = "bridgesnap_progress";

// In-memory shape (also exactly the shape persisted to both stores):
//   { completed: number[], grades: { [idx: string]: "S"|"A"|"B"|"C" },
//     bestBudget: { [idx: string]: number } }
function loadProgressLocal() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return normalize(JSON.parse(raw));
    } catch {}
    return { completed: [], grades: {}, bestBudget: {} };
}

function normalize(obj) {
    return {
        completed: Array.isArray(obj?.completed) ? obj.completed.slice() : [],
        grades: obj?.grades && typeof obj.grades === "object" ? { ...obj.grades } : {},
        bestBudget: obj?.bestBudget && typeof obj.bestBudget === "object" ? { ...obj.bestBudget } : {},
    };
}

function saveProgressLocal(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
}

// Merge two progress blobs, keeping the better of each. Used so a
// portal-loaded blob can hydrate (and not clobber) local state, and vice
// versa — players who beat levels offline still get their progress saved.
function mergeProgress(a, b) {
    const out = normalize(a);
    const inb = normalize(b);
    // Completed: union
    const set = new Set([...out.completed, ...inb.completed]);
    out.completed = [...set].sort((x, y) => x - y);
    // Grades: keep the better one
    const ranks = { C: 0, B: 1, A: 2, S: 3 };
    for (const k of Object.keys(inb.grades)) {
        const og = out.grades[k];
        const ng = inb.grades[k];
        if (!og || (ranks[ng] ?? -1) > (ranks[og] ?? -1)) out.grades[k] = ng;
    }
    // Best budget: keep the LOWER one (better)
    for (const k of Object.keys(inb.bestBudget)) {
        const ob = out.bestBudget[k];
        const nb = inb.bestBudget[k];
        if (ob == null || nb < ob) out.bestBudget[k] = nb;
    }
    return out;
}

// ─── Boot-time hydration from the portal ──────────────────
// Fire once at module load. localStorage stays the synchronous source of
// truth — if the portal answers, we merge its blob in and write back.
let _hydrated = false;
async function hydrateFromPortal() {
    if (_hydrated) return;
    _hydrated = true;
    if (!isInPortal()) return;
    try {
        const remote = await loadPortalGameData();
        const remoteProgress =
            remote && typeof remote === "object" && remote.progress
                ? remote.progress
                : remote;       // legacy flat shape
        if (!remoteProgress || typeof remoteProgress !== "object") return;
        const local = loadProgressLocal();
        const merged = mergeProgress(local, remoteProgress);
        saveProgressLocal(merged);
        // If the merge added something the remote was missing, push it back.
        savePortalGameData({ ...remote, progress: merged });
    } catch { /* swallow */ }
}
hydrateFromPortal();

function persist(data) {
    saveProgressLocal(data);
    if (isInPortal()) {
        // Don't await — keep the call site synchronous.
        loadPortalGameData().then((remote) => {
            const next = { ...(remote || {}), progress: data };
            savePortalGameData(next);
        });
    }
}

// ─── Public API ───────────────────────────────────────────

export function getCompleted() {
    return loadProgressLocal().completed;
}

export function getGrade(levelIdx) {
    return loadProgressLocal().grades[levelIdx] || null;
}

export function getBestBudget(levelIdx) {
    return loadProgressLocal().bestBudget[levelIdx] ?? null;
}

export function isUnlocked(levelIdx) {
    if (levelIdx === 0) return true;
    return getCompleted().includes(levelIdx - 1);
}

// Mark a level as completed with a grade and (optionally) a budget used.
// Only upgrades the saved grade / lower budget — never downgrades.
export function completeLevel(levelIdx, grade, budgetUsed) {
    const data = loadProgressLocal();
    if (!data.completed.includes(levelIdx)) data.completed.push(levelIdx);

    const ranks = ["C", "B", "A", "S"];
    const oldRank = ranks.indexOf(data.grades[levelIdx] || "");
    const newRank = ranks.indexOf(grade);
    if (newRank > oldRank) data.grades[levelIdx] = grade;

    if (typeof budgetUsed === "number" && budgetUsed >= 0) {
        const cur = data.bestBudget[levelIdx];
        if (cur == null || budgetUsed < cur) data.bestBudget[levelIdx] = budgetUsed;
    }

    persist(data);
}

// Reset everything. Both stores wiped.
export function resetProgress() {
    const empty = { completed: [], grades: {}, bestBudget: {} };
    saveProgressLocal(empty);
    if (isInPortal()) {
        loadPortalGameData().then((remote) => {
            const next = { ...(remote || {}), progress: empty };
            savePortalGameData(next);
        });
    }
}

// Submit a score to the cross-user leaderboard. Fire-and-forget — failures
// just mean the synthetic / cached leaderboard is shown next time.
// `levelId` is the LEVELS[i].id string (e.g. "first"), NOT the index.
export function submitLeaderboardScore(levelId, budgetUsed, grade) {
    if (!isInPortal()) return;
    submitPortalScore(levelId, budgetUsed, grade).catch(() => {});
}
