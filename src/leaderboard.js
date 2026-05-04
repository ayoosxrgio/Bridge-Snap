// ═══════════════════════════════════════════════════════
//  Leaderboard — portal-first with synthetic fallback
//
//  When running inside the portal iframe (auth + Supabase available),
//  getLeaderboard / submitScore round-trip through the postMessage bridge
//  defined in S26-CSE-335-dev/src/components/game-page/player/GameEmbed.tsx.
//  The portal route /api/game-scores/[slug] joins game_scores rows with
//  user_profiles to return real display names.
//
//  Standalone (npm run dev / no parent frame), we fall back to the old
//  synthetic-field generator so dev runs still feel populated.
// ═══════════════════════════════════════════════════════

import { fetchPortalLeaderboard, submitPortalScore, isInPortal } from "./portalGameData.js";

const STORAGE_KEY = "bridgesnap_leaderboard";

// ─── Synthetic field (standalone fallback only) ─────────
const SYNTHETIC_NAMES = [
    "Ironheart", "TrussNinja", "BridgeMaster", "SteelDrifter",
    "BeamDream", "PixelEngineer", "Roadworks", "RopeWalker",
    "Buttress", "Cantilever", "Switchback", "Keystone",
    "Riveter", "ArchAce", "SpanWright", "GirderGhost",
    "TensionPro", "LoadBearer", "DeckHand", "Pylon",
    "Foreman", "Surveyor", "Drafty", "Plumbline",
];

function hashStr(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
    return h >>> 0;
}

function lcg(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xFFFFFFFF;
    };
}

function generateSynthetic(levelId, budget, count = 80) {
    const rand = lcg(hashStr(levelId));
    const players = [];
    for (let i = 0; i < count; i++) {
        const r = rand();
        let efficiency;
        if (r < 0.10) efficiency = 0.90 + rand() * 0.07;
        else if (r < 0.85) efficiency = 0.55 + rand() * 0.30;
        else efficiency = 0.30 + rand() * 0.25;
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

// ─── Local "best run" cache (used both online and offline) ─
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
 * Submit a level-completion score. Always updates the local PB cache; when
 * inside the portal also pushes to the cross-user leaderboard.
 *
 * Returns { isPB, prevBest } so the UI can flag a new personal record.
 */
export async function submitScore({ levelId, budgetUsed, budget, playerName = "You", grade = null }) {
    const scores = readScores();
    const prev = scores[levelId];
    const isPB = !prev || budgetUsed < prev.budgetUsed;
    if (isPB) {
        scores[levelId] = { budgetUsed, budget, playerName, ts: Date.now() };
        writeScores(scores);
    }

    // Push to cross-user board when authenticated. Server rejects
    // non-improvements so it's safe to send every completion.
    if (isInPortal()) {
        submitPortalScore(levelId, budgetUsed, grade).catch(() => {});
    }

    return { isPB, prevBest: prev ? prev.budgetUsed : null };
}

/**
 * Fetch the leaderboard for `levelId`. Tries the portal first; falls back
 * to the synthetic field when running standalone or if the bridge times
 * out. Same return shape regardless of source so the UI doesn't care.
 */
export async function getLeaderboard(levelId, currentRun = null) {
    if (isInPortal()) {
        const remote = await fetchPortalLeaderboard(levelId, { limit: 10 });
        if (remote && remote.ok) {
            return {
                top: remote.top || [],
                userRank: remote.userRank ?? null,
                userPercentile: remote.userPercentile ?? null,
                totalPlayers: remote.totalPlayers ?? 0,
                userEntry: remote.userEntry || null,
                source: "portal",
            };
        }
        // Portal answered but with an error — fall through to synthetic so
        // the UI isn't blank.
    }

    return getLeaderboardSynthetic(levelId, currentRun);
}

function getLeaderboardSynthetic(levelId, currentRun) {
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
        top: all.slice(0, 10),
        userRank,
        userPercentile,
        totalPlayers,
        userEntry,
        source: "synthetic",
    };
}
