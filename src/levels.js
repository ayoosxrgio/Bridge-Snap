// Each level teaches a structural engineering concept
// hDiff: positive = right anchor is LOWER than left
//
// ALL gaps, hDiffs, and anchor offsets are multiples of GRID (36px)
//
// PROGRESSION:
//   Ch 1 (L1-4):  wood_road + wood_beam — bicycle, car
//   Ch 2 (L5-6):  + steel — sports_car, jeep
//   Ch 3 (L7-8):  + cable + rope — corolla, datsun
//   Ch 4 (L9-10): + reinforced_road — truck, camper
//   Ch 5 (L11-12): + stone_road — bus
//   Ch 6 (L13-15): all materials — flatbed, boat_trailer, multi-vehicle

export const LEVELS = [
    // ═══ CHAPTER 1: WOOD & BASICS ═══════════════════
    {
        id:       "first",
        name:     "CASUAL CROSS",
        concept:  "BASICS",
        gimmick:  "road",
        difficulty: 1,
        vType:    "car",
        gap:      360,
        hDiff:    0,
        budget:   7000,
        terrain:  "canyon",
        extraAnchors: [],
        multiVehicle: null,
        materials: ["wood_road", "wood_beam"],
        hint:     "Lay wood planks anchor-to-anchor for the road, then add beams underneath so the car doesn't snap them. Two anchors, flat ground — easy crossing.",
        lesson:   "Every bridge needs a ROAD surface for vehicles and BEAMS for support. Wood planks are your road — beams hold them up so they don't sag and break under a car's weight.",
    },
    {
        id:       "stepstone",
        name:     "STEPPING STONE",
        concept:  "PIERS",
        gimmick:  "pier",
        difficulty: 2,
        vType:    "jeep",
        gap:      540,       // wider gap — right cliff sits further out
        hDiff:    -72,       // right anchor sits 2 grid units ABOVE the left — mild uphill
        budget:   13000,
        terrain:  "gorge",
        extraAnchors: [
            // Rock pokes out of the water just left of center: dx=-72 shifts
            // it 2 grids west of midX, dy=36 puts the anchor 1 grid below road
            // level — barely above the waterline so the cap shows above water
            // while the body submerges.
            { side: "MID", dx: -72, dy: 36 },
        ],
        multiVehicle: null,
        materials: ["wood_road", "wood_beam"],
        hint:     "Use the rock as a PIER — build a vertical support from it up to the road. Splitting the span in two makes each half easier to hold up. The right side is longer, so triangulate it carefully — the jeep is heavier than the car.",
        lesson:   "A PIER is a vertical support from below that breaks a long span into two shorter ones. Shorter spans deflect less and are far stronger for the same material. Most highway bridges rest on piers.",
    },
    {
        id:       "ropeintro",
        name:     "HANG ON",
        concept:  "TENSION",
        gimmick:  "cable",
        difficulty: 3,
        vType:    "camper",
        gap:      468,
        hDiff:    0,
        budget:   16000,
        terrain:  "canyon",
        extraAnchors: [
            { side: "L", dx: -36, dy: -144 },
            { side: "R", dx:  36, dy: -144 },
        ],
        vStartXOffset: -110,
        multiVehicle: null,
        materials: ["wood_road", "wood_beam", "rope"],
        hint:     "The gap is too long for beams alone — the tall anchors above each cliff are for rope. Hang the road from the towers, then brace with wood beams underneath.",
        lesson:   "Rope works only in TENSION — it pulls, never pushes. A suspension bridge hangs the deck from ropes or cables anchored high above. Once slack, rope does nothing — keep it taut!",
    },
    {
        id:       "ramp",
        name:     "THE RAMP",
        concept:  "TWO-WAY",
        gimmick:  "slope",
        difficulty: 3,
        vType:    "datsun",         // primary vehicle (used by helpers / AI hints)
        gap:      396,
        hDiff:    108,
        budget:   13000,             // wider unlock list + two passes → bumped budget
        terrain:  "cliff",
        extraAnchors: [],
        // CAR A drives left → right to the red flag, then once it has cleared
        // the screen CAR B starts on the right cliff and crosses LEFT to the
        // blue flag. Bridge has to survive both passes.
        multiVehicle: [
            // Datsun A drives off-screen past its flag — that release is what
            // lets corolla B start (immersive "swap-on-the-road" handoff).
            { vType: "datsun",  label: "A", flag: "red",  dir:  1, startSide: "L", startXOffset: -55, goalSide: "R", passOnly: true },
            { vType: "corolla", label: "B", flag: "blue", dir: -1, startSide: "R", startXOffset:  55, goalSide: "L", startAfter: 0 },
        ],
        materials: ["wood_road", "wood_beam", "rope"],
        hint:     "Two cars, opposite directions. Datsun A heads right to the red flag, then corolla B starts on the right and crosses left to the blue flag. Brace the slope so both passes hold. (Steel beam is unlocked — double-click the wood beam to switch.)",
        lesson:   "Sloped bridges experience THRUST — gravity pulls down, but the slope redirects force sideways. Diagonal bracing transfers thrust safely into the anchors. A bridge that survives one pass can still fail the next as fatigue builds.",
    },

    // ═══ CHAPTER 2: INTRODUCING STEEL ═══════════════
    {
        id:       "steelintro",
        name:     "TRUSSED UP",
        concept:  "TRUSS",
        gimmick:  "heavy",
        difficulty: 3,
        vType:    "bus",
        gap:      720,
        hDiff:    0,
        budget:   24000,
        terrain:  "cliff",
        // A second anchor one grid BELOW each cliff edge gives the player
        // a place to plant the lower chord of a truss — triangulating
        // above and below the road is what makes long thin spans hold
        // a heavy bus.
        extraAnchors: [
            { side: "L", dx: 0, dy: 60 },
            { side: "R", dx: 0, dy: 60 },
        ],
        vStartXOffset: -120,
        multiVehicle: null,
        materials: ["wood_road", "wood_beam", "rope"],
        hint:     "Wide flat gap, heavy bus. Each cliff has a SECOND anchor one grid below the road — those are for the LOWER chord of a truss. Triangulate above and below the road and a thin span carries way more weight than a plain plank.",
        lesson:   "A TRUSS bridge breaks load across many short members arranged in triangles. The DEEPER the truss (the gap between its upper and lower chord), the stronger it is — that's why railway bridges have those tall iron lattices.",
    },
    {
        id:       "steepfall",
        name:     "UP AND OVER",
        concept:  "STEPPED CLIMB",
        gimmick:  "slope",
        difficulty: 3,
        vType:    "flatbed",
        gap:      612,
        hDiff:    -252,                  // right cliff sits 252 ABOVE left — steep staircase
        budget:   22000,
        terrain:  "cliff",
        // Free-standing land platform between two gaps: 192 wide, sitting
        // 108 above the left cliff. Bridge across to it, drive across,
        // then bridge over the second gap (with a low rock pier) up to
        // the much higher right cliff.
        midLand: { dx: 0, halfW: 96, dy: -108 },
        extraAnchors: [
            { side: "MID", dx: 204, dy: -120 },    // rock pier in the second gap — only slightly above the platform
        ],
        // Heavy flatbed leads, light motorbike trails behind. Both head
        // right; spaced starts so they don't pile up at the finish flags.
        // Convoy: flatbed leads, bicycle stays behind it (followBehind throttles
        // the faster bike to the truck's pace). Bicycle takes the inner flag
        // (slot 0) so the leading flatbed can drive past it to the outer flag.
        multiVehicle: [
            { vType: "bicycle", label: "B", flag: "blue", color: "#7a5cb8",
              startXOffset: -210, followBehind: 1, followGap: 8 },
            { vType: "flatbed", label: "A", flag: "red",  color: "#8a4a2a",
              startXOffset: -90 },
        ],
        materials: ["wood_road", "wood_beam", "rope"],
        hint:     "Two gaps! Bridge to the left edge of the mid land, drive across, then bridge over the second gap (with a rock pier) up to the higher right cliff. Flatbed is heavy, motorbike is light.",
        lesson:   "Real terrain steps up in stages. Bridges often climb onto a midpoint platform and continue from there, breaking one steep ramp into shorter sections that each carry less load.",
    },

    // ═══ CHAPTER 3: CABLES & ROPE ═══════════════════
    {
        id:       "string",
        name:     "STRING THEORY",
        concept:  "TENSION",
        gimmick:  "cable",
        difficulty: 2,
        vType:    "corolla",
        gap:      396,
        hDiff:    0,
        budget:   11000,
        terrain:  "canyon",
        extraAnchors: [
            { side: "L", dx: 0, dy: -108 },
            { side: "R", dx: 0, dy: -108 },
        ],
        multiVehicle: null,
        materials: ["wood_road", "wood_beam", "rope"],
        hint:     "Use the HIGH anchor points and rope to pull the road UP from above. Rope only works when stretched — it goes slack if compressed.",
        lesson:   "Rope and cables work only in TENSION (pulling). They're light and strong but can't push. A suspension bridge hangs the road from cables attached above!",
    },
    {
        id:       "suspend",
        name:     "HANG IN THERE",
        concept:  "SUSPENSION",
        gimmick:  "cable",
        difficulty: 3,
        vType:    "datsun",
        gap:      468,
        hDiff:    0,
        budget:   16000,
        terrain:  "canyon",
        extraAnchors: [
            { side: "L", dx: 0, dy: -108 },
            { side: "R", dx: 0, dy: -108 },
        ],
        multiVehicle: null,
        materials: ["wood_road", "wood_beam", "rope"],
        hint:     "Combine steel cables from above with a stiff truss deck below. Cables take tension, the truss resists bending — together they span farther.",
        lesson:   "A true SUSPENSION bridge combines cables (tension), a stiff deck (bending resistance), and anchorages. This system lets bridges span enormous distances!",
    },

    // ═══ CHAPTER 4: REINFORCED ROADS & HEAVY LOADS ══
    {
        id:       "gorge",
        name:     "DEEP VALLEY",
        concept:  "PIERS",
        gimmick:  "pier",
        difficulty: 3,
        vType:    "truck",
        gap:      504,
        hDiff:    0,
        budget:   20000,
        terrain:  "gorge",
        extraAnchors: [
            { side: "L", dx: 0, dy: 108 },
            { side: "L", dx: 0, dy: 216 },
            { side: "R", dx: 0, dy: 108 },
            { side: "R", dx: 0, dy: 216 },
        ],
        multiVehicle: null,
        materials: ["wood_road", "wood_beam", "rope"],
        hint:     "Use the wall anchors BELOW to build vertical piers up to road level. A delivery van is crossing — use reinforced road for the heaviest spans!",
        lesson:   "PIERS are vertical supports built from below. They break a long span into shorter sections, each easier to bridge. This is how most real highway bridges work!",
    },
    {
        id:       "heavy",
        name:     "HEAVY LOAD",
        concept:  "REINFORCEMENT",
        gimmick:  "heavy",
        difficulty: 3,
        vType:    "camper",
        gap:      396,
        hDiff:    0,
        budget:   18000,
        terrain:  "canyon",
        extraAnchors: [],
        multiVehicle: null,
        materials: ["wood_road", "wood_beam", "rope"],
        hint:     "No piers this time — span the full gap for a heavy camper van. Reinforced road + steel beams at critical spots.",
        lesson:   "When you can't build piers, the structure itself must be stronger. REINFORCEMENT means adding material where forces concentrate — usually at the center and supports.",
    },

    // ═══ CHAPTER 5: STONE ROADS & ADVANCED ══════════
    {
        id:       "budget",
        name:     "PENNY PINCH",
        concept:  "EFFICIENCY",
        gimmick:  "budget",
        difficulty: 3,
        vType:    "car",
        gap:      396,
        hDiff:    0,
        budget:   4500,
        terrain:  "canyon",
        extraAnchors: [],
        multiVehicle: null,
        materials: ["wood_road", "wood_beam", "rope"],
        hint:     "Tiny budget, but the full upgrade tree is unlocked. Steel and cable are pricey here — every beam costs money. Find the absolute minimum structure that still holds a car.",
        lesson:   "The best engineering isn't the strongest bridge — it's the one that's JUST strong enough. Efficiency means using the minimum material for the required load.",
    },
    {
        id:       "zigzag",
        name:     "SWITCHBACK",
        concept:  "STEEP + PIERS",
        gimmick:  "slope",
        difficulty: 4,
        vType:    "bus",
        gap:      468,
        hDiff:    180,
        budget:   28000,
        terrain:  "gorge",
        extraAnchors: [
            { side: "L", dx: 0, dy: 144 },
            { side: "R", dx: 0, dy: 144 },
        ],
        multiVehicle: null,
        materials: ["wood_road", "wood_beam", "rope"],
        hint:     "Steep slope + deep gorge + heavy bus. Use stone road for the bus, wall anchors for piers, and steel where stress is worst.",
        lesson:   "Real bridges often face MULTIPLE challenges at once: slopes, heavy loads, deep valleys. The best engineers combine piers, trusses, cables, and material choices.",
    },

    // ═══ CHAPTER 6: BOSS LEVELS ═════════════════════
    {
        id:       "highway",
        name:     "RUSH HOUR",
        concept:  "MULTI-LOAD",
        gimmick:  "multi",
        difficulty: 4,
        vType:    "car",
        gap:      468,
        hDiff:    0,
        budget:   22000,
        terrain:  "canyon",
        extraAnchors: [],
        multiVehicle: [
            { vType: "jeep",       startXOffset: -72,  label: "A", color: "#e890a0" },
            { vType: "sports_car", startXOffset: -144, label: "B", color: "#d4b020" },
        ],
        materials: ["wood_road", "wood_beam", "rope"],
        hint:     "Two vehicles cross at the same time! Your bridge must hold both simultaneously.",
        lesson:   "Real bridges carry MANY vehicles at once. When multiple loads are present, forces ADD UP. Your structure needs enough redundancy that no single member is a weak link.",
    },
    {
        id:       "express",
        name:     "THE EXPRESS",
        concept:  "MASTERY",
        gimmick:  "heavy",
        difficulty: 5,
        vType:    "flatbed",
        gap:      540,
        hDiff:    0,
        budget:   38000,
        terrain:  "gorge",
        extraAnchors: [
            { side: "MID", dx: -108, dy: 216 },
            { side: "MID", dx:    0, dy: 216 },
            { side: "MID", dx:  108, dy: 216 },
        ],
        multiVehicle: null,
        materials: ["wood_road", "wood_beam", "rope"],
        hint:     "A flatbed truck — the heaviest vehicle. Build piers from the valley floor and use stone road with a full steel truss.",
        lesson:   "Heavy transport bridges are over-engineered on purpose — trucks are heavy and can't steer around problems. REDUNDANCY (extra strength beyond the minimum) saves lives.",
    },
    {
        id:       "finale",
        name:     "GRAND FINALE",
        concept:  "EVERYTHING",
        gimmick:  "multi",
        difficulty: 5,
        vType:    "truck",
        gap:      612,
        hDiff:    108,
        budget:   45000,
        terrain:  "gorge",
        extraAnchors: [
            { side: "L", dx: 0, dy: -108 },
            { side: "R", dx: 0, dy: -108 },
            { side: "L", dx: 0, dy: 144 },
            { side: "R", dx: 0, dy: 144 },
        ],
        multiVehicle: [
            { vType: "bus",       startXOffset: -72,  label: "A", color: "#d4a020" },
            { vType: "camper",    startXOffset: -180, label: "B", color: "#5a9a5a" },
            { vType: "sports_car", startXOffset: -288, label: "C", color: "#d4b020" },
        ],
        materials: ["wood_road", "wood_beam", "rope"],
        hint:     "Sloped gorge, three vehicles, anchors above and below. Combine piers, suspension cables, steel reinforcement, and the right road type for each section.",
        lesson:   "You've mastered bridge engineering! Every real bridge is a puzzle: terrain, loads, materials, and budget. The best engineers find elegant solutions that balance ALL constraints.",
    },
];
