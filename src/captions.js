// ═══════════════════════════════════════════════════════
//  Modal captions
//
//  Random one-liners for the win and fail modals. Per-level
//  pools mix in with a generic pool so each level has hint
//  flavor without repeating itself.
// ═══════════════════════════════════════════════════════

const GENERIC_FAIL = [
    "Didn't hold up.",
    "Almost — but not quite.",
    "Better luck next try.",
    "The bridge had other plans.",
    "Physics: 1, You: 0.",
    "So close.",
    "The forces won this round.",
    "Try a different approach.",
];

const GENERIC_WIN = [
    "Bridge held strong!",
    "Crossed safely.",
    "Solid build!",
    "Held it together.",
    "Smooth crossing.",
    "Built to last.",
    "Engineering wins.",
    "Looking good!",
];

const LEVEL_FAIL = {
    first: [
        "Triangles are your friend.",
        "More beams underneath might help.",
        "A simple fix away from working.",
    ],
    stepstone: [
        "That rock pier wants to be used.",
        "Heavy load, heavier supports.",
        "Try the stone road slot.",
    ],
    ropeintro: [
        "Rope only PULLS, never pushes.",
        "Hang the deck from the towers.",
        "Tension is the tool here.",
    ],
    ramp: [
        "Slopes push sideways. Brace it.",
        "Both passes have to hold.",
        "Thrust got the better of it.",
    ],
    steelintro: [
        "Truss too shallow — go deeper.",
        "Triangulate top AND bottom.",
        "Use the lower anchors!",
    ],
    steepfall: [
        "Climb in stages — use the mid pier.",
        "Heavy flatbed needs deeper supports.",
        "Bridge to the rock first, then over.",
    ],
    string: [
        "Cables can't push down.",
        "Keep them in tension.",
    ],
    suspend: [
        "Use both towers.",
        "More hangers, more support.",
    ],
    gorge: [
        "Long spans want stronger centers.",
        "Reinforced road carries more.",
    ],
    heavy: [
        "Even heavier this round.",
        "Reinforce, reinforce.",
    ],
    budget: [
        "Less is more — but not THAT less.",
        "Find the minimum that holds.",
    ],
    zigzag: [
        "Two slopes, two stress patterns.",
        "Brace each side independently.",
    ],
    highway: [
        "Two vehicles, double the load.",
        "Both passes count.",
    ],
    express: [
        "Three cars test every joint.",
    ],
    finale: [
        "The last one is the toughest.",
    ],
};

const LEVEL_WIN = {
    first: [
        "First bridge, nailed it!",
        "Beam there, done that.",
    ],
    stepstone: [
        "The pier carried its weight.",
        "Stone road delivered.",
    ],
    ropeintro: [
        "Suspended in style.",
        "The towers earned their keep.",
    ],
    ramp: [
        "Both directions, no problem.",
        "Survived the slope.",
    ],
    steelintro: [
        "Truss carried the bus.",
        "Triangles for the win.",
    ],
    steepfall: [
        "Climbed it clean.",
        "Stepped bridge held both.",
    ],
    finale: [
        "Master engineer status.",
    ],
};

function pickFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

export function pickFailCaption(levelId) {
    const pool = [...(LEVEL_FAIL[levelId] || []), ...GENERIC_FAIL];
    return pickFrom(pool);
}

export function pickWinCaption(levelId, vehicleName) {
    const pool = [...(LEVEL_WIN[levelId] || []), ...GENERIC_WIN];
    const raw = pickFrom(pool);
    return raw.replace("${vehicle}", String(vehicleName || "").toUpperCase());
}
