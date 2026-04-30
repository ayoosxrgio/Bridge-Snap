// ═══════════════════════════════════════════════════════
//  Leaderboard — placeholder backend
//
//  Async-first API so the swap to Supabase later is just a
//  body change inside submitScore() and getLeaderboard().
//
//  Today (placeholder):
//    • Player's best run per level → localStorage.
//    • Synthetic rivals → deterministic per-level pool seeded
//      by levelId hash, so the "field" stays consistent
//      across sessions but feels realistic.
//
//  Tomorrow (Supabase): drop in calls against a `scores` table
//    keyed by (user_id, level_id) ordered by budget_used asc.
// ═══════════════════════════════════════════════════════

const STORAGE_KEY = "bridgesnap_leaderboard";

// Names sampled into the synthetic field. Mix of engineering /
// builder vibes so the leaderboard reads themed, not random.
const SYNTHETIC_NAMES = [
    "Ironheart", "TrussNinja", "BridgeMaster", "SteelDrifter",
    "BeamDream", "PixelEngineer", "Roadworks", "RopeWalker",
    "Buttress", "Cantilever", "Switchback", "Keystone",
    "Riveter", "ArchAce", "SpanWright", "GirderGhost",
    "TensionPro", "LoadBearer", "DeckHand", "Pylon",
    "Foreman", "Surveyor", "Drafty", "Plumbline",
];

// ─── Deterministic RNG ─────────────────────────────────
// Same levelId always produces the same synthetic field — players
// can compare runs against a stable reference, and dev reloads
// don't shuffle "the competition" each time.
function hashStr(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = (h * 33) ^ str.charCodeAt(i);
    }
    return h >>> 0;
}

function lcg(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xFFFFFFFF;
    };
}

// ─── Synthetic field ───────────────────────────────────
// Distribution: ~10% top-tier (90-97% efficient), ~75% mid
// (55-85%), ~15% low (30-55%). Skews right — most players are
// average, a small elite is very budget-efficient.
function generateSynthetic(levelId, budget, count = 80) {
    const rand = lcg(hashStr(levelId));
    const players = [];
    for (let i = 0; i < count; i++) {
        const r = rand();
        let efficiency;
        if (r < 0.10) {
            efficiency = 0.90 + rand() * 0.07;
        } else if (r < 0.85) {
            efficiency = 0.55 + rand() * 0.30;
        } else {
            efficiency = 0.30 + rand() * 0.25;
        }
        const budgetUsed = Math.max(100, Math.round(budget * (1 - efficiency)));
        const nameIdx = Math.floor(rand() * SYNTHETIC_NAMES.length);
        const tag = Math.floor(rand() * 999).toString().padStart(3, "0");
        players.push({
            playerName: `${SYNTHETIC_NAMES[nameIdx]}_${tag}`,
            budgetUsed,
            isYou: false,
        });
    }
    return players;
}

// ─── localStorage helpers ──────────────────────────────
function readScores() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch { return {}; }
}

function writeScores(s) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
    catch {}
}

// ─── Public API ────────────────────────────────────────

/**
 * Submit a level-completion score. Stores only the player's PERSONAL BEST
 * (lowest budgetUsed) — matches how a real leaderboard would dedupe.
 *
 * Returns { isPB, prevBest } so the UI can flag a new personal record.
 */
export async function submitScore({ levelId, budgetUsed, budget, playerName = "You" }) {
    const scores = readScores();
    const prev = scores[levelId];
    const isPB = !prev || budgetUsed < prev.budgetUsed;
    if (isPB) {
        scores[levelId] = { budgetUsed, budget, playerName, ts: Date.now() };
        writeScores(scores);
    }
    return { isPB, prevBest: prev ? prev.budgetUsed : null };
}

/**
 * Fetch the leaderboard for `levelId`. Returns:
 *   {
 *     top:            [{ playerName, budgetUsed, isYou }],   // top 5 entries
 *     userRank:       number | null,                          // 1-indexed
 *     userPercentile: number | null,                          // 0..100, higher = better
 *     totalPlayers:   number,
 *     userEntry:      { playerName, budgetUsed, isYou } | null,
 *   }
 *
 * `currentRun` is optional — used as a fallback when computing the synthetic
 * field's reference budget (so we can show a leaderboard before the player's
 * own best is even saved).
 */
export async function getLeaderboard(levelId, currentRun = null) {
    const scores = readScores();
    const userBest = scores[levelId];
    const budget = (currentRun && currentRun.budget) || (userBest && userBest.budget) || 10000;

    const all = generateSynthetic(levelId, budget);

    let userEntry = null;
    if (userBest) {
        userEntry = {
            playerName: userBest.playerName || "You",
            budgetUsed: userBest.budgetUsed,
            isYou: true,
        };
        all.push(userEntry);
    }

    all.sort((a, b) => a.budgetUsed - b.budgetUsed);

    let userRank = null;
    if (userEntry) {
        for (let i = 0; i < all.length; i++) {
            if (all[i].isYou) { userRank = i + 1; break; }
        }
    }

    const totalPlayers = all.length;
    const userPercentile = userRank
        ? Math.max(1, Math.round((1 - (userRank - 1) / totalPlayers) * 100))
        : null;

    return {
        top: all.slice(0, 5),
        userRank,
        userPercentile,
        totalPlayers,
        userEntry,
    };
}
