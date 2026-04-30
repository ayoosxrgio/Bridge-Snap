// Grid & world layout
export const GRID = 12;
export const WORLD_MID_Y = 396;
export const ANCHOR_L_X = 180;
export const PAD_X = 300;

/** Inland offset (world units past cliff anchor) where finish flags sit — keep in sync with game scene drawFlags */
export const FLAG_INLAND_R = 130;
export const FLAG_INLAND_L = 180;
/** Past the flag + this margin before a multi-vehicle car counts as finished (lets it drive off-screen). */
export const MULTI_FINISH_PAST_FLAG = 72;

// Color palette
export const C = {
    // Background & UI base
    paper:        "#f5f0e6",
    paperLines:   "rgba(100, 160, 220, 0.18)",
    paperLinesMaj:"rgba(100, 160, 220, 0.35)",
    marginRed:    "rgba(220, 80, 80, 0.25)",
    desk:         "#3b2f20",

    // Terrain
    dirt:         "#b08540",
    dirtDk:       "#7a5520",
    dirtLt:       "#c4943c",
    cliffEdge:    "#8B6914",

    // Metal
    wire:         "#a8b4c0",
    wireShine:    "#d4dde6",

    // Tape & glue (UI decorations)
    glue:         "#fffad2",
    glueDot:      "#f0ebc3",
    tape:         "#e6dcb4",

    // Text & markers
    pencil:       "#3a3a3a",
    marker:       "#222222",
    markerBlue:   "#2563eb",
    markerRed:    "#dc2626",
    markerGreen:  "#16a34a",
    eraser:       "#f0e8d8",

    // UI
    safe:         "#4a9e4a",
    warning:      "#d4a017",
    danger:       "#cc3333",
    accent:       "#2563eb",
    gold:         "#d4a017",

    // Stress colors (green → yellow → red)
    stressLow:    "#5b9e3e",
    stressMid:    "#d4a017",
    stressHigh:   "#cc3333",
};

// ═══════════════════════════════════════════════════════
//  MATERIALS — XPBD constraint-based
//
//  compliance:  XPBD softness parameter (lower = stiffer)
//               0.00001 = very rigid (steel)
//               0.001   = flexible (rope)
//  breakForce:  constraint force at which member snaps
//               higher = stronger material
// ═══════════════════════════════════════════════════════
export const MATERIALS = {
    // ── Roads (vehicles drive on these) ──────────────
    wood_road: {
        label:       "Wood Road",
        key:         "wood_road",
        color:       "#b08540",
        colorDark:   "#7a5520",
        compliance:  0.002,
        breakForce:  300,
        price:       120,
        width:       10,
        maxLength:   72,       // 2 grid cells
        isRoad:      true,
        tensionOnly: false,
        desc:        "Wooden planks — cheap road surface, breaks under heavy loads",
    },
    reinforced_road: {
        label:       "Reinforced Road",
        key:         "reinforced_road",
        color:       "#8a6a3a",
        colorDark:   "#5a4020",
        compliance:  0.001,
        breakForce:  550,
        price:       250,
        width:       12,
        maxLength:   72,
        isRoad:      true,
        tensionOnly: false,
        desc:        "Steel-reinforced planks — handles trucks and heavier vehicles",
    },
    stone_road: {
        label:       "Stone Road",
        key:         "stone_road",
        color:       "#9a9a9a",
        colorDark:   "#6a6a6a",
        compliance:  0.0005,
        breakForce:  900,
        price:       400,
        width:       11,
        maxLength:   72,
        isRoad:      true,
        tensionOnly: false,
        desc:        "Stone slab road — extremely strong, handles the heaviest loads",
    },

    // ── Structural (support beams) ───────────────────
    wood_beam: {
        label:       "Wood Beam",
        key:         "wood_beam",
        color:       "#DEB887",
        colorDark:   "#C49A6C",
        compliance:  0.0001,
        breakForce:  450,
        price:       35,
        width:       6,
        maxLength:   108,      // 3 grid cells
        isRoad:      false,
        tensionOnly: false,
        desc:        "Wooden beam — cheap structural support",
    },
    steel: {
        label:       "Steel Beam",
        key:         "steel",
        color:       "#c43838",          // brick-red — the "stronger beam" cue
        colorDark:   "#7a2020",
        compliance:  0.00002,
        breakForce:  1200,
        price:       450,
        width:       5,
        maxLength:   144,      // 4 grid cells
        isRoad:      false,
        tensionOnly: false,
        desc:        "Steel I-beam — very strong and rigid, but expensive",
    },

    // ── Tension-only (cables & rope) ─────────────────
    rope: {
        label:       "Rope",
        key:         "rope",
        color:       "#8B6914",
        colorDark:   "#5a4010",
        compliance:  0.004,
        breakForce:  250,
        price:       60,
        width:       3,
        maxLength:   252,      // 7 grid cells
        isRoad:      false,
        tensionOnly: true,
        desc:        "Hemp rope — flexible, cheap, tension only (goes slack when pushed)",
    },
    cable: {
        label:       "Steel Cable",
        key:         "cable",
        color:       "#555555",
        colorDark:   "#333333",
        compliance:  0.0003,
        breakForce:  800,
        price:       150,
        width:       4,
        maxLength:   252,
        isRoad:      false,
        tensionOnly: true,
        desc:        "Steel cable — strong tension member, less flex than rope",
    },
};

// Each base material has a stronger "tier-2" version that the player can
// reveal by double-clicking the material slot in the toolbar. Costs more,
// breaks under heavier loads — a lever for the player to spend extra budget
// on a few critical members instead of the whole bridge.
export const MATERIAL_UPGRADES = {
    wood_road: "stone_road",
    wood_beam: "steel",
    rope:      "cable",
};

// ═══════════════════════════════════════════════════════
//  VEHICLES
// ═══════════════════════════════════════════════════════
export const VEHICLES = {
    // ── Light ────────────────────────────────────────
    bicycle: {
        name: "BICYCLE",
        label: null,
        mass: 10,
        w: 22, h: 20,
        speed: 1.5,
        color: "#7a5cb8",
        wheels: 2,
        sprite: "veh_bicycle",
    },
    car: {
        name: "COMPACT CAR",
        label: "CAR",
        mass: 50,
        w: 34, h: 15,
        speed: 2.0,
        color: "#4a7ab5",
        wheels: 2,
        sprite: "veh_car",
    },
    datsun: {
        name: "DATSUN",
        label: "DAT",
        mass: 65,
        w: 36, h: 16,
        speed: 1.8,
        color: "#c46a2a",
        wheels: 2,
        sprite: "veh_datsun",
    },

    // ── Medium ───────────────────────────────────────
    sports_car: {
        name: "SPORTS CAR",
        label: "FAST",
        mass: 70,
        w: 38, h: 14,
        speed: 2.5,
        color: "#d4b020",
        wheels: 2,
        sprite: "veh_sports",
    },
    corolla: {
        name: "COROLLA",
        label: "COR",
        mass: 75,
        w: 36, h: 16,
        speed: 1.7,
        color: "#cc3333",
        wheels: 2,
        sprite: "veh_corolla",
    },
    jeep: {
        name: "JEEP",
        label: "JEEP",
        mass: 100,
        w: 44, h: 22,
        speed: 1.5,
        color: "#e890a0",
        wheels: 2,
        sprite: "veh_jeep",
    },

    // ── Heavy ────────────────────────────────────────
    ice_cream: {
        name: "ICE CREAM VAN",
        label: "ICE",
        mass: 130,
        w: 48, h: 24,
        speed: 1.2,
        color: "#e8c8a0",
        wheels: 2,
        sprite: "veh_icecream",
    },
    truck: {
        name: "DELIVERY VAN",
        label: "VAN",
        mass: 150,
        w: 52, h: 26,
        speed: 1.2,
        color: "#c46a20",
        wheels: 3,
        sprite: "veh_truck",
    },
    camper: {
        name: "CAMPER VAN",
        label: "CAMP",
        mass: 180,
        w: 65, h: 24,
        speed: 1.0,
        color: "#5a9a5a",
        wheels: 2,
        sprite: "veh_camper",
    },

    // ── Very Heavy ───────────────────────────────────
    bus: {
        name: "SCHOOL BUS",
        label: "BUS",
        mass: 300,
        w: 80, h: 28,
        speed: 0.9,
        color: "#d4a020",
        wheels: 4,
        sprite: "veh_bus",
    },
    flatbed: {
        name: "FLATBED TRUCK",
        label: "FLAT",
        mass: 400,
        w: 90, h: 30,
        speed: 0.8,
        color: "#8a4a2a",
        wheels: 4,
        sprite: "veh_flatbed",
    },
    boat_trailer: {
        name: "BOAT TRAILER",
        label: "BOAT",
        mass: 350,
        w: 85, h: 28,
        speed: 0.7,
        color: "#3a7a9a",
        wheels: 3,
        sprite: "veh_boat",
    },
};
