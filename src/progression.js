// Progression system — persists to localStorage
const STORAGE_KEY = "bridgesnap_progress";

function loadProgress() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return { completed: [], grades: {} };
}

function saveProgress(data) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* ignore */ }
}

// Returns array of completed level indices
export function getCompleted() {
    return loadProgress().completed;
}

// Returns grade for a level index (or null)
export function getGrade(levelIdx) {
    return loadProgress().grades[levelIdx] || null;
}

// Check if a level is unlocked (level 0 always unlocked, others need previous completed)
export function isUnlocked(levelIdx) {
    if (levelIdx === 0) return true;
    return getCompleted().includes(levelIdx - 1);
}

// Mark a level as completed with a grade
export function completeLevel(levelIdx, grade) {
    const data = loadProgress();
    if (!data.completed.includes(levelIdx)) {
        data.completed.push(levelIdx);
    }
    // Only upgrade grade, never downgrade (S > A > B > C)
    const ranks = ["C", "B", "A", "S"];
    const oldRank = ranks.indexOf(data.grades[levelIdx] || "");
    const newRank = ranks.indexOf(grade);
    if (newRank > oldRank) {
        data.grades[levelIdx] = grade;
    }
    saveProgress(data);
}

// Reset all progress
export function resetProgress() {
    saveProgress({ completed: [], grades: {} });
}
