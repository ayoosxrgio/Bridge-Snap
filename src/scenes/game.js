import { C, GRID, MATERIALS, MATERIAL_UPGRADES, VEHICLES, WORLD_MID_Y, ANCHOR_L_X, PAD_X, FLAG_INLAND_R, FLAG_INLAND_L, MULTI_FINISH_PAST_FLAG } from "../constants.js";
import { LEVELS } from "../levels.js";
import { Node, Member, Spark, snapToGrid, distToSegment, distToSegmentSq, isConnectedToAnchor, calcCost, physicsTick, vehicleTick, initPhysicsWorld, destroyPhysicsWorld } from "../physics.js";
import { solveBridge } from "../aiHelper.js";
import { completeLevel, getCompleted } from "../progression.js";
import { onLevelStart, onBridgeFailed, onBridgeSuccess, onLevelComplete, onHintRequest, onRecapRequest } from "../assistantBridge.js";
import { submitScore, getLeaderboard } from "../leaderboard.js";
import { pickFailCaption, pickWinCaption } from "../captions.js";

export function gameScene(k, { levelIdx }) {
    const lvlDef = LEVELS[levelIdx];

    // ─── Palette ─────────────────────────────────────
    // Used by SNAP! popup, FINISH text, and the floating car-label letters.
    // Hoisted near the top of the scene so initialization-time helpers can
    // safely read from it before any of the draw fns reference it.
    const SNAP_COLORS = ["#e05080","#50a0e0","#e0c030","#50c060","#e07030","#a060d0"];

    // ─── Color cache ─────────────────────────────────
    // k.Color.fromHex allocates a new object on every call. The render path
    // calls it 200+ times per frame for the same handful of hex strings,
    // which churns the GC on slower laptops. Cache by hex so repeats reuse
    // the same Color instance — Kaplay treats Color as immutable internally,
    // so sharing references is safe.
    const _colorCache = new Map();
    const _kColorFromHex = k.Color.fromHex.bind(k.Color);
    const colorOf = (hex) => {
        let c = _colorCache.get(hex);
        if (!c) { c = _kColorFromHex(hex); _colorCache.set(hex, c); }
        return c;
    };

    // In-place array compaction: runs the visit fn on every element, drops
    // the ones for which it returns falsy, and keeps the rest. Avoids the
    // per-frame allocation of Array.prototype.filter, which churns the GC
    // when called several times per tick on long-lived effect arrays
    // (particles, splashes, confetti, popups).
    const compactInPlace = (arr, visit) => {
        let w = 0;
        for (let r = 0; r < arr.length; r++) {
            const item = arr[r];
            if (visit(item)) {
                if (w !== r) arr[w] = item;
                w++;
            }
        }
        if (w !== arr.length) arr.length = w;
    };

    // ─── Camera / coordinate system ─────────────────
    const lX = ANCHOR_L_X;
    const rX = lX + lvlDef.gap;
    const midX = lX + lvlDef.gap / 2;
    const lY = Math.round((WORLD_MID_Y - lvlDef.hDiff / 2) / GRID) * GRID;
    const rY = lY + lvlDef.hDiff;

    const lvl = { gap: lvlDef.gap, hDiff: lvlDef.hDiff, lX, rX, lY, rY, midX, terrain: lvlDef.terrain, vType: lvlDef.vType, budget: lvlDef.budget };

    function getScale() { return k.width() / (lvl.gap + PAD_X * 2); }
    // Vertical anchor — what fraction of the canvas height the cliff line
    // sits at. Default 0.62 keeps cliffs in the lower half so the bridge
    // build area gets the upper portion of the screen. A level can override
    // this (e.g. 0.42) when it wants more room BELOW the cliff for a tall
    // mid-gap obstacle.
    const CLIFF_Y_FRAC = lvlDef.cliffScreenAnchor != null ? lvlDef.cliffScreenAnchor : 0.62;
    function getOffY() {
        const sc = getScale();
        return (k.height() * CLIFF_Y_FRAC) / sc - WORLD_MID_Y;
    }
    function toScreen(wx, wy) {
        const sc = getScale();
        const offX = PAD_X - ANCHOR_L_X;
        return k.vec2((wx + offX) * sc, (wy + getOffY()) * sc);
    }
    function toWorld(sx, sy) {
        const sc = getScale();
        const offX = PAD_X - ANCHOR_L_X;
        return { x: sx / sc - offX, y: sy / sc - getOffY() };
    }

    // ─── Game state ─────────────────────────────────
    // Persisted UI prefs (sidebar toggles + fpsCap). Read once at scene
    // construction; individual toggles persist by re-reading and merging
    // before save so other settings written elsewhere aren't clobbered.
    const _userPrefs = (() => {
        try { return JSON.parse(localStorage.getItem("bridgesnap_settings")) || {}; }
        catch { return {}; }
    })();

    const state = {
        mode: "build",       // build | sim | end
        delMode: false,
        // ── Sidebar toggles (persisted) ───────────────────
        // Default true for all three so first-time players see the full
        // tutorial-friendly layout. Player can opt out via the bottom-left
        // sidebar; their choice is saved across sessions.
        showGrid:   _userPrefs.showGrid    !== false,
        snapGrid:   _userPrefs.snapGrid    !== false,
        showStress: _userPrefs.showStress  !== false,
        // Sidebar slide-out animation. Driven entirely by mode now (open
        // in build, closed in sim/end) — no manual toggle. Initialized to
        // 1 since we open in build mode by default.
        sidebarOpenT: 1,
        simSpeed: 1,
        selectedMat: (lvlDef.materials || Object.keys(MATERIALS))[0],
        nodes: [],
        members: [],
        vehicles: [],
        particles: [],
        simTime: 0,
        shakeMag: 0,
        finished: false,
        finishCalled: false,
        flagWave: 0,
        hoveredMember: null,
        dragStart: null,     // node we're dragging from
        dragging: false,
        lineMode: false,      // line fill: drag to auto-place segments along a straight line
        // Polybridge-style auto-extend: after placing a road, remember the end
        // node + direction vector so the next click near the predicted next
        // endpoint extends the chain by one segment. Cleared on tool/material
        // change, undo, sim toggle, etc. Shape: { node, dx, dy }.
        lastRoadEnd: null,
        archMode: false,      // arch tool: click A → click B → drag apex handle → click off to commit
        // ── Select tool ────────────────────────
        selectMode: false,
        selectBoxing: false,   // drawing a marquee rectangle right now
        selectBoxStart: null,  // world coords {x, y} where the drag started
        selectBoxEnd: null,    // world coords {x, y} current cursor while drawing
        selectedMembers: new Set(),
        selectMoving: false,   // dragging the current selection to a new spot
        selectMoveStart: null, // world coords where the move drag began
        selectMoveOrig: null,  // Map<Node, {x,y,rx,ry}> — snapshot for undo
        archStart: null,      // { x, y } — first anchor (set after first click)
        archEnd: null,        // { x, y } — second anchor (set after second click — enters edit mode)
        archBulge: 0,         // signed perpendicular distance from chord midpoint to apex
        archDragging: false,  // true while user is dragging the apex handle
        // Phase-B bulge direction: -1 = up (default), +1 = down. Updated only
        // when cursor moves CLEARLY past the chord midpoint (hysteresis zone),
        // so the preview doesn't flicker as the cursor jitters near the anchor.
        archBulgeDir: -1,
        // Placed arches — each entry { id, start, end, bulge }. archId stamps on
        // the Members placed by that arch so we can find them for edit/resize.
        arches: [],
        nextArchId: 0,
        editingArchId: null,       // non-null while re-editing a placed arch
        // Snapshot taken on edit-select so cancel/undo can restore exactly:
        //   origBulge:   archData.bulge before the edit
        //   nodeStates:  Map<Node, {x, y, rx, ry}> of every node in the arch
        //   restStates:  Map<Member, number> of every arch member's rest length
        editingArchOrig: null,
        // Undo: each entry is one user action; an action may have placed many
        // members at once (line-fill, arch). Undo pops the latest action and
        // removes everything it added.
        undoStack: [],
        redoStack: [],
        mouseWorld: { x: 0, y: 0 },
        // Modal
        modal: null,         // { title, desc, score, win }
        // AI — Socratic tutor lesson
        aiResult: null,      // { concept, steps:[], summary } | { error } | { explanation, concept } (fallback msg)
        aiLoading: false,
        aiPanelOpen: false,
        aiStepIdx: 0,        // which step of the lesson we're on
        aiPhase: "question", // "question" | "feedback" | "done"
        aiChoiceIdx: -1,     // index of the option the player picked (for feedback coloring)
        aiOptionRects: [],   // click-targets rebuilt every frame
        aiNextRect: null,    // "Next" / "Build!" button rect
        // Animation state for the helper
        aiTyped: 0,          // chars of the current explanation revealed so far
        aiHighlightTimer: 0, // seconds remaining on the post-build glow
        aiHighlightMembers: [], // members placed by the most recent "Build & Next"
        // Hint — closed by default; player opens it via the "?" button when needed
        hintOpen: false,
        // Lesson panel
        lessonOpen: false,
        // Splash effects
        splashes: [],
        // SNAP! popup + confetti VFX on bridge break
        snapEvents: [],
        snapPopups: [],
        snapConfetti: [],
        // Hover progress [0..1] for modal text buttons — animates the underline
        // Hover progress [0..1] per material icon — animates the zoom
        matHover: {},
        // Hover progress [0..1] per tool button — animates the zoom
        toolHover: {},
        // Set of base-material keys whose slot is currently REVEALING the
        // upgraded tier-2 version (toggled by double-clicking the slot).
        matExpanded: new Set(),
        // 0..1 reveal animation per slot — drives a flash + scale-bounce.
        matRevealT: {},
        // Tracks the last material slot click for double-click detection:
        // { key, time }. A second click on the same slot within ~0.3s flips
        // the slot to its upgraded form.
        matLastClick: null,
        // First-level tutorial — step-by-step popups with typing animation.
        // Activated below for level 1 only.
        tutorialActive: false,
        tutorialStep: 0,
        tutorialTyped: 0,       // number of chars revealed so far (fractional)
    };

    // Tier-2 (upgraded) materials unlock from level 2 onwards. Level 1 stays
    // single-tier so the player learns the basics before gaining the
    // double-click reveal.
    const upgradesUnlocked = levelIdx > 0;

    // Kick off the tutorial on the first three levels. Suppress the hint sticky
    // note during the walkthrough so it doesn't compete with the popup.
    if (levelIdx === 0 || levelIdx === 1 || levelIdx === 2) {
        state.tutorialActive = true;
        state.hintOpen = false;
    }

    // ─── Initialize nodes & anchors ─────────────────
    state.nodes.push(new Node(lX, lY, true));
    state.nodes.push(new Node(rX, rY, true));

    // Mid-land platform — free-standing piece of terrain between two gaps.
    // Adds two fixed anchors at the platform's top corners; the renderer
    // and collider system pick up state._midLand to draw / collide a solid
    // dirt-and-road body underneath those anchors.
    if (lvlDef.midLand) {
        const ml = lvlDef.midLand;
        const cx = midX + (ml.dx || 0);
        const ly = lY + (ml.dy || 0);
        const xL = Math.round((cx - ml.halfW) / GRID) * GRID;
        const xR = Math.round((cx + ml.halfW) / GRID) * GRID;
        const yT = Math.round(ly / GRID) * GRID;
        state.nodes.push(new Node(xL, yT, true));
        state.nodes.push(new Node(xR, yT, true));
        state._midLand = { x1: xL, x2: xR, y: yT };
    }

    (lvlDef.extraAnchors || []).forEach(a => {
        let nx, ny;
        if (a.side === "L") { nx = lX + a.dx; ny = lY + a.dy; }
        else if (a.side === "R") { nx = rX + a.dx; ny = rY + a.dy; }
        else { nx = midX + a.dx; ny = lY + a.dy; }
        nx = Math.round(nx / GRID) * GRID;
        ny = Math.round(ny / GRID) * GRID;
        state.nodes.push(new Node(nx, ny, true));
    });

    // ─── Initialize vehicles ────────────────────────
    // Spawn vehicles resting ON the approach surface in build mode — wheels on
    // the asphalt top, not hovering. toggleSim lifts them just before the sim
    // starts so the landing drop effect still plays.
    function initVehicles() {
        const ROAD_SURFACE = 5;                        // asphalt top sits above anchor by this much
        const surfaceLeft  = lY - ROAD_SURFACE;
        const surfaceRight = rY - ROAD_SURFACE;
        if (lvlDef.multiVehicle) {
            // Track flag-slot index per side so each vehicle's finish X lines
            // up with its own flag (mirrors the nextR/nextL stepping in
            // drawFlags). Without this every vehicle stops at slot-0's flag
            // and the lineup looks wrong on multi-flag levels.
            let nextRSlot = 0, nextLSlot = 0;
            const FLAG_STEP = 70;        // must match drawFlags spacing
            state.vehicles = lvlDef.multiVehicle.map((mv, i) => {
                const base = VEHICLES[mv.vType];
                const cfg = { ...base, color: mv.color || base.color, name: mv.label };
                const dir = mv.dir || 1;                       // +1 right, −1 left
                const startSide = mv.startSide || (dir < 0 ? "R" : "L");
                const goalSide  = mv.goalSide  || (dir < 0 ? "L" : "R");
                const offset = mv.startXOffset ?? (startSide === "R" ?  55 : -55);
                const spawnX = startSide === "R" ? rX + offset : lX + offset;
                const spawnY = (startSide === "R" ? surfaceRight : surfaceLeft) - base.h * 0.5;
                let finishX;
                if (goalSide === "L") {
                    finishX = lX - FLAG_INLAND_L - nextLSlot * FLAG_STEP - 8;
                    nextLSlot++;
                } else {
                    finishX = rX + FLAG_INLAND_R + nextRSlot * FLAG_STEP + 8;
                    nextRSlot++;
                }
                return {
                    cfg, x: spawnX, y: spawnY,
                    active: true, finished: false,
                    vy: 0, vx: dir * base.speed,
                    angle: 0, angVel: 0, wheelAngle: 0,
                    label: mv.label,
                    _dir: dir,
                    _goalSide: goalSide,
                    _finishX: finishX,
                    _waitFor: typeof mv.startAfter === "number" ? mv.startAfter : null,
                    _passOnly: !!mv.passOnly,    // drives past flag, finishes off-screen
                    _passedFlag: false,
                    // Convoy follow — index of the leader to stay behind, plus
                    // minimum gap (world units) between leader and this car.
                    _followBehind: typeof mv.followBehind === "number" ? mv.followBehind : null,
                    _followGap:    mv.followGap ?? 30,
                };
            });
        } else {
            const vcfg = VEHICLES[lvl.vType];
            state.vehicles = [{
                cfg: vcfg, x: lX + (lvlDef.vStartXOffset ?? -55),
                y: surfaceLeft - vcfg.h * 0.5,
                active: true, finished: false,
                vy: 0, vx: vcfg.speed, angle: 0, angVel: 0, wheelAngle: 0, label: null,
                _dir: 1, _goalSide: "R", _waitFor: null,
            }];
        }
    }

    function resetToBuild() {
        destroyPhysicsWorld(state);
        state.mode = "build";
        state.simTime = 0;
        state.shakeMag = 0;
        state.finished = false;
        state.finishCalled = false;
        state.modal = null;
        state.nodes.forEach(n => { n.reset(); n._splashed = false; });
        state.members.forEach(m => { m.broken = false; m.sparkDone = false; m.stress = 0; m._breakStress = 0; m._fatigue = 0; });
        state.particles = [];
        state.splashes = [];
        state.snapEvents = [];
        state.snapPopups = [];
        state.snapConfetti = [];
        initVehicles();
        rerollLabelColors();
    }

    // Pick a fresh random color (from the SNAP / FINISH palette) for each
    // floating car-label letter and for every character of every flag's
    // FINISH text. Called on scene start AND on every reset so the colors
    // shuffle each play attempt — the user wanted them random per play
    // instead of cycling through the palette at runtime. SNAP_COLORS lives
    // further down the scene file so we read it lazily via the closure.
    function rerollLabelColors() {
        const palette = SNAP_COLORS;
        const pick = () => palette[Math.floor(Math.random() * palette.length)];
        // Car letter color = the vehicle's own paint color (from VEHICLES).
        // Floating letter above the car and the matching letter on the flag
        // both pull from this list, so the pairing reads at a glance.
        state._carLabelColors = state.vehicles.map(v => v.label ? v.cfg.color : null);
        // Per-letter colors for the word "FINISH" on each flag — still random
        // each play, drawn from the SNAP palette.
        const slots = lvlDef.multiVehicle || [{ label: null }];
        state._flagTextColors = slots.map(() => Array.from("FINISH", () => pick()));
    }

    initVehicles();
    rerollLabelColors();

    // ─── Notify portal assistant of level start ─────
    onLevelStart(
        `level-${lvlDef.id}`,
        (lvlDef.concept || "structural_engineering").toLowerCase().replace(/\s+/g, "_")
    );

    // ─── Pixel art data & helpers ───────────────────
    const ICON_PLAY = [
        [0,0,1,0,0,0,0],
        [0,0,1,1,0,0,0],
        [0,0,1,1,1,0,0],
        [0,0,1,1,1,1,0],
        [0,0,1,1,1,0,0],
        [0,0,1,1,0,0,0],
        [0,0,1,0,0,0,0],
    ];
    const ICON_STOP = [
        [0,0,0,0,0,0,0],
        [0,1,1,1,1,1,0],
        [0,1,1,1,1,1,0],
        [0,1,1,1,1,1,0],
        [0,1,1,1,1,1,0],
        [0,1,1,1,1,1,0],
        [0,0,0,0,0,0,0],
    ];
    const ICON_DELETE = [
        [1,0,0,0,0,0,1],
        [1,1,0,0,0,1,1],
        [0,1,1,0,1,1,0],
        [0,0,1,1,1,0,0],
        [0,1,1,0,1,1,0],
        [1,1,0,0,0,1,1],
        [1,0,0,0,0,0,1],
    ];
    // Line fill icon: two endpoint dots with dashed connector
    const ICON_LINE = [
        [0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0],
        [1,1,0,0,0,1,1],
        [1,1,1,1,1,1,1],
        [1,1,0,0,0,1,1],
        [0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0],
    ];
    // Arch icon: bolder arc with anchor feet
    const ICON_ARCH = [
        [0,0,1,1,1,0,0],
        [0,1,1,0,1,1,0],
        [1,1,0,0,0,1,1],
        [1,0,0,0,0,0,1],
        [1,0,0,0,0,0,1],
        [0,0,0,0,0,0,0],
        [1,1,0,0,0,1,1],
    ];
    const ICON_UNDO = [
        [0,0,0,1,1,1,0],
        [0,0,1,0,0,0,1],
        [0,1,0,0,0,0,1],
        [0,1,0,0,0,0,0],
        [0,0,1,0,0,0,0],
        [1,1,1,1,0,0,0],
        [0,1,0,0,0,0,0],
    ];
    const ICON_MENU = [
        [0,0,0,0,0,0,0],
        [1,1,1,1,1,1,1],
        [0,0,0,0,0,0,0],
        [1,1,1,1,1,1,1],
        [0,0,0,0,0,0,0],
        [1,1,1,1,1,1,1],
        [0,0,0,0,0,0,0],
    ];
    // AI icon: robot face (brain alternative)
    const ICON_AI = [
        [0,0,1,0,1,0,0],
        [0,1,1,1,1,1,0],
        [1,1,0,1,0,1,1],
        [1,1,1,1,1,1,1],
        [1,1,0,1,0,1,1],
        [0,1,1,1,1,1,0],
        [0,1,0,0,0,1,0],
    ];
    // Hint icon: lightbulb
    const ICON_HINT = [
        [0,0,1,1,1,0,0],
        [0,1,1,1,1,1,0],
        [0,1,1,1,1,1,0],
        [0,1,1,1,1,1,0],
        [0,0,1,1,1,0,0],
        [0,0,1,1,1,0,0],
        [0,0,0,1,0,0,0],
    ];
    // Speed icon: double right chevrons
    const ICON_SPEED = [
        [0,0,0,0,0,0,0],
        [1,0,0,1,0,0,0],
        [1,1,0,1,1,0,0],
        [0,1,1,0,1,1,0],
        [1,1,0,1,1,0,0],
        [1,0,0,1,0,0,0],
        [0,0,0,0,0,0,0],
    ];

    // Material mini-icons (5x5 pixel art)
    const MAT_ICONS = {
        wood_road: [
            [1,1,1,1,1],
            [1,0,1,0,1],
            [1,1,1,1,1],
            [1,0,1,0,1],
            [1,1,1,1,1],
        ],
        reinforced_road: [
            [1,1,1,1,1],
            [1,0,1,0,1],
            [1,1,0,1,1],
            [1,0,1,0,1],
            [1,1,1,1,1],
        ],
        stone_road: [
            [1,1,0,1,1],
            [1,1,0,1,1],
            [0,0,0,0,0],
            [1,0,1,1,1],
            [1,0,1,1,1],
        ],
        wood_beam: [
            [0,0,1,0,0],
            [0,1,0,1,0],
            [1,0,0,0,1],
            [0,1,0,1,0],
            [0,0,1,0,0],
        ],
        steel: [
            [1,0,0,0,1],
            [1,1,0,1,1],
            [1,1,1,1,1],
            [1,1,0,1,1],
            [1,0,0,0,1],
        ],
        rope: [
            [1,0,0,0,0],
            [0,1,0,0,0],
            [0,1,1,0,0],
            [0,0,0,1,0],
            [0,0,0,0,1],
        ],
        cable: [
            [1,0,0,0,0],
            [0,1,0,0,0],
            [0,0,1,0,0],
            [0,0,0,1,0],
            [0,0,0,0,1],
        ],
    };

    function drawIcon(grid, cx, cy, color, pxSize) {
        const rows = grid.length, cols = grid[0].length;
        const ox = cx - (cols * pxSize) / 2;
        const oy = cy - (rows * pxSize) / 2;
        for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++)
                if (grid[r][c])
                    k.drawRect({ pos: k.vec2(ox + c * pxSize, oy + r * pxSize), width: pxSize + 0.5, height: pxSize + 0.5, color: colorOf(color), anchor: "topleft" });
    }

    // ─── Procedural icons (material-accurate shapes) ──
    // Each takes (cx, cy, color) and draws a small silhouette centered on (cx, cy).
    // They read as miniature versions of what they represent instead of boxes with dots.

    // All material icons are HORIZONTAL and share the same footprint (~28w × 8h)
    // so they read as a consistent row regardless of material type.
    const MAT_ICON_W = 28, MAT_ICON_H = 8;

    function drawPlankIcon(cx, cy, col) {
        const w = MAT_ICON_W, h = MAT_ICON_H;
        k.drawRect({ pos: k.vec2(cx - w/2, cy - h/2), width: w, height: h, color: colorOf(col), anchor: "topleft", radius: 1 });
        k.drawRect({ pos: k.vec2(cx - w/2, cy - h/2), width: w, height: h, fill: false, outline: { width: 1, color: colorOf("#000000") }, anchor: "topleft", opacity: 0.4, radius: 1 });
        // Vertical grain notches
        for (let i = 1; i <= 3; i++) {
            const x = cx - w/2 + i * w / 4;
            k.drawLine({ p1: k.vec2(x, cy - h/2 + 1), p2: k.vec2(x, cy + h/2 - 1), width: 0.8, color: colorOf("#000000"), opacity: 0.28 });
        }
        // Top highlight
        k.drawLine({ p1: k.vec2(cx - w/2 + 1, cy - h/2 + 0.5), p2: k.vec2(cx + w/2 - 1, cy - h/2 + 0.5), width: 0.8, color: colorOf("#ffffff"), opacity: 0.25 });
    }

    function drawReinforcedPlankIcon(cx, cy, col) {
        drawPlankIcon(cx, cy - 2, col);
        // Red reinforcement stripe below the plank
        k.drawRect({ pos: k.vec2(cx - MAT_ICON_W/2, cy + MAT_ICON_H/2 - 1), width: MAT_ICON_W, height: 3, color: colorOf("#cc3333"), anchor: "topleft", radius: 1 });
    }

    // Stone road shares the wood plank's exact silhouette — just rendered in
    // the stone-grey colour. Same shape, recolored = clearly an upgrade.
    function drawStoneIcon(cx, cy, col) {
        drawPlankIcon(cx, cy, col);
    }

    function drawBeamIcon(cx, cy, col) {
        // Horizontal timber with bolt dots at each end
        const w = MAT_ICON_W, h = MAT_ICON_H;
        k.drawRect({ pos: k.vec2(cx - w/2, cy - h/2), width: w, height: h, color: colorOf(col), anchor: "topleft", radius: 1 });
        k.drawRect({ pos: k.vec2(cx - w/2, cy - h/2), width: w, height: h, fill: false, outline: { width: 1, color: colorOf("#000000") }, anchor: "topleft", opacity: 0.4, radius: 1 });
        // Bolt dots at each end
        k.drawCircle({ pos: k.vec2(cx - w/2 + 3, cy), radius: 1.4, color: colorOf("#000000"), opacity: 0.55 });
        k.drawCircle({ pos: k.vec2(cx + w/2 - 3, cy), radius: 1.4, color: colorOf("#000000"), opacity: 0.55 });
        // Top highlight
        k.drawLine({ p1: k.vec2(cx - w/2 + 1, cy - h/2 + 0.5), p2: k.vec2(cx + w/2 - 1, cy - h/2 + 0.5), width: 0.8, color: colorOf("#ffffff"), opacity: 0.3 });
    }

    // Steel beam shares the wood beam's silhouette — just rendered in the
    // steel-red colour. Same shape, recolored = clearly an upgrade.
    function drawSteelIcon(cx, cy, col) {
        drawBeamIcon(cx, cy, col);
    }

    function drawRopeIcon(cx, cy, col) {
        const hw = MAT_ICON_W / 2;
        // Outline (same width ratio as cable)
        k.drawLine({ p1: k.vec2(cx - hw, cy), p2: k.vec2(cx + hw, cy), width: 4, color: colorOf("#000000"), opacity: 0.28 });
        // Rope body — one tick thicker than cable
        k.drawLine({ p1: k.vec2(cx - hw, cy), p2: k.vec2(cx + hw, cy), width: 2.8, color: colorOf(col) });
        // Tight braid marks — stay inside the line width so nothing sticks out
        for (let i = 1; i <= 6; i++) {
            const xc = cx - hw + MAT_ICON_W * i / 7;
            k.drawLine({ p1: k.vec2(xc - 1, cy - 1), p2: k.vec2(xc + 1, cy + 1), width: 0.8, color: colorOf("#000000"), opacity: 0.28 });
        }
        // Nubs — same size as cable
        k.drawCircle({ pos: k.vec2(cx - hw, cy), radius: 2.6, color: colorOf("#000000"), opacity: 0.28 });
        k.drawCircle({ pos: k.vec2(cx - hw, cy), radius: 1.8, color: colorOf(col) });
        k.drawCircle({ pos: k.vec2(cx + hw, cy), radius: 2.6, color: colorOf("#000000"), opacity: 0.28 });
        k.drawCircle({ pos: k.vec2(cx + hw, cy), radius: 1.8, color: colorOf(col) });
    }

    function drawCableIcon(cx, cy, col) {
        const hw = MAT_ICON_W / 2;
        // Outline
        k.drawLine({ p1: k.vec2(cx - hw, cy), p2: k.vec2(cx + hw, cy), width: 3.6, color: colorOf("#000000"), opacity: 0.28 });
        // Cable body
        k.drawLine({ p1: k.vec2(cx - hw, cy), p2: k.vec2(cx + hw, cy), width: 2.2, color: colorOf(col) });
        // Highlight
        k.drawLine({ p1: k.vec2(cx - hw + 1, cy - 0.7), p2: k.vec2(cx + hw - 1, cy - 0.7), width: 0.7, color: colorOf("#ffffff"), opacity: 0.32 });
        // Nubs
        k.drawCircle({ pos: k.vec2(cx - hw, cy), radius: 2.6, color: colorOf("#000000"), opacity: 0.28 });
        k.drawCircle({ pos: k.vec2(cx - hw, cy), radius: 1.8, color: colorOf(col) });
        k.drawCircle({ pos: k.vec2(cx + hw, cy), radius: 2.6, color: colorOf("#000000"), opacity: 0.28 });
        k.drawCircle({ pos: k.vec2(cx + hw, cy), radius: 1.8, color: colorOf(col) });
    }

    // ─── Tool icons (procedural, non-pixelated, generously sized) ──
    function drawLineToolIcon(cx, cy, col) {
        // o—o—o : three connector dots with line segments between them.
        // Tightened spread so its silhouette matches the other tool icons.
        const positions = [cx - 13, cx, cx + 13];
        const lw = 3;
        k.drawLine({ p1: k.vec2(positions[0] + 4, cy), p2: k.vec2(positions[1] - 4, cy), width: lw, color: colorOf(col) });
        k.drawLine({ p1: k.vec2(positions[1] + 4, cy), p2: k.vec2(positions[2] - 4, cy), width: lw, color: colorOf(col) });
        for (const px of positions) {
            k.drawCircle({ pos: k.vec2(px, cy), radius: 3.6, color: colorOf(col) });
        }
    }

    function drawArchToolIcon(cx, cy, col) {
        const r = 13;
        const segs = 32;               // more segments → smoother curve
        const baseY = cy + 6;
        const lw = 3.2;
        let prev = null;
        for (let i = 0; i <= segs; i++) {
            const angle = Math.PI - (i / segs) * Math.PI;
            const x = cx + Math.cos(angle) * r;
            const y = baseY - Math.sin(angle) * r;
            if (prev) k.drawLine({ p1: prev, p2: k.vec2(x, y), width: lw, color: colorOf(col) });
            // Round cap at each vertex so the curve doesn't show gaps
            k.drawCircle({ pos: k.vec2(x, y), radius: lw / 2, color: colorOf(col) });
            prev = k.vec2(x, y);
        }
        k.drawCircle({ pos: k.vec2(cx - r, baseY), radius: 3.8, color: colorOf(col) });
        k.drawCircle({ pos: k.vec2(cx + r, baseY), radius: 3.8, color: colorOf(col) });
    }

    // Delete icon — bigger trash can, same line-art style as the other tools.
    function drawXIcon(cx, cy, col) {
        const c = colorOf(col);
        const lw = 3;
        const w = 18, h = 20;
        const top = cy - h / 2 + 2;
        const bot = cy + h / 2;
        // Lid — wider than the body
        k.drawLine({ p1: k.vec2(cx - w / 2 - 2, top), p2: k.vec2(cx + w / 2 + 2, top), width: lw, color: c });
        // Handle notch above the lid
        k.drawLine({ p1: k.vec2(cx - 4, top - 4), p2: k.vec2(cx + 4, top - 4), width: lw, color: c });
        k.drawLine({ p1: k.vec2(cx - 4, top - 4), p2: k.vec2(cx - 4, top),     width: lw, color: c });
        k.drawLine({ p1: k.vec2(cx + 4, top - 4), p2: k.vec2(cx + 4, top),     width: lw, color: c });
        // Body — slightly tapered toward the bottom
        k.drawLine({ p1: k.vec2(cx - w / 2 + 1, top + 1), p2: k.vec2(cx - w / 2 + 2, bot), width: lw, color: c });
        k.drawLine({ p1: k.vec2(cx + w / 2 - 1, top + 1), p2: k.vec2(cx + w / 2 - 2, bot), width: lw, color: c });
        // Bottom edge
        k.drawLine({ p1: k.vec2(cx - w / 2 + 2, bot), p2: k.vec2(cx + w / 2 - 2, bot), width: lw, color: c });
        // Three vertical ridges inside
        const ridgeTop = top + 5, ridgeBot = bot - 2;
        k.drawLine({ p1: k.vec2(cx - 4, ridgeTop), p2: k.vec2(cx - 4, ridgeBot), width: 1.8, color: c });
        k.drawLine({ p1: k.vec2(cx,     ridgeTop), p2: k.vec2(cx,     ridgeBot), width: 1.8, color: c });
        k.drawLine({ p1: k.vec2(cx + 4, ridgeTop), p2: k.vec2(cx + 4, ridgeBot), width: 1.8, color: c });
    }

    // Select tool icon — classic pointer cursor, drawn as a single polygon.
    // Vertices trace the outline clockwise from the tip. Kaplay handles the
    // triangulation internally.
    function drawSelectToolIcon(cx, cy, col) {
        const c = colorOf(col);
        const ox = cx - 10, oy = cy - 12;
        k.drawPolygon({
            pts: [
                k.vec2(ox + 0,  oy + 0),    // tip
                k.vec2(ox + 18, oy + 15),   // right extent (arrowhead corner)
                k.vec2(ox + 11, oy + 16),   // notch outer (where tail meets arrowhead)
                k.vec2(ox + 17, oy + 24),   // tail bottom-right
                k.vec2(ox + 12, oy + 24),   // tail bottom-left
                k.vec2(ox + 7,  oy + 17),   // notch inner
                k.vec2(ox + 3,  oy + 21),   // body foot (pointy bottom-left)
            ],
            color: c,
        });
    }

    // Generic "arrow that follows a circular arc" helper. Draws a thick arc from
    // aStart → aEnd (CCW if aEnd > aStart, CW otherwise) and places a tangent-
    // aligned triangular arrowhead at the end so the tip "continues" the curve.
    function drawCurvedArrow(cx, cy, r, aStart, aEnd, col, lw, flipY = false) {
        const ys = flipY ? 1 : -1;
        const sign = Math.sign(aEnd - aStart);
        const segs = Math.max(24, Math.ceil(40 * Math.abs(aEnd - aStart) / (2 * Math.PI)));
        let prev = null;
        for (let i = 0; i <= segs; i++) {
            const t = i / segs;
            const a = aStart + t * (aEnd - aStart);
            const x = cx + Math.cos(a) * r;
            const y = cy + ys * Math.sin(a) * r;
            if (prev) k.drawLine({ p1: prev, p2: k.vec2(x, y), width: lw, color: colorOf(col) });
            // Round cap at vertex — fills tiny gaps between line segments.
            k.drawCircle({ pos: k.vec2(x, y), radius: lw / 2, color: colorOf(col) });
            prev = k.vec2(x, y);
        }
        // Arrowhead at aEnd — tip points along the tangent direction of motion.
        const a = aEnd;
        const ex = cx + Math.cos(a) * r;
        const ey = cy + ys * Math.sin(a) * r;
        const ux = -Math.sin(a) * sign;
        const uy = ys * Math.cos(a) * sign;
        const px = -uy, py = ux;        // perpendicular (width axis)
        const headLen = 9;
        const headW   = 6;
        k.drawTriangle({
            p1: k.vec2(ex + ux * headLen, ey + uy * headLen),           // tip
            p2: k.vec2(ex + px * headW,   ey + py * headW),             // left back
            p3: k.vec2(ex - px * headW,   ey - py * headW),             // right back
            color: colorOf(col),
        });
    }

    function drawUndoIcon(cx, cy, col) {
        // CW 270° arc, gap on the LEFT. Arrow ends near 7–8 o'clock pointing
        // up-left — reads as "go back".
        drawCurvedArrow(cx, cy, 10, 3 * Math.PI / 4, 3 * Math.PI / 4 - 3 * Math.PI / 2, col, 3.5, true);
    }

    function drawRedoIcon(cx, cy, col) {
        // CCW 270° arc, gap on the RIGHT. Arrow ends near 4–5 o'clock pointing
        // up-right — reads as "go forward".
        drawCurvedArrow(cx, cy, 10, Math.PI / 4, Math.PI / 4 + 3 * Math.PI / 2, col, 3.5, true);
    }

    // Double chevron pointing RIGHT — two thin line pairs forming ">>". The
    // previous open-chevron look the user liked.
    function drawSpeedUpIcon(cx, cy, col) {
        const s = 8, gap = 4, lw = 3;
        const c = colorOf(col);
        // First (inner) chevron
        const p1tip = k.vec2(cx - gap / 2, cy);
        k.drawLine({ p1: k.vec2(cx - s - gap / 2, cy - s), p2: p1tip, width: lw, color: c });
        k.drawLine({ p1: p1tip, p2: k.vec2(cx - s - gap / 2, cy + s), width: lw, color: c });
        // Second (outer) chevron
        const p2tip = k.vec2(cx + s + gap / 2, cy);
        k.drawLine({ p1: k.vec2(cx + gap / 2, cy - s), p2: p2tip, width: lw, color: c });
        k.drawLine({ p1: p2tip, p2: k.vec2(cx + gap / 2, cy + s), width: lw, color: c });
    }

    // Mirror — "<<".
    function drawSpeedDownIcon(cx, cy, col) {
        const s = 8, gap = 4, lw = 3;
        const c = colorOf(col);
        // First (inner) chevron
        const p1tip = k.vec2(cx + gap / 2, cy);
        k.drawLine({ p1: k.vec2(cx + s + gap / 2, cy - s), p2: p1tip, width: lw, color: c });
        k.drawLine({ p1: p1tip, p2: k.vec2(cx + s + gap / 2, cy + s), width: lw, color: c });
        // Second (outer) chevron
        const p2tip = k.vec2(cx - s - gap / 2, cy);
        k.drawLine({ p1: k.vec2(cx - gap / 2, cy - s), p2: p2tip, width: lw, color: c });
        k.drawLine({ p1: p2tip, p2: k.vec2(cx - gap / 2, cy + s), width: lw, color: c });
    }

    // ─── Tiny 3×5 pixel font for inline readouts (speed, etc.) ──
    // Hand-drawn so the glyphs sit consistently next to the other pixel icons
    // instead of using a TTF font that visually "floats".
    const PIXEL_FONT = {
        "0": [[1,1,1],[1,0,1],[1,0,1],[1,0,1],[1,1,1]],
        "1": [[0,1,0],[1,1,0],[0,1,0],[0,1,0],[1,1,1]],
        "2": [[1,1,1],[0,0,1],[1,1,1],[1,0,0],[1,1,1]],
        "3": [[1,1,1],[0,0,1],[0,1,1],[0,0,1],[1,1,1]],
        "4": [[1,0,1],[1,0,1],[1,1,1],[0,0,1],[0,0,1]],
        "5": [[1,1,1],[1,0,0],[1,1,1],[0,0,1],[1,1,1]],
        "6": [[1,1,1],[1,0,0],[1,1,1],[1,0,1],[1,1,1]],
        "7": [[1,1,1],[0,0,1],[0,1,0],[1,0,0],[1,0,0]],
        "8": [[1,1,1],[1,0,1],[1,1,1],[1,0,1],[1,1,1]],
        "9": [[1,1,1],[1,0,1],[1,1,1],[0,0,1],[1,1,1]],
        ".": [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,1,0]],
        "x": [[0,0,0],[1,0,1],[0,1,0],[1,0,1],[0,0,0]],
    };

    function drawPixelText(text, cx, cy, col, pxSize = 2) {
        const charW = 3, charH = 5, charGap = 1;
        const totalW = text.length * charW * pxSize + (text.length - 1) * charGap * pxSize;
        let x = cx - totalW / 2;
        const y = cy - (charH * pxSize) / 2;
        const c = colorOf(col);
        for (const ch of text) {
            const grid = PIXEL_FONT[ch];
            if (grid) {
                for (let r = 0; r < charH; r++) {
                    for (let cc = 0; cc < charW; cc++) {
                        if (grid[r][cc]) {
                            k.drawRect({
                                pos: k.vec2(x + cc * pxSize, y + r * pxSize),
                                width: pxSize + 0.5,
                                height: pxSize + 0.5,
                                color: c,
                                anchor: "topleft",
                            });
                        }
                    }
                }
            }
            x += (charW + charGap) * pxSize;
        }
    }

    // Back-compat alias while old call sites catch up.
    const drawSpeedIcon = drawSpeedUpIcon;

    function drawMenuIcon(cx, cy, col) {
        const w = 20, lw = 3, rowGap = 7;
        for (let i = -1; i <= 1; i++) {
            k.drawLine({ p1: k.vec2(cx - w/2, cy + i * rowGap), p2: k.vec2(cx + w/2, cy + i * rowGap), width: lw, color: colorOf(col) });
        }
    }

    // ─── Sidebar toggle icons ─────────────────────────
    // Drawn in the same line-art language as the toolbar tools (single color
    // silhouettes so the active outline pass in drawToolIconBtn reads cleanly).
    // Sized for the larger signpost plates so they read at a glance — bumped
    // ~1.4× from the toolbar tools' default scale.
    function drawGridIcon(cx, cy, col) {
        const c = colorOf(col);
        const half = 11;
        const lw = 1.9;
        // 3×3 grid: 4 horizontals + 4 verticals
        for (let i = 0; i <= 3; i++) {
            const t = -half + (i / 3) * (half * 2);
            k.drawLine({ p1: k.vec2(cx - half, cy + t), p2: k.vec2(cx + half, cy + t), width: lw, color: c });
            k.drawLine({ p1: k.vec2(cx + t, cy - half), p2: k.vec2(cx + t, cy + half), width: lw, color: c });
        }
    }

    // Snap icon: a clean, solid padlock. No grid behind — the lock alone
    // reads as "snap is locked", and the active outline reinforces state.
    function drawSnapIcon(cx, cy, col) {
        const c = colorOf(col);
        const bodyW = 18, bodyH = 14;
        const bodyTop = cy - 2;
        k.drawRect({
            pos: k.vec2(cx - bodyW / 2, bodyTop),
            width: bodyW, height: bodyH,
            color: c, anchor: "topleft", radius: 2,
        });
        const shackleR = 6;
        const shackleY = bodyTop;
        const lw = 2.5;
        let prev = null;
        const segs = 22;
        for (let i = 0; i <= segs; i++) {
            const a = Math.PI + (i / segs) * Math.PI;
            const x = cx + Math.cos(a) * shackleR;
            const y = shackleY + Math.sin(a) * shackleR;
            if (prev) k.drawLine({ p1: prev, p2: k.vec2(x, y), width: lw, color: c });
            k.drawCircle({ pos: k.vec2(x, y), radius: lw / 2, color: c });
            prev = k.vec2(x, y);
        }
        const khColor = colorOf("#3a2110");
        k.drawCircle({ pos: k.vec2(cx, bodyTop + 5), radius: 1.6, color: khColor });
        k.drawRect({ pos: k.vec2(cx - 0.8, bodyTop + 6), width: 1.6, height: 4, color: khColor, anchor: "topleft" });
    }

    // Stress icon: classic trapezoidal weight with a circular ring loop on
    // top — same silhouette as the standard "weight" pictogram (no KG text).
    // Reads as "this is a weight / load." Sized to match the grid icon's
    // visual weight so the three sidebar icons read at the same scale.
    function drawStressIcon(cx, cy, col) {
        const c = colorOf(col);
        const topW = 14;
        const botW = 22;
        const bodyTop = cy - 1;
        const bodyBot = cy + 12;
        k.drawPolygon({
            pts: [
                k.vec2(cx - topW / 2, bodyTop),
                k.vec2(cx + topW / 2, bodyTop),
                k.vec2(cx + botW / 2, bodyBot),
                k.vec2(cx - botW / 2, bodyBot),
            ],
            color: c,
        });
        const loopR = 5.2;
        const loopCy = bodyTop - loopR + 2.6;
        k.drawCircle({
            pos: k.vec2(cx, loopCy), radius: loopR,
            fill: false, outline: { width: 2.4, color: c },
        });
    }

    function drawPlayIcon(cx, cy, col) {
        const s = 11;
        k.drawTriangle({
            p1: k.vec2(cx - s * 0.7, cy - s),
            p2: k.vec2(cx + s,        cy),
            p3: k.vec2(cx - s * 0.7, cy + s),
            color: colorOf(col),
        });
    }

    function drawStopIcon(cx, cy, col) {
        const s = 17;
        k.drawRect({ pos: k.vec2(cx - s/2, cy - s/2), width: s, height: s, color: colorOf(col), anchor: "topleft", radius: 1.5 });
    }

    // Right-pointing arrow — clearer "next level" affordance than the
    // play-button triangle. Solid shaft + chunky arrowhead with rounded
    // joints so it reads at icon scale.
    function drawNextArrow(cx, cy, col) {
        const c = colorOf(col);
        const lw = 3.4;
        // Shaft
        k.drawLine({
            p1: k.vec2(cx - 9, cy),
            p2: k.vec2(cx + 7, cy),
            width: lw, color: c,
        });
        // Arrowhead — two diagonals meeting at the tip.
        k.drawLine({
            p1: k.vec2(cx + 1, cy - 7),
            p2: k.vec2(cx + 9, cy),
            width: lw, color: c,
        });
        k.drawLine({
            p1: k.vec2(cx + 1, cy + 7),
            p2: k.vec2(cx + 9, cy),
            width: lw, color: c,
        });
        // Round caps so the joins read clean.
        k.drawCircle({ pos: k.vec2(cx + 9, cy), radius: lw / 2, color: c });
        k.drawCircle({ pos: k.vec2(cx - 9, cy), radius: lw / 2, color: c });
    }

    // Bare (no-background) icon button — just draws the icon centered in the rect,
    // with optional text to the right. Hitbox is still the full rect.
    function drawFlatIconBtn(rect, drawFn, color, text) {
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        if (drawFn && text) {
            drawFn(cx - 10, cy, color);
            k.drawText({ text, pos: k.vec2(cx + 6, cy - 4), size: 7, font: "PressStart2P", color: colorOf(color) });
        } else if (drawFn) {
            drawFn(cx, cy, color);
        } else if (text) {
            k.drawText({ text, pos: k.vec2(cx, cy), size: 8, font: "PressStart2P", color: colorOf(color), anchor: "center" });
        }
    }

    // Tool icon button with hover zoom + silhouette outline when active. Same
    // selection animation as the material icons. Outline color is customizable
    // so play/stop can use green/red while other tools stay brown.
    //   outerOutlineCol: optional thin grey (or any) edge drawn FURTHER out than
    //                    the main colored outline — makes the colored outline
    //                    "pop" with a drop-shadow feel.
    function drawToolIconBtn(rect, drawFn, active, key, outlineCol = "#5a3418", outerOutlineCol = null) {
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        const mpos = k.mousePos();
        const dt = k.dt() || 1 / 60;
        const hovered = mpos.x >= rect.x && mpos.x <= rect.x + rect.w
                     && mpos.y >= rect.y && mpos.y <= rect.y + rect.h;
        const prev = state.toolHover[key] || 0;
        state.toolHover[key] = hovered
            ? Math.min(1, prev + dt * 10)
            : Math.max(0, prev - dt * 12);
        const h = state.toolHover[key];

        const scale = (active ? 1.12 : 1) * (1 + h * 0.14);
        k.pushTransform();
        k.pushTranslate(cx, cy);
        k.pushScale(scale, scale);

        if (active) {
            // Outer edge (optional) — thin grey band of edge color beyond the main outline.
            if (outerOutlineCol) {
                const outerR = 4.2;
                for (let a = 0; a < 16; a++) {
                    const rad = (a * Math.PI) / 8;
                    k.pushTransform();
                    k.pushTranslate(Math.cos(rad) * outerR, Math.sin(rad) * outerR);
                    drawFn(0, 0, outerOutlineCol);
                    k.popTransform();
                }
            }
            // Main colored outline — thicker when layered with an outer edge.
            const innerR = outerOutlineCol ? 3.2 : 1.6;
            const rays = outerOutlineCol ? 16 : 8;
            for (let a = 0; a < rays; a++) {
                const rad = (a * Math.PI * 2) / rays;
                k.pushTransform();
                k.pushTranslate(Math.cos(rad) * innerR, Math.sin(rad) * innerR);
                drawFn(0, 0, outlineCol);
                k.popTransform();
            }
        }
        drawFn(0, 0, "#fff8e0");
        k.popTransform();
    }

    // AI + Hint icon buttons. Drawn ON a wooden plate that hangs off the
    // bottom of the toolbar so the cream icons read against brown wood — the
    // same visual language as the toolbar tools above. Hover scales them up,
    // active brightens the wood + cream-outlines the icon for a "pressed in"
    // feel matching drawToolIconBtn's active treatment.
    function drawPaperIconBtn(rect, drawFn, active, key) {
        const mpos = k.mousePos();
        const dt = k.dt() || 1 / 60;
        const hovered = mpos.x >= rect.x && mpos.x <= rect.x + rect.w
                     && mpos.y >= rect.y && mpos.y <= rect.y + rect.h;
        const prev = state.toolHover[key] || 0;
        state.toolHover[key] = hovered
            ? Math.min(1, prev + dt * 10)
            : Math.max(0, prev - dt * 12);
        const h = state.toolHover[key];

        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        const scale = (active ? 1.12 : 1) * (1 + h * 0.14);

        k.pushTransform();
        k.pushTranslate(cx, cy);
        k.pushScale(scale, scale);

        // Active state — silhouette outline ring in brown, then the cream icon
        // on top. Same pattern drawToolIconBtn uses for the toolbar tools.
        if (active) {
            const innerR = 1.6;
            for (let a = 0; a < 8; a++) {
                const rad = (a * Math.PI * 2) / 8;
                k.pushTransform();
                k.pushTranslate(Math.cos(rad) * innerR, Math.sin(rad) * innerR);
                drawFn(0, 0, "#5a3418");
                k.popTransform();
            }
        }
        drawFn(0, 0, "#fff8e0");
        k.popTransform();
    }

    // The AI + Hint cluster renders as a hanging wooden sign suspended from
    // two ropes. The whole group sways gently around the rope attachment
    // points so it feels like a real shop sign in the breeze.
    function drawHangingAiHintSign(tb) {
        const ai = tb.aiBtn, hint = tb.hintBtn;

        // Swing angle in degrees — slower sine wave with a bigger amplitude
        // so the ropes visibly tilt during the sway. Click hit-testing on the
        // static rects is still close enough at these angles.
        const swing = Math.sin(k.time() * 0.9) * 3.5;

        // Sign geometry
        const padX = 6, padY = 4;
        const sx = ai.x - padX;
        const sy = ai.y - padY;
        const sw = (hint.x + hint.w) - ai.x + padX * 2;
        const sh = ai.h + padY * 2;

        // Rope endpoints — TOP and BOT share the same X so the ropes hang
        // perfectly vertically at rest. They only angle when the sign swings.
        const toolbarBot = tb.h + tb.pad;
        const ropeInset = 16;
        const ropeTopL = { x: sx + ropeInset,       y: toolbarBot };
        const ropeTopR = { x: sx + sw - ropeInset,  y: toolbarBot };
        const ropeBotL = { x: sx + ropeInset,       y: sy };
        const ropeBotR = { x: sx + sw - ropeInset,  y: sy };

        // Pivot — midpoint of the two rope tops. Sign rotates around this.
        const pivotX = (ropeTopL.x + ropeTopR.x) / 2;
        const pivotY = toolbarBot;

        // Rotate a point around the pivot by `swing` degrees.
        const swingRad = swing * Math.PI / 180;
        const cos = Math.cos(swingRad), sin = Math.sin(swingRad);
        const rotPt = (p) => {
            const dx = p.x - pivotX, dy = p.y - pivotY;
            return { x: pivotX + dx * cos - dy * sin, y: pivotY + dx * sin + dy * cos };
        };
        const swungBotL = rotPt(ropeBotL);
        const swungBotR = rotPt(ropeBotR);

        // ── Ropes (top static, bottom rotates with the sign) ──
        const drawRopeLine = (top, bot) => {
            k.drawLine({ p1: k.vec2(top.x, top.y), p2: k.vec2(bot.x, bot.y), width: 3,   color: colorOf("#4a2810") });
            k.drawLine({ p1: k.vec2(top.x, top.y), p2: k.vec2(bot.x, bot.y), width: 1.5, color: colorOf("#a87838") });
        };
        drawRopeLine(ropeTopL, swungBotL);
        drawRopeLine(ropeTopR, swungBotR);

        // ── Sign + icons (rotated as one unit around the rope pivot) ──
        k.pushTransform();
        k.pushTranslate(pivotX, pivotY);
        k.pushRotate(swing);
        k.pushTranslate(-pivotX, -pivotY);

        // Drop shadow
        k.drawRect({ pos: k.vec2(sx + 1, sy + 3), width: sw, height: sh, color: colorOf("#010101"), opacity: 0.32, anchor: "topleft", radius: 4 });
        // Wooden body
        k.drawRect({ pos: k.vec2(sx, sy), width: sw, height: sh, color: colorOf("#d37e3d"), anchor: "topleft", radius: 4 });
        // Wood grain — horizontal streaks for "sign" feel (vs vertical toolbar grain)
        for (let gy = 4; gy < sh - 4; gy += 5) {
            k.drawLine({
                p1: k.vec2(sx + 4, sy + gy),
                p2: k.vec2(sx + sw - 4, sy + gy + 1),
                width: 0.6, color: colorOf("#8e4924"), opacity: 0.18,
            });
        }
        // Top highlight
        k.drawRect({ pos: k.vec2(sx, sy), width: sw, height: 1, color: colorOf("#ffffff"), opacity: 0.22, anchor: "topleft" });
        // Bottom edge
        k.drawRect({ pos: k.vec2(sx, sy + sh - 3), width: sw, height: 3, color: colorOf("#8e4924"), anchor: "topleft" });
        // Outline
        k.drawRect({
            pos: k.vec2(sx, sy), width: sw, height: sh,
            fill: false, outline: { width: 1, color: colorOf("#3a2110") },
            anchor: "topleft", radius: 4, opacity: 0.45,
        });
        // (No hardware — the rope just terminates at the wood. Cleaner read.)

        // Buttons — rendered inside the rotation so they swing with the sign
        drawPaperIconBtn(tb.aiBtn,   drawRobotIcon,    state.aiPanelOpen, "ai");
        drawPaperIconBtn(tb.hintBtn, drawQuestionIcon, state.hintOpen,    "hint");

        k.popTransform();
    }

    function drawMatIconFor(key, cx, cy, col) {
        switch (key) {
            case "wood_road":       return drawPlankIcon(cx, cy, col);
            case "reinforced_road": return drawReinforcedPlankIcon(cx, cy, col);
            case "stone_road":      return drawStoneIcon(cx, cy, col);
            case "wood_beam":       return drawBeamIcon(cx, cy, col);
            case "steel":           return drawSteelIcon(cx, cy, col);
            case "rope":            return drawRopeIcon(cx, cy, col);
            case "cable":           return drawCableIcon(cx, cy, col);
            default: {
                const g = MAT_ICONS[key];
                if (g) drawIcon(g, cx, cy, col, 2);
            }
        }
    }

    // ─── Silhouette outline renderers — draw the icon's SHAPE inflated by `inf`
    // pixels in the given color. Called BEFORE the main icon to produce a proper
    // stroke-around effect that hugs the silhouette instead of a rectangle.
    function drawPlankOutline(cx, cy, col, inf) {
        const w = MAT_ICON_W + inf * 2;
        const h = MAT_ICON_H + inf * 2;
        k.drawRect({ pos: k.vec2(cx - w/2, cy - h/2), width: w, height: h, color: colorOf(col), anchor: "topleft", radius: 1 + inf });
    }
    function drawBeamOutline(cx, cy, col, inf) {
        const w = MAT_ICON_W + inf * 2;
        const h = MAT_ICON_H + inf * 2;
        k.drawRect({ pos: k.vec2(cx - w/2, cy - h/2), width: w, height: h, color: colorOf(col), anchor: "topleft", radius: 1 + inf });
    }
    function drawReinforcedOutline(cx, cy, col, inf) {
        // Plank body + red stripe bundled into one silhouette
        const w = MAT_ICON_W + inf * 2;
        const topY = cy - 2 - MAT_ICON_H/2 - inf;
        const botY = cy + MAT_ICON_H/2 + 2 + inf;   // red stripe base +2 thickness
        const h = botY - topY;
        k.drawRect({ pos: k.vec2(cx - w/2, topY), width: w, height: h, color: colorOf(col), anchor: "topleft", radius: 1 + inf });
    }
    function drawStoneOutline(cx, cy, col, inf) {
        // Tight rect hugging the whole brick course
        const w = MAT_ICON_W + inf * 2;
        const h = MAT_ICON_H + inf * 2;
        k.drawRect({ pos: k.vec2(cx - w/2, cy - h/2), width: w, height: h, color: colorOf(col), anchor: "topleft", radius: inf });
    }
    function drawSteelOutline(cx, cy, col, inf) {
        // Same silhouette as the wood beam (single rectangle), just inflated.
        const w = MAT_ICON_W + inf * 2;
        const h = MAT_ICON_H + inf * 2;
        k.drawRect({ pos: k.vec2(cx - w/2, cy - h/2), width: w, height: h, color: colorOf(col), anchor: "topleft", radius: 1 + inf });
    }
    function drawRopeOutline(cx, cy, col, inf) {
        const hw = MAT_ICON_W / 2;
        const lw = 2.8 + inf * 2;
        k.drawLine({ p1: k.vec2(cx - hw, cy), p2: k.vec2(cx + hw, cy), width: lw, color: colorOf(col) });
        k.drawCircle({ pos: k.vec2(cx - hw, cy), radius: 1.8 + inf, color: colorOf(col) });
        k.drawCircle({ pos: k.vec2(cx + hw, cy), radius: 1.8 + inf, color: colorOf(col) });
    }
    function drawCableOutline(cx, cy, col, inf) {
        const lw = 2.2 + inf * 2;
        k.drawLine({ p1: k.vec2(cx - MAT_ICON_W/2, cy), p2: k.vec2(cx + MAT_ICON_W/2, cy), width: lw, color: colorOf(col) });
        k.drawCircle({ pos: k.vec2(cx - MAT_ICON_W/2, cy), radius: 1.8 + inf, color: colorOf(col) });
        k.drawCircle({ pos: k.vec2(cx + MAT_ICON_W/2, cy), radius: 1.8 + inf, color: colorOf(col) });
    }

    function drawMatIconOutlineFor(key, cx, cy, col, inf) {
        switch (key) {
            case "wood_road":       return drawPlankOutline(cx, cy, col, inf);
            case "reinforced_road": return drawReinforcedOutline(cx, cy, col, inf);
            case "stone_road":      return drawStoneOutline(cx, cy, col, inf);
            case "wood_beam":       return drawBeamOutline(cx, cy, col, inf);
            case "steel":           return drawSteelOutline(cx, cy, col, inf);
            case "rope":            return drawRopeOutline(cx, cy, col, inf);
            case "cable":           return drawCableOutline(cx, cy, col, inf);
        }
    }

    function drawRobotIcon(cx, cy, col) {
        const c = colorOf(col);
        // Antenna — stem + knob on top
        k.drawLine({ p1: k.vec2(cx, cy - 15), p2: k.vec2(cx, cy - 10), width: 2, color: c });
        k.drawCircle({ pos: k.vec2(cx, cy - 16), radius: 2.4, color: c });
        // Head — rounded rectangle outline
        const w = 22, h = 18;
        k.drawRect({
            pos: k.vec2(cx - w / 2, cy - h / 2 + 1),
            width: w, height: h,
            fill: false,
            outline: { width: 2.2, color: c },
            anchor: "topleft",
            radius: 4,
        });
        // Side "ear" bolts — add character without clutter
        k.drawCircle({ pos: k.vec2(cx - w / 2 - 1, cy + 3), radius: 1.4, color: c });
        k.drawCircle({ pos: k.vec2(cx + w / 2 + 1, cy + 3), radius: 1.4, color: c });
        // Eyes — two chunky dots
        k.drawCircle({ pos: k.vec2(cx - 4.5, cy - 1), radius: 2, color: c });
        k.drawCircle({ pos: k.vec2(cx + 4.5, cy - 1), radius: 2, color: c });
        // Smile — little U (5 short segments for a slightly rounded curve)
        const my = cy + 5;
        const sw = 1.7;
        const pts = [
            k.vec2(cx - 4,   my),
            k.vec2(cx - 2.4, my + 1.7),
            k.vec2(cx,       my + 2.2),
            k.vec2(cx + 2.4, my + 1.7),
            k.vec2(cx + 4,   my),
        ];
        for (let i = 0; i < pts.length - 1; i++) {
            k.drawLine({ p1: pts[i], p2: pts[i + 1], width: sw, color: c });
            k.drawCircle({ pos: pts[i + 1], radius: sw / 2, color: c });
        }
    }

    // Hand-drawn question mark: top hook (CW arc from upper-left over the top
    // down to lower-right) → diagonal stem to the center → dot below. All strokes
    // in the passed color so the silhouette-outline pass of drawToolIconBtn works.
    function drawQuestionIcon(cx, cy, col) {
        const c = colorOf(col);
        const r = 7;
        const lw = 3;
        const topY = cy - 5;
        const aStart = Math.PI * 3 / 4;   // upper-left
        const aEnd   = -Math.PI / 4;      // lower-right
        const segs = 26;
        let prev = null;
        for (let i = 0; i <= segs; i++) {
            const t = i / segs;
            const a = aStart + t * (aEnd - aStart);
            const x = cx + Math.cos(a) * r;
            const y = topY - Math.sin(a) * r;
            if (prev) k.drawLine({ p1: prev, p2: k.vec2(x, y), width: lw, color: c });
            k.drawCircle({ pos: k.vec2(x, y), radius: lw / 2, color: c });
            prev = k.vec2(x, y);
        }
        // Stem — from arc end diagonally down to center line
        const endX = cx + Math.cos(aEnd) * r;
        const endY = topY - Math.sin(aEnd) * r;
        k.drawLine({ p1: k.vec2(endX, endY), p2: k.vec2(cx, cy + 5), width: lw, color: c });
        k.drawCircle({ pos: k.vec2(cx, cy + 5), radius: lw / 2, color: c });
        // Dot
        k.drawCircle({ pos: k.vec2(cx, cy + 11), radius: 2.2, color: c });
    }



    // ─── Terrain collision rectangles (for physics) ──
    // Tables are solid — nodes bounce off them instead of clipping through
    const TABLE_COL_H = 212; // TABLE_TOP_H(12) + TABLE_DEPTH(200)
    state._terrainColliders = [
        // Left table surface
        { x1: lX - 600, y1: lY, x2: lX, y2: lY + TABLE_COL_H },
        // Right table surface
        { x1: rX, y1: rY, x2: rX + 600, y2: rY + TABLE_COL_H },
    ];
    // Mid-land platform — a solid block vehicles drive across, same height
    // as a cliff approach so wheels read flush with the surface.
    if (state._midLand) {
        const ml = state._midLand;
        state._terrainColliders.push({ x1: ml.x1, y1: ml.y, x2: ml.x2, y2: ml.y + TABLE_COL_H });
    }
    // Mid-gap rock piers — extra solid colliders so a collapsing bridge can
    // actually rest on / slide off the rock instead of clipping through it.
    if (lvlDef.extraAnchors) {
        for (const a of lvlDef.extraAnchors) {
            if (a.side !== "MID") continue;
            const ax = Math.round((lvl.midX + a.dx) / GRID) * GRID;
            const ay = Math.round((lvl.lY + a.dy) / GRID) * GRID;
            state._terrainColliders.push({
                x1: ax - 24, y1: ay - 4,
                x2: ax + 24, y2: ay + 1000,
            });
        }
    }

    // Helper: nodes that the cursor can snap to.
    // Includes fixed anchors AND any existing non-builtin node — so dragging
    // near an off-grid node (e.g. an arch joint) snaps to it exactly instead
    // of rounding to the nearest grid intersection.
    function getAnchors() {
        return state.nodes.filter(n => !n.builtin);
    }

    // ─── Build mode: find or create node ────────────
    function findOrCreate(x, y) {
        const ex = state.nodes.find(n => n.x === x && n.y === y);
        if (ex) return ex;
        const inLWall = x === lX && y > lY && y < lY + TABLE_DEPTH;
        const inRWall = x === rX && y > rY && y < rY + TABLE_DEPTH;
        const nd = new Node(x, y, inLWall || inRWall);
        state.nodes.push(nd);
        return nd;
    }

    // Place a member, subdividing tension-only materials (rope/cable) into a
    // chain of short segments connected by free intermediate nodes. The chain
    // articulates naturally under gravity in sim — a single straight constraint
    // can never droop, no matter what compliance you set.
    function placeMemberOrChain(st, en, type) {
        const mat = MATERIALS[type];
        const dist = Math.hypot(en.x - st.x, en.y - st.y);
        // Don't subdivide short tension members or non-tension members
        if (!mat.tensionOnly || dist < GRID * 1.6) {
            const m = new Member(st, en, type);
            state.members.push(m);
            return [m];
        }
        const segs = Math.max(2, Math.round(dist / 22));
        const chainId = `chn_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
        // Steel cable is significantly heavier per unit length than hemp rope.
        // Lower invMass = heavier node → more sag, more inertia when swinging.
        const nodeInvMass = type === "cable" ? 0.35 : 1;
        const created = [];
        let prev = st;
        for (let i = 1; i <= segs; i++) {
            const t = i / segs;
            let next;
            if (i === segs) {
                next = en;
            } else {
                const nx = st.x + (en.x - st.x) * t;
                const ny = st.y + (en.y - st.y) * t;
                next = new Node(nx, ny, false);
                next._chainNode = true;
                next.invMass = nodeInvMass;
                state.nodes.push(next);
            }
            const m = new Member(prev, next, type);
            m.chainId = chainId;
            state.members.push(m);
            created.push(m);
            prev = next;
        }
        return created;
    }

    // Given a hit member, return all members in its chain (or just itself).
    function chainMembersOf(m) {
        if (!m.chainId) return [m];
        return state.members.filter(x => x.chainId === m.chainId);
    }

    // ─── End game ───────────────────────────────────
    function endGame(win) {
        if (state.finishCalled) return;
        state.finishCalled = true;
        state.finished = true;
        state.mode = "end";
        if (win) {
            const cost = calcCost(state.members);
            const memberCount = state.members.filter(m => !m.builtin).length;
            const sav = lvl.budget - cost;
            const grade = sav > lvl.budget * 0.4 ? "S" : sav > lvl.budget * 0.2 ? "A" : sav > 0 ? "B" : "C";
            completeLevel(levelIdx, grade, cost);
            const vName = lvlDef.multiVehicle ? "Both vehicles" : VEHICLES[lvl.vType].name;
            onBridgeSuccess({ summary: `${vName} crossed. Cost: $${cost}, Grade: ${grade}, ${memberCount} members` });
            onLevelComplete({ summary: `Level ${lvlDef.name} complete — grade ${grade}` });
            // Submit + fetch leaderboard. Both are async so we kick them off
            // here and stash on the modal once it opens — UI handles the
            // "loading" case if the fetch hasn't completed by show-time.
            const lbPromise = (async () => {
                const sub = await submitScore({ levelId: lvlDef.id, budgetUsed: cost, budget: lvl.budget, grade });
                const lb = await getLeaderboard(lvlDef.id, { budget: lvl.budget, budgetUsed: cost });
                return { ...lb, isPB: sub.isPB, prevBest: sub.prevBest };
            })().catch(() => null);
            setTimeout(() => {
                state.modal = {
                    win: true, title: "MISSION COMPLETE!",
                    desc: pickWinCaption(lvlDef.id, vName),
                    cost, grade, openTime: k.time(),
                    leaderboard: null,                  // populated when promise resolves
                };
                lbPromise.then(lb => { if (state.modal && state.modal.win) state.modal.leaderboard = lb; });
            }, 600);
        } else {
            const brokenCount = state.members.filter(m => m.broken).length;
            const memberCount = state.members.filter(m => !m.builtin).length;
            const maxStress = state.members.reduce((mx, m) => Math.max(mx, m.stress), 0);
            onBridgeFailed({
                summary: `Bridge collapsed. ${brokenCount}/${memberCount} members broke. Peak stress: ${maxStress.toFixed(2)}`,
                reason: brokenCount > memberCount * 0.5 ? "catastrophic_failure" : "weak_point",
            });
            state.shakeMag = 5;
            setTimeout(() => {
                state.modal = { win: false, title: "BRIDGE FAILED", desc: pickFailCaption(lvlDef.id), openTime: k.time() };
            }, 1000);
        }
    }

    // ═══════════════════════════════════════════════════
    //  INPUT
    // ═══════════════════════════════════════════════════
    k.onMousePress(() => {
        const pos = k.mousePos();
        // Tutorial overlay normally swallows clicks (first click finishes
        // typing, next advances). EXCEPTION: when the current step has an
        // interactive gate (awaitExpand) AND the click lands inside the
        // step's spotlight target, let it pass through so the player can
        // perform the action the tutorial is asking for.
        if (state.tutorialActive) {
            const tStep = TUTORIAL_STEPS[state.tutorialStep];
            const tgtRaw = tStep ? getTutorialTarget(tStep.key) : null;
            const tgts = Array.isArray(tgtRaw) ? tgtRaw : (tgtRaw ? [tgtRaw] : []);
            const inTarget = tgts.some(t =>
                pos.x >= t.x && pos.x <= t.x + t.w &&
                pos.y >= t.y && pos.y <= t.y + t.h);
            const passthrough = tStep && tStep.awaitExpand &&
                state.tutorialTyped >= tStep.text.length && inTarget;
            if (!passthrough) {
                handleTutorialClick();
                return;
            }
        }
        // Modal button clicks — mirrors the linkBtn positions in drawModal
        if (state.modal) {
            const L = getModalLayout();
            // Each icon button has its own rect now. Test all of them; if no
            // button is hit, the click is swallowed (modal blocks anything
            // behind it).
            const inBtn = (b) => {
                if (!b) return false;
                const cx = L.mx + b.cx, cy = L.my + b.cy;
                const half = b.w / 2;
                return Math.abs(pos.x - cx) < half && Math.abs(pos.y - cy) < half;
            };
            // NEXT — advance (win only)
            if (inBtn(L.buttons.next)) {
                const nx = levelIdx + 1;
                if (nx < LEVELS.length) k.go("game", { levelIdx: nx });
                else k.go("menu", { view: "levelSelect" });
                return;
            }
            // REPLAY / TRY AGAIN — reset to build, same level
            if (inBtn(L.buttons.replay)) {
                resetToBuild();
                return;
            }
            // AI TUTOR — only when level has been beaten at least once
            if (L.beaten && inBtn(L.buttons.ai)) {
                resetToBuild();
                handleAiClick();
                return;
            }
            // MENU — back to level select
            if (inBtn(L.buttons.menu)) {
                k.go("menu", { view: "levelSelect" });
                return;
            }
            return;
        }

        // ─── AI tutor panel clicks (options / next button) ───
        if (handleAiPanelClick(pos.x, pos.y)) return;

        // ─── Toolbar button clicks (screen-space) ───
        // Sidebar before toolbar — the toolbar handler ends with a catch-all
        // that swallows clicks in a ~50px band below the bar, which would
        // otherwise eat clicks on the wall-mount toggle.
        if (handleSidebarClick(pos)) return;
        if (handleToolbarClick(pos)) return;

        if (state.mode !== "build") return;
        const wp = toWorld(pos.x, pos.y);
        const sn = snapForBuild(wp.x, wp.y);

        // Delete mode
        if (state.delMode) {
            const sc = getScale();
            const hi = state.members.findIndex(m => !m.builtin && distToSegment(wp, m.n1, m.n2) < 16 / sc);
            if (hi !== -1) {
                const hit = state.members[hi];
                const group = chainMembersOf(hit);
                state.members = state.members.filter(m => !group.includes(m));
                const orphanNodes = state.nodes.filter(n =>
                    !n.fixed && !n.builtin && !state.members.some(mb => mb.n1 === n || mb.n2 === n));
                state.nodes = state.nodes.filter(n => !orphanNodes.includes(n));
                if (group.length > 1) {
                    pushNewUserAction({ deletedBatch: { members: group, nodes: orphanNodes } });
                } else {
                    pushNewUserAction({ deleted: { member: hit, nodes: orphanNodes } });
                }
            }
            return;
        }

        // Select mode — marquee selection & move
        if (state.selectMode) {
            const sc = getScale();
            // Single-node drag: clicking right on a free joint moves just
            // that point — beams stay attached but aren't "selected", so
            // the player can shift one corner without lugging the whole
            // truss around.
            const nodeHitR = 9 / sc;
            const nodeHit = state.nodes.find(n =>
                !n.fixed && !n.builtin && !n._chainNode
                && Math.hypot(n.x - wp.x, n.y - wp.y) < nodeHitR);
            if (nodeHit) {
                state.selectedMembers = new Set();
                state.selectMoving = true;
                state.selectMoveStart = { x: wp.x, y: wp.y };
                state.selectMoveOrig = new Map([[nodeHit, {
                    x: nodeHit.x, y: nodeHit.y, rx: nodeHit.rx, ry: nodeHit.ry,
                }]]);
                return;
            }
            // If there's already a selection AND the cursor is on one of the
            // selected members, start a MOVE. Otherwise start a new MARQUEE.
            const hitSelected = state.selectedMembers.size > 0 && [...state.selectedMembers].some(m =>
                !m.broken && distToSegment(wp, m.n1, m.n2) < 16 / sc);
            if (hitSelected) {
                state.selectMoving = true;
                state.selectMoveStart = { x: wp.x, y: wp.y };
                // Snapshot the original positions of every node in the selection
                // so we can undo the move AND produce the new-position delta later.
                const orig = new Map();
                for (const n of getSelectedNodes()) {
                    orig.set(n, { x: n.x, y: n.y, rx: n.rx, ry: n.ry });
                }
                state.selectMoveOrig = orig;
            } else {
                // Start a fresh marquee — clear any existing selection.
                state.selectedMembers = new Set();
                state.selectBoxing = true;
                state.selectBoxStart = { x: wp.x, y: wp.y };
                state.selectBoxEnd = { x: wp.x, y: wp.y };
            }
            return;
        }

        // Arch mode — three-phase: pick A → pick B → drag apex handle → click off to commit
        if (state.archMode) {
            // Phase A: choose start anchor — OR click on an existing arch to re-edit it
            if (!state.archStart) {
                const sc = getScale();
                const archMemberIdx = state.members.findIndex(m =>
                    m.archId != null && !m.broken && distToSegment(wp, m.n1, m.n2) < 16 / sc);
                if (archMemberIdx !== -1) {
                    const hit = state.members[archMemberIdx];
                    const archData = state.arches.find(a => a.id === hit.archId);
                    if (archData) {
                        // In-place edit: keep all arch members/nodes in the world
                        // and just move their positions as the apex handle drags.
                        // This way any user-added beams that connect to the
                        // arch's interior joints follow the arch around.
                        state.editingArchId = archData.id;
                        const nodeStates = new Map();
                        const restStates = new Map();
                        if (archData.nodeSequence) {
                            for (const n of archData.nodeSequence) {
                                nodeStates.set(n, { x: n.x, y: n.y, rx: n.rx, ry: n.ry });
                            }
                        }
                        for (const m of state.members) {
                            if (m.archId === archData.id) restStates.set(m, m.rest);
                        }
                        state.editingArchOrig = {
                            archId: archData.id,
                            origBulge: archData.bulge,
                            nodeStates,
                            restStates,
                        };
                        state.archStart = { ...archData.start };
                        state.archEnd = { ...archData.end };
                        state.archBulge = archData.bulge;
                        return;
                    }
                }
                const node = pickArchAnchor(wp);
                if (node) state.archStart = { x: node.x, y: node.y };
                return;
            }
            // Phase B: choose end anchor (must differ from start). Direction
            // comes from the hysteresis-tracked state (see onMouseMove).
            if (!state.archEnd) {
                const node = pickArchAnchor(wp);
                if (node && (node.x !== state.archStart.x || node.y !== state.archStart.y)) {
                    state.archEnd = { x: node.x, y: node.y };
                    const dx = node.x - state.archStart.x;
                    const dy = node.y - state.archStart.y;
                    const chord = Math.hypot(dx, dy);
                    state.archBulge = state.archBulgeDir * chord * 0.25;
                }
                return;
            }
            // Phase C: edit mode — handle drag vs commit
            const apexS = getArchApexScreen();
            const ms = k.mousePos();
            if (apexS && Math.hypot(ms.x - apexS.x, ms.y - apexS.y) < 16) {
                state.archDragging = true;       // grab the handle
                return;
            }
            // Click off the handle → commit using selected material
            const arch = computeArch();
            if (arch) applyArch(arch);
            resetArchState();
            return;
        }

        // Polybridge-style auto-extend — if the player has just placed a road
        // and clicks near where the next colinear segment would land, drop a
        // matching segment automatically. Lets you spam-click a straight run
        // without having to drag each piece.
        if (state.lastRoadEnd && state.mode === "build") {
            const mat = MATERIALS[state.selectedMat];
            if (mat && mat.isRoad) {
                const lr = state.lastRoadEnd;
                if (state.nodes.includes(lr.node) && !lr.node._chainNode) {
                    const px = lr.node.x + lr.dx;
                    const py = lr.node.y + lr.dy;
                    // Click must land within roughly half a segment of the
                    // predicted endpoint. Use the user's snapped target so
                    // grid-snapped clicks line up cleanly.
                    const distSq = (sn.x - px) * (sn.x - px) + (sn.y - py) * (sn.y - py);
                    const threshSq = (Math.hypot(lr.dx, lr.dy) * 0.6) * (Math.hypot(lr.dx, lr.dy) * 0.6);
                    if (distSq <= threshSq && px >= lX && px <= rX) {
                        const roadsOnStart = state.members.filter(m => MATERIALS[m.type].isRoad && (m.n1 === lr.node || m.n2 === lr.node)).length;
                        const existingEnd = state.nodes.find(n => n.x === px && n.y === py);
                        const roadsOnEnd = existingEnd
                            ? state.members.filter(m => MATERIALS[m.type].isRoad && (m.n1 === existingEnd || m.n2 === existingEnd)).length
                            : 0;
                        const dup = existingEnd && state.members.some(m =>
                            (m.n1 === lr.node && m.n2 === existingEnd) || (m.n2 === lr.node && m.n1 === existingEnd));
                        if (roadsOnStart < 2 && roadsOnEnd < 2 && !dup) {
                            const en = findOrCreate(px, py);
                            const created = placeMemberOrChain(lr.node, en, state.selectedMat);
                            if (created.length > 0) {
                                pushUndoAction(created);
                                state.lastRoadEnd = { node: en, dx: lr.dx, dy: lr.dy };
                                return;
                            }
                        }
                    }
                }
            }
        }

        // Start dragging from existing node
        const existingNode = state.nodes.find(n => n.x === sn.x && n.y === sn.y);
        if (!existingNode) return;
        if (!existingNode.fixed && !isConnectedToAnchor(state.nodes, state.members, sn.x, sn.y)) return;
        state.dragStart = existingNode;
        state.dragging = true;
    });

    k.onMouseMove((pos) => {
        state.mouseWorld = toWorld(pos.x, pos.y);
        if (state.mode === "build" && !state.delMode) {
            const sc = getScale();
            state.hoveredMember = state.members.find(m => distToSegment(state.mouseWorld, m.n1, m.n2) < 10 / sc) || null;
        }

        // Select mode — update marquee rectangle or translate the moving selection
        if (state.selectMode) {
            if (state.selectBoxing && state.selectBoxStart) {
                state.selectBoxEnd = { x: state.mouseWorld.x, y: state.mouseWorld.y };
            } else if (state.selectMoving && state.selectMoveStart && state.selectMoveOrig) {
                let dx = state.mouseWorld.x - state.selectMoveStart.x;
                let dy = state.mouseWorld.y - state.selectMoveStart.y;
                const moving = state.selectMoveOrig;

                // Realistic clamp: for any member where only ONE endpoint is in
                // the moving set (a boundary member), the move would stretch it.
                // Scale (dx, dy) down so no boundary member exceeds its material
                // maxLength. All nodes translate by the same factor → the
                // selection still moves rigidly, just capped at the stretch limit.
                const a = dx * dx + dy * dy;
                let t = 1;
                if (a > 1e-9) {
                    for (const m of state.members) {
                        if (m.broken || m.builtin) continue;
                        const n1In = moving.has(m.n1);
                        const n2In = moving.has(m.n2);
                        if (n1In === n2In) continue;
                        const movingN = n1In ? m.n1 : m.n2;
                        const staticN = n1In ? m.n2 : m.n1;
                        const origM   = moving.get(movingN);
                        const vx = origM.x - staticN.x;
                        const vy = origM.y - staticN.y;
                        const maxLen = MATERIALS[m.type].maxLength;
                        // Allow a small tolerance so already-at-max members can
                        // still move tangentially without a completely blocked t.
                        const limit = maxLen * 1.02;
                        const b = 2 * (vx * dx + vy * dy);
                        const c = vx * vx + vy * vy - limit * limit;
                        if (c > 0) continue;
                        const disc = b * b - 4 * a * c;
                        if (disc < 0) continue;
                        const tCand = (-b + Math.sqrt(disc)) / (2 * a);
                        if (tCand >= 0 && tCand < t) t = tCand;
                    }
                }
                dx *= t;
                dy *= t;

                for (const [n, orig] of moving) {
                    n.x  = orig.x + dx;
                    n.y  = orig.y + dy;
                    n.rx = n.x;
                    n.ry = n.y;
                }
                // Keep rest lengths in sync so sim uses the updated geometry.
                for (const m of state.members) {
                    if (m.broken || m.builtin) continue;
                    if (!moving.has(m.n1) && !moving.has(m.n2)) continue;
                    const d = Math.hypot(m.n2.x - m.n1.x, m.n2.y - m.n1.y);
                    const maxLen = MATERIALS[m.type].maxLength;
                    m.rest = Math.min(d, maxLen);
                }
            }
        }
        // Arch apex handle drag — recompute bulge from cursor's perpendicular offset
        if (state.archDragging && state.archStart && state.archEnd) {
            const A = state.archStart, B = state.archEnd;
            const dx = B.x - A.x, dy = B.y - A.y;
            const chord = Math.hypot(dx, dy);
            if (chord > 0) {
                const nx = -dy / chord, ny = dx / chord;
                const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
                let newBulge = (state.mouseWorld.x - mx) * nx + (state.mouseWorld.y - my) * ny;

                // In-place edit: clamp the bulge so the arch's fixed-count
                // segments never stretch past the material's maxLength.
                // (Fresh placement doesn't need this — buildArch picks N
                // dynamically to respect maxLength.)
                if (state.editingArchId != null) {
                    const archData = state.arches.find(a => a.id === state.editingArchId);
                    if (archData?.nodeSequence) {
                        const N = archData.nodeSequence.length - 1;
                        const maxLen = MATERIALS[state.selectedMat].maxLength;
                        const maxBulge = maxBulgeForStretch(chord, N, maxLen);
                        if (Math.abs(newBulge) > maxBulge) {
                            newBulge = Math.sign(newBulge) * maxBulge;
                        }
                    }
                }

                state.archBulge = newBulge;
                if (state.editingArchId != null) syncArchInPlace();
            }
        }

        // Phase-B bulge direction update with hysteresis: only flip when the
        // cursor moves clearly past the anchor (beyond a dead zone around the
        // chord line). When the cursor is close to the chord, keep the previous
        // direction so the preview doesn't flicker.
        if (state.archMode && state.archStart && !state.archEnd) {
            const A = state.archStart;
            const wp = state.mouseWorld;
            // Find nearest valid anchor to use as the "chord reference" for direction.
            // When no anchor is in snap range, fall back to start+cursor chord —
            // in that case the cursor is always ON the chord so direction doesn't change.
            let refEnd = null, bestD = Infinity;
            const snapRange = GRID * 3;
            for (const n of state.nodes) {
                if (n.builtin) continue;
                if (!n.fixed && !isConnectedToAnchor(state.nodes, state.members, n.x, n.y)) continue;
                if (n.x === A.x && n.y === A.y) continue;
                const d = Math.hypot(n.x - wp.x, n.y - wp.y);
                if (d < snapRange && d < bestD) { refEnd = n; bestD = d; }
            }
            if (refEnd) {
                const dx = refEnd.x - A.x, dy = refEnd.y - A.y;
                const chord = Math.hypot(dx, dy);
                if (chord > 5) {
                    const nx = -dy / chord, ny = dx / chord;
                    const mxm = (A.x + refEnd.x) / 2, mym = (A.y + refEnd.y) / 2;
                    const signedPerp = (wp.x - mxm) * nx + (wp.y - mym) * ny;
                    const threshold = GRID * 2;  // dead-zone radius around the chord
                    if (signedPerp >  threshold) state.archBulgeDir =  1;
                    else if (signedPerp < -threshold) state.archBulgeDir = -1;
                    // within ±threshold → keep previous direction (hysteresis)
                }
            }
        }
    });

    k.onMouseRelease(() => {
        // Releasing the apex handle just stops the drag (don't fall through to beam-drag logic)
        if (state.archDragging) { state.archDragging = false; return; }

        // Select mode — finalize marquee selection or commit a move to the undo stack.
        if (state.selectMode) {
            if (state.selectBoxing && state.selectBoxStart && state.selectBoxEnd) {
                const dx = state.selectBoxEnd.x - state.selectBoxStart.x;
                const dy = state.selectBoxEnd.y - state.selectBoxStart.y;
                const dragLen = Math.hypot(dx, dy);
                if (dragLen < 5) {
                    // Barely moved — treat as a click and pick the single member under the cursor.
                    const sc = getScale();
                    const hit = state.members.find(m =>
                        !m.builtin && !m.broken
                        && distToSegment(state.selectBoxStart, m.n1, m.n2) < 16 / sc);
                    state.selectedMembers = hit ? new Set([hit]) : new Set();
                } else {
                    const found = getMembersInBox(state.selectBoxStart, state.selectBoxEnd);
                    state.selectedMembers = new Set(found);
                }
                state.selectBoxing = false;
                state.selectBoxStart = null;
                state.selectBoxEnd = null;
            } else if (state.selectMoving && state.selectMoveOrig) {
                // Build the undo entry: pre/post-move positions for every moved node
                const nodeStates = new Map();    // orig map (used by existing editedInPlace undo path)
                const restStates = new Map();    // empty — members keep their rest lengths
                for (const [n, p] of state.selectMoveOrig) nodeStates.set(n, p);
                // Only push if anything actually moved
                let moved = false;
                for (const [n, p] of state.selectMoveOrig) {
                    if (n.x !== p.x || n.y !== p.y) { moved = true; break; }
                }
                if (moved) pushNewUserAction({ editedInPlace: { archId: -1, origBulge: 0, nodeStates, restStates } });
                state.selectMoving = false;
                state.selectMoveStart = null;
                state.selectMoveOrig = null;
            }
            return;
        }

        const pos = k.mousePos();
        if (!state.dragging || state.mode !== "build") { state.dragging = false; return; }
        const wp = toWorld(pos.x, pos.y);
        const sn = snapForBuild(wp.x, wp.y);
        const st = state.dragStart;
        if (!st) { state.dragging = false; return; }
        if (sn.x === st.x && sn.y === st.y) { state.dragging = false; return; }

        const d = Math.hypot(sn.x - st.x, sn.y - st.y);
        const mat = MATERIALS[state.selectedMat];

        // Road materials: stay within bridge zone, max 2 road connections per
        // node. In LINE mode the endpoint must already be an existing node so
        // a missed line-fill click can't create a long unsupported chain that
        // dead-ends mid-span. In single-segment mode we allow new endpoints —
        // the player is laying the deck one piece at a time toward the next
        // anchor, and forcing each segment to land on an existing node would
        // make that impossible.
        if (mat.isRoad) {
            if (sn.x < lX || sn.x > rX) { state.dragging = false; return; }
            const existingEnd = state.nodes.find(n => n.x === sn.x && n.y === sn.y);
            if (state.lineMode && !existingEnd) { state.dragging = false; return; }
            const roadsOnStart = state.members.filter(m => MATERIALS[m.type].isRoad && (m.n1 === st || m.n2 === st)).length;
            const roadsOnEnd = existingEnd ? state.members.filter(m => MATERIALS[m.type].isRoad && (m.n1 === existingEnd || m.n2 === existingEnd)).length : 0;
            if (roadsOnStart >= 2 || roadsOnEnd >= 2) { state.dragging = false; return; }
        }

        if (d > 5) {
            const added = [];
            if (state.lineMode && d > GRID) {
                // Line fill: auto-place segments along a straight line
                const linePts = getLinePoints(st.x, st.y, sn.x, sn.y);
                for (let li = 0; li < linePts.length - 1; li++) {
                    const lp1 = linePts[li];
                    const lp2 = linePts[li + 1];
                    const segD = Math.hypot(lp2.x - lp1.x, lp2.y - lp1.y);
                    if (segD < 5 || segD > mat.maxLength) continue;
                    const n1 = findOrCreate(lp1.x, lp1.y);
                    const n2 = findOrCreate(lp2.x, lp2.y);
                    if (n1 === n2) continue;
                    const exists = state.members.some(m =>
                        (m.n1 === n1 && m.n2 === n2) || (m.n2 === n1 && m.n1 === n2));
                    if (!exists) {
                        const m = new Member(n1, n2, state.selectedMat);
                        state.members.push(m);
                        added.push(m);
                    }
                }
            } else if (d <= mat.maxLength) {
                // Straight mode: single segment (or chain for tension-only)
                const en = findOrCreate(sn.x, sn.y);
                if (en === st) { state.dragging = false; return; }
                const exists = state.members.some(m =>
                    ((m.n1 === st && m.n2 === en) || (m.n2 === st && m.n1 === en)) ||
                    ((m.n1.x === st.x && m.n1.y === st.y && m.n2.x === en.x && m.n2.y === en.y) ||
                     (m.n2.x === st.x && m.n2.y === st.y && m.n1.x === en.x && m.n1.y === en.y))
                );
                if (!exists) {
                    const created = placeMemberOrChain(st, en, state.selectedMat);
                    for (const m of created) added.push(m);
                    // Remember this road's vector so the next click can extend
                    // colinearly (Polybridge auto-extend).
                    if (mat.isRoad && created.length > 0) {
                        state.lastRoadEnd = { node: en, dx: en.x - st.x, dy: en.y - st.y };
                    }
                }
            }
            pushUndoAction(added);
        }
        state.dragging = false;
    });

    // Keyboard shortcuts
    const availMats = lvlDef.materials || Object.keys(MATERIALS);
    for (let mi = 0; mi < availMats.length && mi < 9; mi++) {
        const matKey = availMats[mi];
        k.onKeyPress(String(mi + 1), () => {
            // Pick the upgraded tier if the slot is currently revealing it;
            // otherwise pick the base — match what the slot shows visually.
            const upgradeKey = upgradesUnlocked ? MATERIAL_UPGRADES[matKey] : null;
            state.selectedMat = (upgradeKey && state.matExpanded.has(matKey)) ? upgradeKey : matKey;
            state.lastRoadEnd = null;       // switching material ends the chain
        });
    }
    const resetArchState = () => {
        state.archStart = null;
        state.archEnd = null;
        state.archDragging = false;
        state.archBulgeDir = -1;   // next arch starts pointing up by default
    };

    // Every non-fixed, non-builtin node that's an endpoint of a selected member.
    function getSelectedNodes() {
        const nodes = new Set();
        for (const m of state.selectedMembers) {
            if (!m.n1.fixed && !m.n1.builtin) nodes.add(m.n1);
            if (!m.n2.fixed && !m.n2.builtin) nodes.add(m.n2);
        }
        return nodes;
    }

    // All non-builtin members whose midpoint falls inside the world-space marquee box.
    function getMembersInBox(p1, p2) {
        const lo = { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y) };
        const hi = { x: Math.max(p1.x, p2.x), y: Math.max(p1.y, p2.y) };
        return state.members.filter(m => {
            if (m.builtin || m.broken) return false;
            const mx = (m.n1.x + m.n2.x) / 2;
            const my = (m.n1.y + m.n2.y) / 2;
            return mx >= lo.x && mx <= hi.x && my >= lo.y && my <= hi.y;
        });
    }

    // Delete every currently-selected member (and any nodes orphaned by it).
    // Recorded as a SINGLE batched undo entry so one undo restores the whole
    // group at once — feels consistent with how the deletion happened.
    function deleteSelected() {
        if (!state.selectedMembers || state.selectedMembers.size === 0) return;
        const toDelete = [...state.selectedMembers];
        const remaining = state.members.filter(m => !state.selectedMembers.has(m));
        const orphan = [];
        for (const m of toDelete) {
            for (const n of [m.n1, m.n2]) {
                if (n.fixed || n.builtin) continue;
                if (orphan.includes(n)) continue;
                if (remaining.some(mb => mb.n1 === n || mb.n2 === n)) continue;
                orphan.push(n);
            }
        }
        state.members = remaining;
        state.nodes = state.nodes.filter(n => !orphan.includes(n));
        pushNewUserAction({ deletedBatch: { members: toDelete, nodes: orphan } });
        state.selectedMembers = new Set();
    }

    // Reset all ephemeral select-tool state (pending box, in-flight move, etc.).
    function clearSelectState() {
        state.selectBoxing = false;
        state.selectBoxStart = null;
        state.selectBoxEnd = null;
        state.selectMoving = false;
        state.selectMoveStart = null;
        state.selectMoveOrig = null;
    }

    // Turn off every build-mode tool mode and clean up any pending state from
    // each. Use when activating a new tool so they stay mutually exclusive.
    function clearToolModes() {
        state.delMode = false;
        state.lineMode = false;
        state.archMode = false;
        state.selectMode = false;
        state.selectedMembers = new Set();
        // Switching tool/material breaks the auto-extend chain so the player
        // doesn't accidentally extend an old chain after picking a new tool.
        state.lastRoadEnd = null;
        resetArchState();
        clearSelectState();
    }

    // Cancel any in-progress arch: if we were editing a placed arch, restore it
    // from the stash so the player gets back to where they started.
    function cancelArch() {
        if (state.editingArchId != null && state.editingArchOrig) {
            const orig = state.editingArchOrig;
            // Restore every node's position + rest origin
            for (const [n, p] of orig.nodeStates) {
                n.x = p.x; n.y = p.y; n.rx = p.rx; n.ry = p.ry;
            }
            // Restore every member's rest length
            for (const [m, rest] of orig.restStates) {
                m.rest = rest;
            }
            // Restore archData.bulge
            const arch = state.arches.find(a => a.id === state.editingArchId);
            if (arch) arch.bulge = orig.origBulge;
        }
        state.editingArchId = null;
        state.editingArchOrig = null;
        resetArchState();
    }
    k.onKeyPress("d", () => { const on = !state.delMode;    clearToolModes(); state.delMode = on; });
    k.onKeyPress("f", () => { const on = !state.lineMode;   clearToolModes(); state.lineMode = on; });
    k.onKeyPress("c", () => { const on = !state.archMode;   clearToolModes(); state.archMode = on; });
    k.onKeyPress("s", () => { if (state.mode !== "build") return; const on = !state.selectMode; clearToolModes(); state.selectMode = on; });
    // Delete / Backspace — removes the current selection (only in select mode).
    const deleteSelKey = () => {
        if (state.mode !== "build") return;
        if (!state.selectMode) return;
        if (!state.selectedMembers || state.selectedMembers.size === 0) return;
        deleteSelected();
    };
    k.onKeyPress("delete",    deleteSelKey);
    k.onKeyPress("backspace", deleteSelKey);
    // Z cancels an in-progress arch (before committing) instead of popping undo,
    // since an in-progress arch preview isn't in the undo stack yet.
    k.onKeyPress("z", () => {
        if (state.archMode && (state.archStart || state.archEnd || state.editingArchId != null)) {
            cancelArch();
            return;
        }
        undoLast();
    });
    k.onKeyPress("space", () => { toggleSim(); });
    k.onKeyPress("escape", () => {
        // In select mode with an active selection, Escape clears it first
        // instead of jumping back to the menu.
        if (state.selectMode && state.selectedMembers && state.selectedMembers.size > 0) {
            state.selectedMembers = new Set();
            clearSelectState();
            return;
        }
        k.go("menu", { view: "levelSelect" });
    });

    // Right-click: cancels in-progress arch, deletes the select-tool selection
    // (when any), otherwise deletes the hovered member.
    k.onMousePress("right", () => {
        if (state.archMode && (state.archStart || state.archEnd || state.editingArchId != null)) {
            cancelArch();
            return;
        }
        if (state.mode !== "build") return;
        // Select tool: nuke the whole selection with a single right-click
        if (state.selectMode && state.selectedMembers && state.selectedMembers.size > 0) {
            deleteSelected();
            return;
        }
        const pos = k.mousePos();
        // Block right-clicks that land on the toolbar
        const tb = getToolbar();
        if (pos.y < tb.h + tb.pad * 2 + 40) return;
        const wp = toWorld(pos.x, pos.y);
        const sc = getScale();
        const hi = state.members.findIndex(m => !m.builtin && distToSegment(wp, m.n1, m.n2) < 16 / sc);
        if (hi === -1) return;
        const hit = state.members[hi];
        const group = chainMembersOf(hit);
        state.members = state.members.filter(m => !group.includes(m));
        const orphanNodes = state.nodes.filter(n =>
            !n.fixed && !n.builtin && !state.members.some(mb => mb.n1 === n || mb.n2 === n));
        state.nodes = state.nodes.filter(n => !orphanNodes.includes(n));
        if (group.length > 1) {
            pushNewUserAction({ deletedBatch: { members: group, nodes: orphanNodes } });
        } else {
            pushNewUserAction({ deleted: { member: hit, nodes: orphanNodes } });
        }
    });

    // ─── Line fill: evenly spaced points along a straight line ──
    // Uses the selected material's maxLength as segment size
    function getLinePoints(x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        const mat = MATERIALS[state.selectedMat];
        const segLen = mat.maxLength;  // use longest possible segment
        if (len < segLen) return [{ x: x1, y: y1 }, { x: x2, y: y2 }];
        const steps = Math.ceil(len / segLen);
        const pts = [];
        for (let i = 0; i <= steps; i++) {
            const t = Math.min(1, i / steps);
            pts.push({
                x: x1 + dx * t,
                y: y1 + dy * t,
            });
        }
        // Deduplicate consecutive same points
        return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
    }

    // ─── Arch tool helpers ────────────────────────────
    //
    // Polybridge-style: click anchor A, hover (end snaps to nearest valid
    // anchor/connected node, height = perpendicular cursor offset from chord),
    // click again to commit. Endpoints stay grid-aligned (they ARE existing
    // nodes), but interior arch points are NOT grid-snapped — they trace a
    // smooth parabola. Segment count auto-scales so each ≤ material maxLength.

    // Find a valid anchor/connected node near a world point (for arch endpoints)
    function pickArchAnchor(wp) {
        const maxPick = GRID * 3;
        let best = null, bestD = Infinity;
        for (const n of state.nodes) {
            if (n.builtin) continue;
            // Only nodes that anchor structure (fixed anchors, or already connected to one)
            if (!n.fixed && !isConnectedToAnchor(state.nodes, state.members, n.x, n.y)) continue;
            const d = Math.hypot(n.x - wp.x, n.y - wp.y);
            if (d < bestD && d < maxPick) { best = n; bestD = d; }
        }
        return best;
    }

    // Compute arch geometry between two world points with a given bulge.
    // Returns { points, end, bulge } or null if degenerate.
    function buildArch(A, end, bulge) {
        const dx = end.x - A.x, dy = end.y - A.y;
        const chord = Math.hypot(dx, dy);
        if (chord < GRID) return null;

        const nx = -dy / chord, ny = dx / chord;

        // Segment count scales with arc length so each chord ≤ material maxLength.
        // Parabola arc length ≈ chord + (8/3)·bulge²/chord
        const mat = MATERIALS[state.selectedMat];
        const arcLen = chord + (8 / 3) * (bulge * bulge) / chord;
        let segments = Math.max(2, Math.ceil(arcLen / (mat.maxLength * 0.9)));

        const buildPoints = (n) => {
            const pts = [];
            for (let i = 0; i <= n; i++) {
                const t = i / n;
                const b = 4 * t * (1 - t) * bulge;
                pts.push({
                    x: A.x + dx * t + nx * b,
                    y: A.y + dy * t + ny * b,
                });
            }
            pts[0] = { x: A.x, y: A.y };
            pts[n] = { x: end.x, y: end.y };
            return pts;
        };

        let pts;
        for (let attempt = 0; attempt < 8; attempt++) {
            pts = buildPoints(segments);
            let worst = 0;
            for (let i = 0; i < pts.length - 1; i++) {
                const sd = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
                if (sd > worst) worst = sd;
            }
            if (worst <= mat.maxLength) break;
            segments++;
        }

        return { points: pts, end, bulge };
    }

    // Phase C: arch with the user-controlled bulge between locked endpoints
    function computeArch() {
        if (!state.archStart || !state.archEnd) return null;
        return buildArch(state.archStart, state.archEnd, state.archBulge);
    }

    // Max parabolic bulge such that the longest adjacent-sample chord in a
    // uniform-t N-segment sampling stays ≤ maxLen.
    //
    // For point i at t=i/N with y=4b·t(1-t), the adjacent step's Δy peaks at
    // the endpoints with magnitude 4|b|(N−1)/N². Segment length² equals
    // (L/N)² + (4b(N−1)/N²)². Solving that ≤ maxLen² for b:
    //   |b| ≤ N · √(N²·maxLen² − L²) / (4·(N−1))
    function maxBulgeForStretch(chord, N, maxLen) {
        if (N < 1) return 0;
        const inner = N * N * maxLen * maxLen - chord * chord;
        if (inner <= 0) return 0;
        const denom = 4 * Math.max(1, N - 1);
        return (N * Math.sqrt(inner)) / denom;
    }

    // While editing a placed arch, move its interior joint nodes to match the
    // current archBulge using the same parabolic formula used at creation time.
    // Keeps user-added beams that are connected to arch joints following the
    // arch shape as the apex handle is dragged. Also updates member rest
    // lengths so a later sim doesn't spring the arch back to its old shape.
    // If the player switched materials while editing, re-stamps the arch's
    // member types and compliances to match the new material.
    function syncArchInPlace() {
        if (state.editingArchId == null) return;
        const archData = state.arches.find(a => a.id === state.editingArchId);
        if (!archData || !archData.nodeSequence || archData.nodeSequence.length < 3) return;
        const seq = archData.nodeSequence;

        // Material switch during edit — update every arch member's type/compliance
        const selMat = MATERIALS[state.selectedMat];
        for (const m of state.members) {
            if (m.archId !== state.editingArchId) continue;
            if (m.type !== state.selectedMat) {
                m.type = state.selectedMat;
                m.compliance = selMat.compliance;
            }
        }

        const A = state.archStart, end = state.archEnd;
        const dx = end.x - A.x, dy = end.y - A.y;
        const chord = Math.hypot(dx, dy);
        if (chord < 5) return;
        const nx = -dy / chord, ny = dx / chord;
        const bulge = state.archBulge;
        const N = seq.length - 1;  // number of segments

        for (let i = 1; i < N; i++) {
            const t = i / N;
            const b = 4 * t * (1 - t) * bulge;
            const newX = A.x + dx * t + nx * b;
            const newY = A.y + dy * t + ny * b;
            const n = seq[i];
            n.x = newX; n.y = newY;
            n.rx = newX; n.ry = newY;      // rest position = current, so reset-to-build preserves
        }
        // Refresh rest lengths for every member of this arch
        for (const m of state.members) {
            if (m.archId !== state.editingArchId) continue;
            m.rest = Math.hypot(m.n1.x - m.n2.x, m.n1.y - m.n2.y);
        }
    }

    // Phase B: preview arch from locked start to the cursor. If the cursor is
    // hovering near a valid anchor, the end snaps to that anchor so the player
    // sees exactly what clicking would commit. Bulge direction follows whichever
    // side of the chord the cursor is on (so aiming above → up arch, below →
    // down arch).
    function computeArchPhaseBPreview() {
        if (!state.archStart || state.archEnd) return null;
        const wp = state.mouseWorld;

        // Snap to nearest valid anchor when cursor is in its grab range
        let snapped = null, bestD = Infinity;
        const snapRange = GRID * 3;
        for (const n of state.nodes) {
            if (n.builtin) continue;
            if (!n.fixed && !isConnectedToAnchor(state.nodes, state.members, n.x, n.y)) continue;
            if (n.x === state.archStart.x && n.y === state.archStart.y) continue;
            const d = Math.hypot(n.x - wp.x, n.y - wp.y);
            if (d < snapRange && d < bestD) { snapped = n; bestD = d; }
        }

        const end = snapped ? { x: snapped.x, y: snapped.y } : { x: wp.x, y: wp.y };
        const dx = end.x - state.archStart.x, dy = end.y - state.archStart.y;
        const chord = Math.hypot(dx, dy);
        if (chord < GRID) return null;

        // Direction comes from the hysteresis-tracked state (updated in onMouseMove)
        const arch = buildArch(state.archStart, end, state.archBulgeDir * chord * 0.25);
        if (arch) arch.snapped = !!snapped;
        return arch;
    }

    // Screen position of the arch's apex (where the draggable handle sits)
    function getArchApexScreen() {
        if (!state.archStart || !state.archEnd) return null;
        const A = state.archStart, B = state.archEnd;
        const dx = B.x - A.x, dy = B.y - A.y;
        const chord = Math.hypot(dx, dy);
        if (chord === 0) return null;
        const nx = -dy / chord, ny = dx / chord;
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
        const apex = { x: mx + nx * state.archBulge, y: my + ny * state.archBulge };
        return toScreen(apex.x, apex.y);
    }

    function applyArch(arch) {
        // ── In-place edit commit ──
        // Arch was edited by dragging the apex handle; member/node positions
        // are already synced via syncArchInPlace() while dragging. Nothing to
        // create — just persist the new bulge and record a reversible action.
        if (state.editingArchId != null) {
            const archData = state.arches.find(a => a.id === state.editingArchId);
            if (archData) archData.bulge = state.archBulge;
            if (state.editingArchOrig) {
                pushNewUserAction({ editedInPlace: {
                    ...state.editingArchOrig,
                    newBulge: state.archBulge,
                } });
            }
            state.editingArchId = null;
            state.editingArchOrig = null;
            return;
        }

        // ── Fresh placement ──
        const archId = state.nextArchId++;
        const nodeSequence = [];
        const added = [];
        for (let i = 0; i < arch.points.length; i++) {
            const p = arch.points[i];
            nodeSequence.push(findOrCreate(p.x, p.y));
        }
        for (let i = 0; i < nodeSequence.length - 1; i++) {
            const n1 = nodeSequence[i], n2 = nodeSequence[i + 1];
            if (n1 === n2) continue;
            const exists = state.members.some(mb =>
                (mb.n1 === n1 && mb.n2 === n2) || (mb.n2 === n1 && mb.n1 === n2));
            if (!exists) {
                const m = new Member(n1, n2, state.selectedMat);
                m.archId = archId;
                state.members.push(m);
                added.push(m);
            }
        }

        const newArchData = {
            id: archId,
            start: { ...state.archStart },
            end: { ...state.archEnd },
            bulge: state.archBulge,
            nodeSequence,          // keeps ordered references for in-place edits
        };
        state.arches.push(newArchData);
        state.nodes = state.nodes.filter(n =>
            n.fixed || n.builtin || state.members.some(m => m.n1 === n || m.n2 === n));
        pushUndoAction(added);
    }

    // Record one action (a list of members placed in a single user gesture)
    function pushUndoAction(members) {
        if (members && members.length) {
            state.undoStack.push({ members });
            state.redoStack = [];
        }
    }

    // Applies a new user action (not triggered by undo/redo). Clears redo stack.
    function pushNewUserAction(action) {
        state.undoStack.push(action);
        state.redoStack = [];
    }

    // Drop any UI references (arch-edit handle, select-tool selection) that
    // point at members/arches no longer in `state`. Call after any undo/redo
    // path that removes structures — otherwise the apex handle + blue anchors
    // linger as a ghost of the deleted arch.
    function pruneDanglingUIState() {
        if (state.editingArchId != null && !state.arches.some(a => a.id === state.editingArchId)) {
            state.editingArchId = null;
            state.editingArchOrig = null;
        }
        if (state.selectedMembers && state.selectedMembers.size) {
            for (const m of [...state.selectedMembers]) {
                if (!state.members.includes(m)) state.selectedMembers.delete(m);
            }
        }
    }

    function undoLast() {
        if (state.mode !== "build") return;
        const action = state.undoStack.pop();
        if (!action) return;
        // Undo breaks the auto-extend chain — the "last placed" road may have
        // just been removed, and even if not, continuing a chain across an
        // undo is more confusing than helpful.
        state.lastRoadEnd = null;

        if (action.deleted) {
            // Restore a previously-deleted member + any orphan nodes that went with it
            for (const n of action.deleted.nodes) {
                if (!state.nodes.includes(n)) state.nodes.push(n);
            }
            state.members.push(action.deleted.member);
            // Redo = delete it again
            state.redoStack.push({ redoDelete: action.deleted });
            return;
        }

        if (action.deletedBatch) {
            // Restore every member + every orphan node that went with them in a
            // single undo step (inverse of select-tool batch delete).
            for (const n of action.deletedBatch.nodes) {
                if (!state.nodes.includes(n)) state.nodes.push(n);
            }
            for (const m of action.deletedBatch.members) {
                if (!state.members.includes(m)) state.members.push(m);
            }
            state.redoStack.push({ redoDeleteBatch: action.deletedBatch });
            return;
        }

        if (action.editedInPlace) {
            // Arch apex-handle edit reversal: restore every arch node's position
            // (so connected beams snap back too) + member rest lengths + bulge.
            const orig = action.editedInPlace;
            // Capture current (post-edit) state so redo can re-apply it
            const newNodeStates = new Map();
            const newRestStates = new Map();
            for (const [n, _] of orig.nodeStates) newNodeStates.set(n, { x: n.x, y: n.y, rx: n.rx, ry: n.ry });
            for (const [m, _] of orig.restStates) newRestStates.set(m, m.rest);
            const arch = state.arches.find(a => a.id === orig.archId);
            const newBulge = arch?.bulge;

            for (const [n, p] of orig.nodeStates) {
                n.x = p.x; n.y = p.y; n.rx = p.rx; n.ry = p.ry;
            }
            for (const [m, rest] of orig.restStates) m.rest = rest;
            if (arch) arch.bulge = orig.origBulge;

            state.redoStack.push({ editedInPlace: { archId: orig.archId, origBulge: newBulge, nodeStates: newNodeStates, restStates: newRestStates } });
            return;
        }

        // Action added members → remove them, then sweep orphan nodes
        const removedIds = new Set();
        for (const m of action.members) {
            if (m.archId != null) removedIds.add(m.archId);
            const idx = state.members.indexOf(m);
            if (idx !== -1) state.members.splice(idx, 1);
        }
        // If the removed members belonged to arch(es) and no more members from
        // the arch remain, drop the arch record too
        const droppedArches = [];
        for (const id of removedIds) {
            if (!state.members.some(mb => mb.archId === id)) {
                const a = state.arches.find(ar => ar.id === id);
                if (a) droppedArches.push(a);
                state.arches = state.arches.filter(ar => ar.id !== id);
            }
        }
        const droppedNodes = [];
        state.nodes = state.nodes.filter(n => {
            const keep = n.fixed || n.builtin || state.members.some(m => m.n1 === n || m.n2 === n);
            if (!keep) droppedNodes.push(n);
            return keep;
        });

        state.redoStack.push({ redoAdd: { members: action.members, nodes: droppedNodes, arches: droppedArches } });
        pruneDanglingUIState();
    }

    function redoLast() {
        if (state.mode !== "build") return;
        const action = state.redoStack.pop();
        if (!action) return;

        if (action.redoDelete) {
            // Delete the member again (and sweep its orphan nodes)
            const m = action.redoDelete.member;
            const idx = state.members.indexOf(m);
            if (idx !== -1) state.members.splice(idx, 1);
            state.nodes = state.nodes.filter(n => !action.redoDelete.nodes.includes(n));
            state.undoStack.push({ deleted: action.redoDelete });
            pruneDanglingUIState();
            return;
        }

        if (action.redoDeleteBatch) {
            const batch = action.redoDeleteBatch;
            state.members = state.members.filter(m => !batch.members.includes(m));
            state.nodes = state.nodes.filter(n => !batch.nodes.includes(n));
            state.undoStack.push({ deletedBatch: batch });
            pruneDanglingUIState();
            return;
        }

        if (action.editedInPlace) {
            // Re-apply the post-edit state; capture pre-edit as the new undo target
            const orig = action.editedInPlace;
            const preNodeStates = new Map();
            const preRestStates = new Map();
            for (const [n, _] of orig.nodeStates) preNodeStates.set(n, { x: n.x, y: n.y, rx: n.rx, ry: n.ry });
            for (const [m, _] of orig.restStates) preRestStates.set(m, m.rest);
            const arch = state.arches.find(a => a.id === orig.archId);
            const preBulge = arch?.bulge;

            for (const [n, p] of orig.nodeStates) {
                n.x = p.x; n.y = p.y; n.rx = p.rx; n.ry = p.ry;
            }
            for (const [m, rest] of orig.restStates) m.rest = rest;
            if (arch) arch.bulge = orig.origBulge;

            state.undoStack.push({ editedInPlace: { archId: orig.archId, origBulge: preBulge, nodeStates: preNodeStates, restStates: preRestStates } });
            return;
        }

        if (action.redoAdd) {
            for (const n of action.redoAdd.nodes) {
                if (!state.nodes.includes(n)) state.nodes.push(n);
            }
            for (const a of action.redoAdd.arches) {
                if (!state.arches.some(ar => ar.id === a.id)) state.arches.push(a);
            }
            for (const m of action.redoAdd.members) {
                if (!state.members.includes(m)) state.members.push(m);
            }
            state.undoStack.push({ members: action.redoAdd.members });
        }
    }

    function toggleSim() {
        state.finishCalled = false;
        state.lastRoadEnd = null;       // sim/build switch ends the chain
        if (state.mode === "build") {
            const cost = calcCost(state.members);
            if (cost > lvl.budget) {
                state.modal = { win: false, title: "OVER BUDGET", desc: `$${cost.toLocaleString()} exceeds the $${lvl.budget.toLocaleString()} budget. Remove some members.`, openTime: k.time() };
                return;
            }
            // Select tool is build-only — dragging nodes mid-sim fights the XPBD
            // solver and makes stress readings jump around. Clear it on entry.
            state.selectMode = false;
            state.selectedMembers = new Set();
            clearSelectState();
            // Cancel any in-progress arch so its preview doesn't render in sim
            cancelArch();
            // Mark vehicles as already on the surface so vehicleTick snaps
            // immediately on the first frame — no drop animation.
            for (const v of state.vehicles) { v.vy = 0; v._falling = false; }
            initPhysicsWorld(state, lvl);
            state.mode = "sim";
        } else {
            resetToBuild();
        }
    }

    // ─── Toolbar layout (computed per-frame for responsiveness) ──
    function getToolbar() {
        const W = k.width();
        const pad = 8;
        const tbH = 50;
        const matKeys = lvlDef.materials || Object.keys(MATERIALS);
        // Bigger material slots for the bumped-up icons.
        const matBtnW = 74;
        const matGap = 8;
        const toolGap = 2;     // tighter, uniform spacing between tool buttons
        const toolW = 48;
        const toolCount = 6;                  // line, arch, select, delete, undo, redo
        // Per-slot x positions — small extra gap between material groups (road/structural/tension).
        const matGroupExtra = 6;
        const matGroup = k => MATERIALS[k]?.tensionOnly ? 2 : MATERIALS[k]?.isRoad ? 0 : 1;
        const matOffsets = [];
        let off = 0;
        for (let i = 0; i < matKeys.length; i++) {
            matOffsets.push(off);
            if (i < matKeys.length - 1) {
                const extra = matGroup(matKeys[i]) !== matGroup(matKeys[i + 1]) ? matGroupExtra : 0;
                off += matBtnW + matGap + extra;
            }
        }
        const matGroupW = off + matBtnW;
        const toolGroupW = toolCount * toolW + (toolCount - 1) * toolGap;
        // Anchor tools at the position they'd occupy with 2 material slots so the
        // divider and tool buttons don't shift when more materials are added.
        const BASE_MATS = 2;
        const baseMatGroupW = BASE_MATS * matBtnW + (BASE_MATS - 1) * matGap;
        const groupSep = 32;
        const baseTotalW = baseMatGroupW + groupSep + toolGroupW;
        const toolStartX = Math.round((W - baseTotalW) / 2) + baseMatGroupW + groupSep + 40;
        const matStartX = toolStartX - groupSep - matGroupW;
        const matX = matOffsets.map(o => matStartX + o);
        const matsEnd = matStartX + matGroupW;
        // Vertically center every button on the bar's midline.
        const barMid = (tbH + pad) / 2;
        const btnY = Math.round(barMid - 16);  // h=32 → offset 16
        // Tool button order: select, line, arch, delete, undo, redo
        const toolX = (slot) => toolStartX + slot * (toolW + toolGap);

        return {
            h: tbH, pad,
            matKeys, matBtnW, matGap, matStartX, matX,
            // Button positions (approximate bounding boxes)
            simBtn:    { x: W - 220, y: btnY, w: 46, h: 32 },
            selectBtn: { x: toolX(0), y: btnY, w: toolW, h: 32 },
            lineBtn:   { x: toolX(1), y: btnY, w: toolW, h: 32 },
            archBtn:   { x: toolX(2), y: btnY, w: toolW, h: 32 },
            delBtn:    { x: toolX(3), y: btnY, w: toolW, h: 32 },
            undoBtn:   { x: toolX(4), y: btnY, w: toolW, h: 32 },
            redoBtn:   { x: toolX(5), y: btnY, w: toolW, h: 32 },
            // Split speed control: arrows sit tight against the central value.
            speedDownBtn: { x: W - 158, y: btnY, w: 30, h: 32 },
            speedUpBtn:   { x: W - 88,  y: btnY, w: 30, h: 32 },
            menuBtn:      { x: W - 50,  y: btnY, w: 40, h: 32 },
            // AI + Hint sit just under the left edge of the toolbar, tucked out
            // of the way to keep the notebook area clear for the bridge build.
            // Hangs ~30px below the toolbar so the suspension ropes have a
            // visible length and can tilt convincingly during the swing.
            aiBtn:     { x: 26, y: pad + tbH + 32, w: 48, h: 36 },
            hintBtn:   { x: 76, y: pad + tbH + 32, w: 48, h: 36 },
        };
    }

    // ─── Bottom-left sidebar (build-mode toggles) ───
    // Three icon buttons stacked vertically on a small wood plate. Each
    // toggles a player preference that's persisted to localStorage so it
    // survives reloads and level changes.
    // Sidebar = a hanging shop-style sign attached to the right edge of the
    // canvas (the "wall"), holding the three icon toggles. It auto-extends
    // in build mode and tucks back into the wall in sim/end mode. There's
    // no separate toggle button — the sign is always there when it's
    // relevant.
    function getSidebar() {
        const W = k.width();
        const tb = getToolbar();
        const toolbarBot = tb.h + tb.pad;

        // Mounting bar — its right end sits on the wall (the canvas's right
        // edge). The sign hangs from the bar's LEFT end. Scaled down ~18%
        // from the original size so it stays out of the build view.
        const barH = 6;
        const barRight = W;                       // attaches at the right edge
        const barY = toolbarBot + 20;             // below the toolbar with a small gap

        // Sign hangs below the bar via two short ropes.
        const ropeLen = 10;
        const signW = 138, signH = 46;
        const signTop = barY + barH + ropeLen;

        // 3 icon buttons in a row inside the sign.
        const iconBtnW = 38, iconBtnH = 36;
        const iconGap  = 4;
        const iconRowW = 3 * iconBtnW + 2 * iconGap;

        // Bar slightly overhangs the sign on the wall side so the chains read
        // as hanging below the protruding tip of the bar.
        const barOverhang = 12;
        const barFullLength = signW + barOverhang;

        // Animation: the entire assembly translates left from a hidden
        // rest position (right edge tucked behind the wall) to its full
        // extension. We slide a fixed distance (signW + barOverhang) and
        // fade in over the slide for a clean reveal.
        const t = state.sidebarOpenT;
        const slideDist = barFullLength;
        const offsetX = (1 - t) * slideDist;      // 0 at open, slideDist at closed

        const barLeft  = barRight - barFullLength + offsetX;
        const signLeft = barLeft;                 // sign hangs from the LEFT end of the bar
        const iconRowLeft = signLeft + (signW - iconRowW) / 2;
        const iconY = signTop + (signH - iconBtnH) / 2 - 1;

        return {
            // Bar + sign geometry (animation-driven)
            barLeft, barRight, barY, barH,
            ropeLen,
            signLeft, signTop, signW, signH,
            // Icon hit-areas
            gridBtn:   { x: iconRowLeft,                                  y: iconY, w: iconBtnW, h: iconBtnH },
            snapBtn:   { x: iconRowLeft + (iconBtnW + iconGap),           y: iconY, w: iconBtnW, h: iconBtnH },
            stressBtn: { x: iconRowLeft + 2 * (iconBtnW + iconGap),       y: iconY, w: iconBtnW, h: iconBtnH },
        };
    }

    function drawSidebar() {
        // The sidebar only makes sense while building — its toggles edit
        // build-mode behavior. Sim/end auto-tucks it into the wall; build
        // brings it back. No manual toggle button.
        const inBuild = state.mode === "build";
        const target = inBuild ? 1 : 0;
        const dt = k.dt() || 1 / 60;
        const lerp = 1 - Math.exp(-11 * dt);
        state.sidebarOpenT += (target - state.sidebarOpenT) * lerp;
        if (Math.abs(target - state.sidebarOpenT) < 0.001) state.sidebarOpenT = target;

        const sb = getSidebar();
        const t = state.sidebarOpenT;

        // ── Hanging sign (drawn FIRST so the toggle covers any leak) ──
        if (t > 0.02) {
            // Idle sway — barely-there drift, only when fully extended.
            // Larger amplitudes were translating into a noticeable vertical
            // bob on the sign (it's far from the pivot, so a tiny rotation
            // arcs into a visible up/down).
            const swayDeg = (t > 0.99 && inBuild)
                ? Math.sin(k.time() * 0.55) * 0.5
                : 0;
            // Pivot around the bar's RIGHT end (where it bolts to the wall).
            const pivotX = sb.barRight;
            const pivotY = sb.barY + sb.barH / 2;
            const fade = Math.min(1, Math.max(0, (t - 0.05) / 0.55));

            k.pushTransform();
            k.pushTranslate(pivotX, pivotY);
            k.pushRotate(swayDeg);
            k.pushTranslate(-pivotX, -pivotY);

            // ── Mounting bar ──
            const barLen = sb.barRight - sb.barLeft;
            // Bar drop shadow
            k.drawRect({
                pos: k.vec2(sb.barLeft + 1, sb.barY + 2),
                width: barLen, height: sb.barH,
                color: colorOf("#010101"), opacity: 0.32 * fade,
                anchor: "topleft", radius: 2,
            });
            // Bar body
            k.drawRect({
                pos: k.vec2(sb.barLeft, sb.barY),
                width: barLen, height: sb.barH,
                color: colorOf("#9c5c2c"), opacity: fade,
                anchor: "topleft", radius: 2,
            });
            // Top highlight + bottom shadow stripes
            k.drawRect({
                pos: k.vec2(sb.barLeft, sb.barY),
                width: barLen, height: 1.2,
                color: colorOf("#bd7434"), opacity: 0.7 * fade,
                anchor: "topleft",
            });
            k.drawRect({
                pos: k.vec2(sb.barLeft, sb.barY + sb.barH - 1.4),
                width: barLen, height: 1.4,
                color: colorOf("#6e3c1a"), opacity: 0.6 * fade,
                anchor: "topleft",
            });
            // Outline
            k.drawRect({
                pos: k.vec2(sb.barLeft, sb.barY),
                width: barLen, height: sb.barH,
                fill: false, outline: { width: 1, color: colorOf("#3a2110") },
                anchor: "topleft", radius: 2, opacity: 0.55 * fade,
            });

            // ── Two ropes from bar bottom to sign top ──
            const ropeBotY = sb.barY + sb.barH;
            const ropeTopY = sb.signTop;
            const drawRope = (rx) => {
                k.drawLine({
                    p1: k.vec2(rx, ropeBotY), p2: k.vec2(rx, ropeTopY),
                    width: 3, color: colorOf("#4a2810"), opacity: fade,
                });
                k.drawLine({
                    p1: k.vec2(rx, ropeBotY), p2: k.vec2(rx, ropeTopY),
                    width: 1.4, color: colorOf("#a87838"), opacity: fade,
                });
            };
            drawRope(sb.signLeft + 8);
            drawRope(sb.signLeft + sb.signW - 8);

            // ── Sign body ──
            // Drop shadow
            k.drawRect({
                pos: k.vec2(sb.signLeft + 2, sb.signTop + 3),
                width: sb.signW, height: sb.signH,
                color: colorOf("#010101"), opacity: 0.34 * fade,
                anchor: "topleft", radius: 4,
            });
            // Wood body
            k.drawRect({
                pos: k.vec2(sb.signLeft, sb.signTop),
                width: sb.signW, height: sb.signH,
                color: colorOf("#d37e3d"), opacity: fade,
                anchor: "topleft", radius: 4,
            });
            // Wood grain — horizontal streaks
            for (let gy = sb.signTop + 6; gy < sb.signTop + sb.signH - 6; gy += 7) {
                k.drawLine({
                    p1: k.vec2(sb.signLeft + 6, gy),
                    p2: k.vec2(sb.signLeft + sb.signW - 6, gy + 1),
                    width: 0.7, color: colorOf("#8e4924"), opacity: 0.18 * fade,
                });
            }
            // Top highlight + bottom shadow band
            k.drawRect({
                pos: k.vec2(sb.signLeft, sb.signTop), width: sb.signW, height: 1.2,
                color: colorOf("#ffffff"), opacity: 0.22 * fade, anchor: "topleft",
            });
            k.drawRect({
                pos: k.vec2(sb.signLeft, sb.signTop + sb.signH - 3),
                width: sb.signW, height: 3,
                color: colorOf("#8e4924"), opacity: fade, anchor: "topleft",
            });
            // Outline
            k.drawRect({
                pos: k.vec2(sb.signLeft, sb.signTop),
                width: sb.signW, height: sb.signH,
                fill: false, outline: { width: 1, color: colorOf("#3a2110") },
                anchor: "topleft", radius: 4, opacity: 0.5 * fade,
            });

            // Three icon buttons. drawToolIconBtn handles hover + active
            // outline. We don't fade the icon strokes themselves — they're
            // already gated by the t > 0.02 check, and fading them was
            // making active outlines look ghostly mid-animation.
            if (t > 0.45) {
                drawToolIconBtn(sb.gridBtn,   drawGridIcon,   state.showGrid,   "sb_grid");
                drawToolIconBtn(sb.snapBtn,   drawSnapIcon,   state.snapGrid,   "sb_snap");
                drawToolIconBtn(sb.stressBtn, drawStressIcon, state.showStress, "sb_stress");
            }

            k.popTransform();
        }

    }

    function handleSidebarClick(pos) {
        // Sidebar is inert outside of build mode — sim/end auto-close it,
        // so let those clicks pass through.
        if (state.mode !== "build") return false;
        // Sign icon clicks only register once the slide is mostly out, so
        // a click in empty space mid-animation can't flip a hidden setting.
        if (state.sidebarOpenT < 0.6) return false;
        const sb = getSidebar();
        const inRect = (r) => pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h;
        if (inRect(sb.gridBtn))   { state.showGrid   = !state.showGrid;   saveSidebarPrefs(); return true; }
        if (inRect(sb.snapBtn))   { state.snapGrid   = !state.snapGrid;   saveSidebarPrefs(); return true; }
        if (inRect(sb.stressBtn)) { state.showStress = !state.showStress; saveSidebarPrefs(); return true; }
        return false;
    }

    function saveSidebarPrefs() {
        try {
            const cur = JSON.parse(localStorage.getItem("bridgesnap_settings")) || {};
            cur.showGrid    = state.showGrid;
            cur.snapGrid    = state.snapGrid;
            cur.showStress  = state.showStress;
            localStorage.setItem("bridgesnap_settings", JSON.stringify(cur));
        } catch {}
    }

    // Snap helper that respects the sidebar toggle. Anchors still snap so the
    // player can attach to fixed mounts even with grid-snap off — the only
    // thing being relaxed is the round-to-grid behavior for free placement.
    function snapForBuild(wx, wy) {
        const anchors = getAnchors();
        for (const a of anchors) {
            if (Math.abs(wx - a.x) < GRID * 0.8 && Math.abs(wy - a.y) < GRID * 0.8)
                return { x: a.x, y: a.y };
        }
        if (state.snapGrid) return { x: Math.round(wx / GRID) * GRID, y: Math.round(wy / GRID) * GRID };
        return { x: wx, y: wy };
    }

    function handleToolbarClick(pos) {
        const tb = getToolbar();
        const y = pos.y;

        // Material buttons — match the draw layout exactly (gap matters for hit testing)
        const matY = tb.simBtn.y;  // same vertical row
        for (let i = 0; i < tb.matKeys.length; i++) {
            const bx = tb.matX[i];
            if (pos.x >= bx && pos.x <= bx + tb.matBtnW && y >= matY && y <= matY + 32) {
                const baseKey = tb.matKeys[i];
                const upgradeKey = upgradesUnlocked ? MATERIAL_UPGRADES[baseKey] : null;
                const now = k.time();
                const last = state.matLastClick;
                const isDouble = upgradeKey && last && last.key === baseKey && (now - last.time) < 0.3;

                if (isDouble) {
                    // Toggle the upgraded reveal for this slot. Restart the
                    // reveal animation in BOTH directions so collapsing back
                    // to the base tier feels just as snappy as the upgrade.
                    if (state.matExpanded.has(baseKey)) {
                        state.matExpanded.delete(baseKey);
                        if (state.selectedMat === upgradeKey) state.selectedMat = baseKey;
                    } else {
                        state.matExpanded.add(baseKey);
                        state.selectedMat = upgradeKey;       // jumping straight to the upgrade feels right
                    }
                    state.matRevealT[baseKey] = 0;
                    state.matLastClick = null;
                } else {
                    // Single click — pick whatever's currently displayed in the slot.
                    state.selectedMat = state.matExpanded.has(baseKey) ? upgradeKey : baseKey;
                    state.matLastClick = { key: baseKey, time: now };
                }
                state.delMode = false;
                state.lastRoadEnd = null;       // toolbar pick ends the chain
                return true;
            }
        }

        // Simulate button
        const sb = tb.simBtn;
        if (pos.x >= sb.x && pos.x <= sb.x + sb.w && y >= sb.y && y <= sb.y + sb.h) {
            toggleSim();
            return true;
        }

        // Delete button
        const db = tb.delBtn;
        if (pos.x >= db.x && pos.x <= db.x + db.w && y >= db.y && y <= db.y + db.h) {
            const on = !state.delMode;
            clearToolModes();
            state.delMode = on;
            return true;
        }

        // Line fill button
        const lb = tb.lineBtn;
        if (pos.x >= lb.x && pos.x <= lb.x + lb.w && y >= lb.y && y <= lb.y + lb.h) {
            const on = !state.lineMode;
            clearToolModes();
            state.lineMode = on;
            return true;
        }

        // Arch button
        const arb = tb.archBtn;
        if (pos.x >= arb.x && pos.x <= arb.x + arb.w && y >= arb.y && y <= arb.y + arb.h) {
            const on = !state.archMode;
            clearToolModes();
            state.archMode = on;
            return true;
        }

        // Select button — build-only (nothing to select/move while the sim is running)
        const selb = tb.selectBtn;
        if (pos.x >= selb.x && pos.x <= selb.x + selb.w && y >= selb.y && y <= selb.y + selb.h) {
            if (state.mode !== "build") return true;
            const on = !state.selectMode;
            clearToolModes();
            state.selectMode = on;
            return true;
        }

        // Undo button
        const ub = tb.undoBtn;
        if (pos.x >= ub.x && pos.x <= ub.x + ub.w && y >= ub.y && y <= ub.y + ub.h) {
            undoLast();
            return true;
        }

        // Redo button
        const rb = tb.redoBtn;
        if (pos.x >= rb.x && pos.x <= rb.x + rb.w && y >= rb.y && y <= rb.y + rb.h) {
            redoLast();
            return true;
        }

        // Speed down — steps backward through [0.5, 1, 2, 4] (clamped at 0.5)
        const spd = tb.speedDownBtn;
        if (pos.x >= spd.x && pos.x <= spd.x + spd.w && y >= spd.y && y <= spd.y + spd.h) {
            const speeds = [0.5, 1, 2, 4];
            const idx = Math.max(0, speeds.indexOf(state.simSpeed) - 1);
            state.simSpeed = speeds[idx];
            return true;
        }
        // Speed up — steps forward through [0.5, 1, 2, 4] (clamped at 4)
        const spu = tb.speedUpBtn;
        if (pos.x >= spu.x && pos.x <= spu.x + spu.w && y >= spu.y && y <= spu.y + spu.h) {
            const speeds = [0.5, 1, 2, 4];
            const idx = Math.min(speeds.length - 1, speeds.indexOf(state.simSpeed) + 1);
            state.simSpeed = speeds[idx];
            return true;
        }

        // Menu button
        const mb = tb.menuBtn;
        if (pos.x >= mb.x && pos.x <= mb.x + mb.w && y >= mb.y && y <= mb.y + mb.h) {
            k.go("menu", { view: "levelSelect" });
            return true;
        }

        // AI button
        const ab = tb.aiBtn;
        if (pos.x >= ab.x && pos.x <= ab.x + ab.w && y >= ab.y && y <= ab.y + ab.h) {
            handleAiClick();
            return true;
        }

        // Hint button
        const hb = tb.hintBtn;
        if (pos.x >= hb.x && pos.x <= hb.x + hb.w && y >= hb.y && y <= hb.y + hb.h) {
            state.hintOpen = !state.hintOpen;
            if (state.hintOpen) onHintRequest();
            return true;
        }

        return y < tb.h + tb.pad * 2 + 40; // block clicks on toolbar area
    }

    // ─── AI Tutor (Socratic lesson) ─────────────────
    async function handleAiClick() {
        if (state.aiPanelOpen && !state.aiLoading) {
            state.aiPanelOpen = false;
            return;
        }

        const levelBeaten = getCompleted().includes(levelIdx);
        if (!levelBeaten) {
            state.aiPanelOpen = true;
            state.aiResult = {
                explanation: "Beat this level first to unlock the AI tutor!",
                concept: lvlDef.concept,
            };
            onRecapRequest();
            return;
        }

        if (state.aiLoading) return;
        state.aiLoading = true;
        state.aiPanelOpen = true;
        state.aiResult = null;
        state.aiStepIdx = 0;
        state.aiPhase = "step";
        state.aiTyped = 0;
        state.aiHighlightTimer = 0;
        state.aiHighlightMembers = [];
        onRecapRequest();

        // Clear player's bridge so the lesson builds its own from scratch
        state.members = state.members.filter(m => m.builtin);
        state.nodes = state.nodes.filter(n => n.fixed || n.builtin);

        const result = await solveBridge(lvl, lvlDef);
        state.aiLoading = false;
        state.aiResult = result;
    }

    // Place the members for the current lesson step into the world. Returns
    // the array of newly created members so the caller can highlight them.
    function buildLessonStep(step) {
        if (!step?.members) return [];
        const added = [];
        for (const mb of step.members) {
            const x1 = Math.round(mb.x1 / GRID) * GRID;
            const y1 = Math.round(mb.y1 / GRID) * GRID;
            const x2 = Math.round(mb.x2 / GRID) * GRID;
            const y2 = Math.round(mb.y2 / GRID) * GRID;
            const type = mb.type in MATERIALS ? mb.type : "wood_beam";
            const n1 = findOrCreate(x1, y1);
            const n2 = findOrCreate(x2, y2);
            const exists = state.members.some(m =>
                (m.n1 === n1 && m.n2 === n2) || (m.n2 === n1 && m.n1 === n2));
            if (!exists) {
                const m = new Member(n1, n2, type);
                state.members.push(m);
                added.push(m);
            }
        }
        pushUndoAction(added);
        return added;
    }

    // Click on the "Build & Next" / "Close" button. The teaching panel has
    // just one click target per state (no quiz options to pick).
    function handleAiPanelClick(mx, my) {
        if (!state.aiPanelOpen || !state.aiResult?.steps) return false;
        if (state.aiNextRect) {
            const r = state.aiNextRect;
            if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
                advanceLesson();
                return true;
            }
        }
        return false;
    }

    function advanceLesson() {
        const lesson = state.aiResult;
        if (!lesson?.steps) return;

        if (state.aiPhase === "done") {
            state.aiPanelOpen = false;
            return;
        }

        // Build the pieces for the current step, capture them for the
        // post-build glow, then move on.
        const stepNow = lesson.steps[state.aiStepIdx];
        const added = buildLessonStep(stepNow);
        state.aiHighlightMembers = added;
        state.aiHighlightTimer = added.length > 0 ? 1.6 : 0;

        state.aiStepIdx += 1;
        if (state.aiStepIdx >= lesson.steps.length) {
            state.aiPhase = "done";
        } else {
            state.aiPhase = "step";
        }
    }

    // ═══════════════════════════════════════════════════
    //  UPDATE (physics)
    //
    //  Fixed-timestep accumulator: physics runs at a fixed Hz
    //  (user-selectable via settings) independent of display
    //  refresh rate. Without this, a 144Hz monitor runs the
    //  simulation 2.4× faster than a 60Hz one.
    //
    //  fpsCap: 30 or 60 → physics ticks at that rate.
    //  fpsCap: 0        → one tick per animation frame (matches
    //                     display refresh — legacy uncapped).
    // ═══════════════════════════════════════════════════
    // Cached fps cap. Reading localStorage + JSON.parse on every onUpdate
    // call (60–144 times per second) burned real CPU. Re-read at most once
    // every 2 seconds, which still picks up settings changes promptly.
    let _fpsCap = 60;
    let _fpsCapNextCheck = 0;
    function getFpsCap() {
        const now = performance.now();
        if (now < _fpsCapNextCheck) return _fpsCap;
        _fpsCapNextCheck = now + 2000;
        try {
            const s = JSON.parse(localStorage.getItem("bridgesnap_settings")) || {};
            _fpsCap = typeof s.fpsCap === "number" ? s.fpsCap : 60;
        } catch { _fpsCap = 60; }
        return _fpsCap;
    }
    let physicsAcc = 0;

    k.onUpdate(() => {
        if (state.mode !== "sim" && state.mode !== "end") return;

        const fpsCap = getFpsCap();
        let ticksThisFrame;
        if (fpsCap === 0) {
            ticksThisFrame = 1;
        } else {
            const step = 1 / fpsCap;
            physicsAcc += k.dt();
            ticksThisFrame = 0;
            while (physicsAcc >= step) {
                physicsAcc -= step;
                ticksThisFrame++;
                if (ticksThisFrame >= 5) { physicsAcc = 0; break; }
            }
        }

        for (let tick = 0; tick < ticksThisFrame; tick++) {
        for (let sp = 0; sp < state.simSpeed; sp++) {
            // Physics keeps running in "end" mode so pieces fall and dangle
            physicsTick(state);

            // Vehicle tick + win/fail checks only during active sim
            if (state.mode === "sim") {
                state.simTime++;

                if (state.simTime > 38) {
                    // Check for splash when vehicle falls into water
                    const splashY = Math.max(lY, rY) + TABLE_DEPTH * 0.36;
                    for (const v of state.vehicles) {
                        if (v.active && !v._splashed && v.y > splashY && v.x > lX && v.x < rX && v.vy > 1) {
                            v._splashed = true;
                            state.splashes.push({ x: v.x, y: splashY, frame: 0, timer: 0 });
                        }
                    }

                    // Tell vehicleTick where the bottom of the visible canvas
                    // is in WORLD coords so it can fire fail the moment a
                    // falling/sinking vehicle leaves the screen, instead of
                    // waiting for the legacy y > 1100 hard-stop.
                    lvl._screenBottomY = toWorld(0, k.height()).y;
                    // Screen-edge X (world coords). Used by passOnly vehicles
                    // to know when they've driven fully off-screen so the
                    // sequel vehicle can run / level can resolve.
                    lvl._screenLeftX  = toWorld(0, 0).x;
                    lvl._screenRightX = toWorld(k.width(), 0).x;
                    // Finish-X in world coords. Matches the visible flag
                    // position (anchor + FLAG_INLAND_*) plus a small margin
                    // so a vehicle has fully passed the flag pole before
                    // _passedFlag fires.
                    lvl._finishRightX = rX + FLAG_INLAND_R + 8;
                    lvl._finishLeftX  = lX - FLAG_INLAND_L - 8;

                    const result = vehicleTick(state, lvl, lvlDef);
                    if (result === "win") endGame(true);
                    else if (result === "fail") endGame(false);

                    // Exhaust smoke — periodic puffs from the rear of motorized
                    // vehicles to make the static sprites feel like they're running.
                    for (const v of state.vehicles) {
                        if (!v.active || v._splashed || v._falling || v.finished) continue;
                        if (v._waitFor != null) continue;       // parked on its approach — engine off
                        if (v.cfg.sprite === "veh_bicycle") continue;
                        v._smokeTimer = (v._smokeTimer || 0) - 1;
                        if (v._smokeTimer <= 0) {
                            // Heavier vehicles smoke more often
                            const interval = v.cfg.mass > 100 ? 8 : 14;
                            v._smokeTimer = interval + Math.random() * 4;
                            // Smoke trails behind motion. Use the vehicle's
                            // intended travel direction (v._dir), not the
                            // instantaneous vx — sequential vehicles park with
                            // vx=0 while waiting, and a brief stall on a slope
                            // can flip vx, which would spit smoke from the
                            // front for that frame.
                            const travel = v._dir || (v.vx < 0 ? -1 : 1);
                            const dir = travel > 0 ? -1 : 1;     // opposite of motion
                            const sX = v.x + dir * v.cfg.w * 0.42;
                            const sY = v.y + v.cfg.h * 0.18;
                            state.particles.push({
                                x: sX, y: sY,
                                vx: dir * 0.45 + (Math.random() - 0.5) * 0.3,
                                vy: -0.35 - Math.random() * 0.25,
                                life: 1,
                                decay: 0.018 + Math.random() * 0.010,
                                r: 2.4 + Math.random() * 1.4,
                                color: "#bdbdbd",
                                update() {
                                    this.x += this.vx;
                                    this.y += this.vy;
                                    this.vy += 0.004;
                                    this.vx *= 0.94;
                                    this.r *= 1.018;
                                    this.life -= this.decay;
                                },
                            });
                        }
                    }

                    // Water drag — once a vehicle has splashed in, water resists
                    // its motion. Heavy vehicles (camper, truck, bus) nose-dive
                    // slowly with their engine weight pulling the front down.
                    // Lighter vehicles can still tumble as they sink.
                    for (const v of state.vehicles) {
                        if (!v._splashed) continue;
                        const isHeavy = v.cfg.mass > 100;
                        if (isHeavy) {
                            // Rotate toward nose-down (forward direction)
                            const targetAngle = (Math.PI / 2) * (v.vx >= 0 ? 1 : -1);
                            v.angle += (targetAngle - v.angle) * 0.035;
                            if (typeof v.angVel === "number") v.angVel *= 0.7;
                            v.vy *= 0.82;
                            if (v.vy < 0.18) v.vy = 0.18;
                            if (v.vy > 0.7)  v.vy = 0.7;
                            if (typeof v.vx === "number") v.vx *= 0.82;
                        } else {
                            // Light vehicle — some residual spin and tumble
                            v.vy *= 0.85;
                            if (v.vy < 0.35) v.vy = 0.35;
                            if (v.vy > 1.2)  v.vy = 1.2;
                            if (typeof v.vx === "number")    v.vx     *= 0.88;
                            if (typeof v.angVel === "number") v.angVel *= 0.92;
                        }
                    }
                }
            }

            // Check for bridge nodes hitting water (fallen halves)
            const splashWY = Math.max(lY, rY) + TABLE_DEPTH * 0.36;
            for (const n of state.nodes) {
                if (n.invMass === 0 || n._splashed) continue;
                if (n.y > splashWY && n.x > lX - 20 && n.x < rX + 20 && n.vy > 1) {
                    n._splashed = true;
                    state.splashes.push({ x: n.x, y: splashWY, frame: 0, timer: 0 });
                }
            }

            // Splashes, particles, shake — always update for visual polish.
            // We update + compact in a single in-place pass to skip the
            // per-frame array reallocation that .filter() does.
            compactInPlace(state.splashes, (s) => {
                s.timer += 0.5;
                s.frame = (s.timer | 0) % 18;
                return s.timer < 18;
            });

            compactInPlace(state.particles, (p) => {
                p.update();
                return p.life > 0;
            });

            // Consume snap events from physics → spawn popup + confetti burst
            if (state.snapEvents.length) {
                for (const ev of state.snapEvents) spawnSnapVfx(ev.x, ev.y);
                state.snapEvents.length = 0;
            }

            compactInPlace(state.snapPopups, (p) => {
                p.age++;
                p.y -= 0.35;
                return p.age < p.life;
            });

            compactInPlace(state.snapConfetti, (c) => {
                c.age++;
                c.x += c.vx;
                c.y += c.vy;
                c.vy += 0.18;
                c.vx *= 0.99;
                c.rot += c.rotSpd;
                return c.age < c.life;
            });

            if (state.shakeMag > 0.05) state.shakeMag *= 0.80;
            else state.shakeMag = 0;

            // AI helper post-build glow decay — the members the AI just
            // placed pulse for ~1.6s after a "Build & Next" so the player
            // sees what changed.
            if (state.aiHighlightTimer > 0) {
                state.aiHighlightTimer = Math.max(0, state.aiHighlightTimer - (k.dt() || 1/60));
                if (state.aiHighlightTimer === 0) state.aiHighlightMembers = [];
            }

            state.flagWave += 0.05;
        }
        }
    });

    // ═══════════════════════════════════════════════════
    //  RENDER
    // ═══════════════════════════════════════════════════
    k.onDraw(() => {
        try {
            const W = k.width();
            const H = k.height();
            const sc = getScale();

            drawBackground(W, H, sc);
            drawWater(W, H, sc);
            // Submerged member halves render AFTER the water so fallen pieces
            // stay visible; the draw layers a blue tint in-place to sell "seen
            // through water" rather than being hidden by the solid water rect.
            drawMembers(sc, "structural-submerged");
            // Wave surface drawn AFTER submerged members so the wave sprite
            // overlays any bridge piece dipping into the water.
            drawWaterSurface(W, sc);
            // Terrain (cliffs + rock pier) draws OVER the submerged layer so
            // anything truly underwater is occluded by the rock when behind it.
            drawTerrain(sc);
            // Above-water road planks render AFTER the terrain — a fallen
            // plank resting on the rock should appear ON TOP of the rock,
            // not behind it. Halo first so the select glow sits behind.
            drawSelectHalo(sc, "roads");
            drawMembers(sc, "roads");
            drawAnchorDots(sc);   // drawn after roads so dots are never buried under planks
            drawAutoExtendGhost(sc);
            drawGhostBeam(sc);
            drawFlags(sc);        // flags behind vehicles
            drawVehicles(sc);
            // Blue halo behind selected arch (must precede structural draw)
            drawArchEditHalo(sc);
            // Blue halo behind STRUCTURAL selected members (the road-member halo
            // was already drawn before the "roads" pass above).
            drawSelectHalo(sc, "structural");
            // Above-water structural beams in front of the car for a 3D-truss
            // feel — the car appears to pass *through* the bridge frame
            drawMembers(sc, "structural");
            // Yellow node handles render LAST among the bridge stack so beam
            // line caps and grain marks can't peek through the handle.
            drawNodes(sc);
            // AI helper post-build glow — pulses around the members the AI
            // just placed so the player can see WHAT changed.
            drawAiBuildHighlight(sc);
            // Arch preview on top of structural so apex handle is always visible
            drawArchPreview(sc);
            // Select-tool marquee rectangle — drawn on top of everything so it's always visible
            drawSelectBox(sc);
            drawSplashes(sc);
            drawParticles(sc);
            drawSnapConfetti(sc);
            drawSnapPopups(sc);

            // ─── UI overlay (screen space) ──────────────
            drawToolbar();
            drawSidebar();
            drawHintPanel();
            drawAiPanel();
            if (state.modal) drawModal();
            if (state.tutorialActive) drawTutorialOverlay();
        } catch(e) {
            // Show error on screen so we can debug
            k.drawRect({ width: k.width(), height: 60, pos: k.vec2(0, 0), color: colorOf("#cc0000"), anchor: "topleft" });
            k.drawText({ text: "ERR: " + e.message, pos: k.vec2(10, 20), size: 14, color: colorOf("#ffffff") });
            console.error(e);
        }
    });

    // ─── Background ───────────────────────────────
    // Rotate backgrounds: different nature set every 2 levels
    const BG_SETS = ["nature_2", "nature_3", "nature_4", "nature_5"];
    const bgSet = BG_SETS[Math.floor(levelIdx / 2) % BG_SETS.length];
    const BG_LAYERS = [
        { sprite: `bg_${levelIdx}_1`,  speed: 0.01 },
        { sprite: `bg_${levelIdx}_2`,  speed: 0.03 },
        { sprite: `bg_${levelIdx}_3`,  speed: 0.06 },
        { sprite: `bg_${levelIdx}_4`,  speed: 0.10 },
    ];
    let bgScroll = 0;

    const BASE = import.meta.env.BASE_URL;

    // Load background sprites for this level's set
    try {
        k.loadSprite(`bg_${levelIdx}_1`, `${BASE}assets/backgrounds/${bgSet}/1.png`);
        k.loadSprite(`bg_${levelIdx}_2`, `${BASE}assets/backgrounds/${bgSet}/2.png`);
        k.loadSprite(`bg_${levelIdx}_3`, `${BASE}assets/backgrounds/${bgSet}/3.png`);
        k.loadSprite(`bg_${levelIdx}_4`, `${BASE}assets/backgrounds/${bgSet}/4.png`);
    } catch(e) {
        console.warn("Could not load background sprites:", e);
    }

    // Load water sprites
    let waterLoaded = false;
    try {
        k.loadSprite("water_tile", `${BASE}assets/Water/Full colour/PNGs/Water Tile.png`, { sliceX: 32 });
        k.loadSprite("fish", `${BASE}assets/Water/Fish/PNGs/Fish Swimming.png`, { sliceX: 10 });
        k.loadSprite("splash", `${BASE}assets/Water/Splash Effect/PNG/Splash Effect.png`, { sliceX: 18 });
        waterLoaded = true;
    } catch(e) {
        console.warn("Could not load water sprites:", e);
    }
    let waterFrame = 0;

    function drawBackground(W, H, sc) {
        if (state.mode === "sim" || state.mode === "end") {
            // ─── Sim mode: parallax pixel art backgrounds ───
            // Sky color base
            k.drawRect({ width: W, height: H, pos: k.vec2(0, 0), color: colorOf("#4a90c8"), anchor: "topleft" });

            // Scroll rate scales with sim speed so the parallax matches the
            // pace of the rest of the simulation (flags, water, vehicles).
            bgScroll += 0.3 * state.simSpeed;

            // Stretch the parallax bg down to (or just past) the waterline so
            // its grassy bottom edge meets the water naturally — no flat-green
            // band, no sky-blue stripe between bg and water.
            const waterScreenY = toScreen(0, Math.max(lY, rY) + TABLE_DEPTH * 0.36).y;
            const bgH = Math.max(H * 0.65, waterScreenY + 4);
            for (const layer of BG_LAYERS) {
                try {
                    const offset = (bgScroll * layer.speed) % W;
                    k.drawSprite({ sprite: layer.sprite, pos: k.vec2(-offset, 0), width: W, height: bgH, anchor: "topleft" });
                    k.drawSprite({ sprite: layer.sprite, pos: k.vec2(W - offset, 0), width: W, height: bgH, anchor: "topleft" });
                } catch(e) {}
            }
            return;
        }

        // ─── Build mode: graph-paper grid with major/minor lines ───
        //
        // Renders crisp pixel-aligned lines (integer positions + width 1).
        // Skips minor grid when world-units are too compressed to render
        // cleanly — avoids moiré / aliased appearance at small scales.
        k.drawRect({ width: W, height: H, pos: k.vec2(0, 0), color: colorOf("#d9c9a8"), anchor: "topleft" });

        // Player can hide the grid via the sidebar — keep the cream paper.
        if (!state.showGrid) return;

        const wLeft = toWorld(0, 0);
        const wRight = toWorld(W, H);

        const step = GRID;       // minor grid (12px world units)
        const major = GRID * 3;  // major grid (36px world units)
        const lineCol = colorOf("#8a7350");

        // How many screen pixels per minor step? Skip minor lines if too cramped.
        const minorPx = step * sc;
        const drawMinor = minorPx >= 5;

        // Align line positions to integer pixels with 0.5 offset for crisp 1px rendering.
        const pixelAlign = (v) => Math.round(v) + 0.5;

        // Vertical lines — integer index prevents FP drift on long loops
        const iStartX = Math.floor(wLeft.x / step) - 1;
        const iEndX   = Math.ceil(wRight.x / step) + 1;
        for (let i = iStartX; i <= iEndX; i++) {
            const wx = i * step;
            const isMajor = i % 3 === 0;
            if (!isMajor && !drawMinor) continue;
            const sx = pixelAlign(toScreen(wx, 0).x);
            k.drawLine({
                p1: k.vec2(sx, 0),
                p2: k.vec2(sx, H),
                width: 1,
                color: lineCol,
                opacity: isMajor ? 0.40 : 0.18,
            });
        }
        // Horizontal lines
        const iStartY = Math.floor(wLeft.y / step) - 1;
        const iEndY   = Math.ceil(wRight.y / step) + 1;
        for (let i = iStartY; i <= iEndY; i++) {
            const wy = i * step;
            const isMajor = i % 3 === 0;
            if (!isMajor && !drawMinor) continue;
            const sy = pixelAlign(toScreen(0, wy).y);
            k.drawLine({
                p1: k.vec2(0, sy),
                p2: k.vec2(W, sy),
                width: 1,
                color: lineCol,
                opacity: isMajor ? 0.40 : 0.18,
            });
        }
    }

    // ─── Terrain: grassy ground with road ─────────────
    const TABLE_DEPTH = 200;  // cliff depth below road level
    const ROAD_H = 10;        // asphalt road thickness in world units

    function drawTerrain(sc) {
        // Draw left ground
        drawGround(lX - 600, lX, lY, sc, "left");
        // Draw right ground
        drawGround(rX, rX + 600, rY, sc, "right");

        // Mid-land platform — free-standing dirt-and-road segment between
        // two gaps. Shadow drawn on both inner edges since both sides face
        // gaps.
        if (state._midLand) {
            const ml = state._midLand;
            drawGround(ml.x1, ml.x2, ml.y, sc, "both");
        }

        // Cliff tower masts — extra anchors on the cliff surface above cliff top.
        for (const n of state.nodes) {
            if (!n.fixed || n.builtin) continue;
            if (n.x < lX && n.y < lY) drawCliffTower(n.x, n.y, lY, sc);
            else if (n.x > rX && n.y < rY) drawCliffTower(n.x, n.y, rY, sc);
        }

        // Mid-gap rock piers — vertical stone pillars rising from below
        // for each MID anchor (e.g. Stepping Stone, Deep Valley).
        const ml = state._midLand;
        for (const n of state.nodes) {
            if (!n.fixed || n.builtin) continue;
            if (n.x <= lX || n.x >= rX) continue;
            // Skip the platform's corner anchors — they sit on the mid-land
            // body, not on a stone pier.
            if (ml && n.y === ml.y && (n.x === ml.x1 || n.x === ml.x2)) continue;
            drawMidPier(n.x, n.y, sc);
        }

        // Anchor dots drawn separately (drawAnchorDots) so they render after roads.
    }

    function drawAnchorDots(sc) {
        if (state.mode !== "build") return;
        {
            const t = k.time();
            const mpos = k.mousePos();
            // Direct guarded loop avoids allocating a filtered subarray every
            // frame just to iterate it once.
            for (const n of state.nodes) {
                if (!n.fixed || n.builtin) continue;
                const p = toScreen(n.x, n.y);
                const onCliffTop = (n.x === lX && n.y === lY) || (n.x === rX && n.y === rY);
                const onMidPier  = n.x > lX && n.x < rX;
                const onSideWall = !onCliffTop && !onMidPier;        // tower above OR truss support below
                const isPrimary  = onCliffTop || onMidPier || onSideWall;
                const baseR = isPrimary ? sc * 4.5 : sc * 3.5;

                const phase = (n.x * 0.013 + n.y * 0.017);
                const breathe = 0.5 + 0.5 * Math.sin(t * 1.6 + phase);  // 0..1
                const hovered = isPrimary && Math.hypot(mpos.x - p.x, mpos.y - p.y) < baseR * 2.4;
                const hoverPop = hovered ? 1.18 : 1;
                const r = baseR * (1 + breathe * 0.06) * hoverPop;

                // Only the cliff-wall "extra" anchors get the grey socket plate
                // underneath — mid-pier anchors sit directly on their rock.
                if (!isPrimary) {
                    const bw = r * 2.5, bh = r * 0.8;
                    k.drawRect({ pos: k.vec2(p.x - bw / 2, p.y - bh / 2), width: bw, height: bh, color: colorOf("#555555"), anchor: "topleft" });
                }

                // Outer glow halo — pulses with the breathing, brighter on hover.
                if (isPrimary) {
                    const glowR = r * (2.2 + 0.4 * breathe + (hovered ? 0.6 : 0));
                    const glowOp = (0.10 + 0.18 * breathe) * (hovered ? 2.2 : 1);
                    // Layered rings for soft falloff
                    for (let g = 3; g >= 1; g--) {
                        k.drawCircle({
                            pos: p,
                            radius: glowR * (0.7 + 0.15 * g),
                            color: colorOf("#ff6464"),
                            opacity: glowOp * (0.4 / g),
                        });
                    }
                }

                // Drop shadow
                k.drawCircle({ pos: k.vec2(p.x + 0.5, p.y + 0.5), radius: r + 1, color: colorOf("#010101"), opacity: 0.25 });
                // Main dot
                k.drawCircle({ pos: p, radius: r, color: colorOf(isPrimary ? "#c43030" : "#606878") });
                // Highlight pip — subtle shimmer that tracks the breathing
                k.drawCircle({
                    pos: k.vec2(p.x - r * 0.25, p.y - r * 0.25),
                    radius: r * 0.3,
                    color: colorOf("#ffffff"),
                    opacity: 0.35 + 0.25 * breathe,
                });
                // Hover ring — crisp outline that appears only when the cursor
                // is nearby, signaling "you can grab/build off this".
                if (hovered) {
                    k.drawCircle({
                        pos: p,
                        radius: r + 2.5,
                        fill: false,
                        outline: { width: 2, color: colorOf("#ffd479") },
                        opacity: 0.8,
                    });
                }
            }
        }
    }

    // Greyscale stone palette so the rock reads as a distinct element from the
    // dirt/cliff approach tables.
    function drawMidPier(ax, ay, sc) {
        const H = k.height();
        const screenTop = toScreen(ax, ay);
        // Rock top sits just above the anchor so the red dot plants onto it
        // rather than floating above.
        const topY = screenTop.y - 4 * sc;
        const botY = H + 20;   // run past the bottom of the screen
        const topHalfW = 22 * sc;
        const botHalfW = 52 * sc;

        const lerp = (a, b, t) => a + (b - a) * t;

        // Main stone body — horizontal slices for a taper. Cool greys with a
        // subtle gradient from lighter at top to darker at the base.
        const sliceH = Math.max(2, 6 * sc);
        for (let y = topY; y < botY; y += sliceH) {
            const t = Math.min(1, (y - topY) / (botY - topY));
            const halfW = lerp(topHalfW, botHalfW, t);
            // Light stone → mid stone → dark stone
            const col = t < 0.22 ? "#a5a095" : t < 0.55 ? "#7d7870" : "#5a5650";
            k.drawRect({
                pos: k.vec2(screenTop.x - halfW, y),
                width: halfW * 2, height: sliceH + 0.5,
                color: colorOf(col),
                anchor: "topleft",
            });
        }

        // Weathered cap right under the anchor — a slightly warmer/darker
        // stone band so the red dot reads as sitting on a solid ledge, not
        // just painted onto the top of the pillar.
        const capH = Math.max(3, 5 * sc);
        k.drawRect({
            pos: k.vec2(screenTop.x - topHalfW, topY),
            width: topHalfW * 2, height: capH,
            color: colorOf("#8a857a"),
            anchor: "topleft",
        });
        // Tiny highlight along the very top of the cap
        k.drawRect({
            pos: k.vec2(screenTop.x - topHalfW, topY),
            width: topHalfW * 2, height: Math.max(1, 1.5 * sc),
            color: colorOf("#c0bcb2"),
            anchor: "topleft", opacity: 0.7,
        });

        // Thin dark silhouette edges on both sides.
        const edgeN = 20;
        for (let i = 0; i < edgeN; i++) {
            const t = i / edgeN;
            const y = lerp(topY + capH, botY, t);
            const halfW = lerp(topHalfW, botHalfW, t);
            k.drawRect({
                pos: k.vec2(screenTop.x - halfW, y),
                width: 1, height: (botY - topY) / edgeN + 1,
                color: colorOf("#2a2824"),
                anchor: "topleft", opacity: 0.35,
            });
            k.drawRect({
                pos: k.vec2(screenTop.x + halfW - 1, y),
                width: 1, height: (botY - topY) / edgeN + 1,
                color: colorOf("#2a2824"),
                anchor: "topleft", opacity: 0.35,
            });
        }

        // Horizontal rock seams — stone layering look.
        const seamStep = Math.max(10, 18 * sc);
        for (let y = topY + capH + seamStep; y < botY; y += seamStep) {
            const t = (y - topY) / (botY - topY);
            const halfW = lerp(topHalfW, botHalfW, t);
            k.drawLine({
                p1: k.vec2(screenTop.x - halfW + 2, y),
                p2: k.vec2(screenTop.x + halfW - 2, y),
                width: 1, color: colorOf("#2a2824"), opacity: 0.18,
            });
        }

        // Waterline → submerged-region calculation is the same regardless
        // of mode; pull it out of the two branches below so we don't do
        // the toScreen() conversion twice per pier per frame.
        const waterWorldY = Math.max(lY, rY) + TABLE_DEPTH * 0.36;
        const waterScreen = toScreen(lX, waterWorldY);
        const submergedStart = Math.max(topY, waterScreen.y);

        // Build-mode underwater dim — subtler than the sim-mode tint, just a
        // soft cool overlay on the submerged portion of the rock so the
        // waterline reads consistently with the screen-wide marker line.
        if (state.mode === "build") {
            if (submergedStart < botY) {
                for (let y = submergedStart; y < botY; y += sliceH) {
                    const t = Math.min(1, (y - topY) / (botY - topY));
                    const halfW = lerp(topHalfW, botHalfW, t);
                    k.drawRect({
                        pos: k.vec2(screenTop.x - halfW, y),
                        width: halfW * 2, height: sliceH + 0.5,
                        color: colorOf("#2a4f7a"),
                        anchor: "topleft", opacity: 0.18,
                    });
                }
            }
        }

        // Underwater tint — only when the sim is running (water is drawn).
        // Two passes: a heavier blue overlay tints the stone toward the water
        // hue, then a darken pass deepens the lower portion. Together they
        // sell "we're looking at this through several feet of water".
        if (state.mode !== "build") {
            if (submergedStart < botY) {
                for (let y = submergedStart; y < botY; y += sliceH) {
                    const t  = Math.min(1, (y - topY) / (botY - topY));
                    const halfW = lerp(topHalfW, botHalfW, t);
                    const depth = (y - submergedStart) / Math.max(1, botY - submergedStart);
                    // Hue shift — strong at the surface, even stronger deep
                    k.drawRect({
                        pos: k.vec2(screenTop.x - halfW, y),
                        width: halfW * 2, height: sliceH + 0.5,
                        color: colorOf("#3b6d9e"),
                        anchor: "topleft", opacity: 0.55 + 0.15 * depth,
                    });
                    // Darken-with-depth pass — deeper water swallows light
                    k.drawRect({
                        pos: k.vec2(screenTop.x - halfW, y),
                        width: halfW * 2, height: sliceH + 0.5,
                        color: colorOf("#0a1530"),
                        anchor: "topleft", opacity: 0.10 + 0.30 * depth,
                    });
                }
            }

            // Re-draw the animated wave strip ON TOP of the rock so the wave
            // visibly passes IN FRONT of the pillar at the surface — gives the
            // 3D illusion that the rock is sticking up out of the water rather
            // than pasted on top. Tiles align with drawWater's grid so the
            // animation reads as one continuous strip.
            try {
                const tileW = 16 * sc * 1.5;
                const tileH = 16 * sc * 1.5;
                const frame = Math.floor(waterFrame) % 32;
                const rockLeft  = screenTop.x - topHalfW - tileW;
                const rockRight = screenTop.x + topHalfW + tileW;
                const startTx = Math.floor(rockLeft / tileW) * tileW;
                const tileY = waterScreen.y - tileH * 0.4;
                for (let tx = startTx; tx < rockRight; tx += tileW) {
                    k.drawSprite({
                        sprite: "water_tile",
                        frame,
                        pos: k.vec2(tx, tileY),
                        width: tileW + 1,
                        height: tileH,
                        anchor: "topleft",
                    });
                }
            } catch (e) { /* sprite not loaded yet */ }
        }
    }

    // Draw a steel tower mast rising from the cliff top to a high anchor point.
    // Used whenever an extraAnchor sits above the cliff edge (dy < 0).
    function drawCliffTower(ax, ay, cliffY, sc) {
        const base = toScreen(ax, cliffY);
        const tip  = toScreen(ax, ay);
        const h    = base.y - tip.y;
        const mW   = 7 * sc;

        // Body
        k.drawRect({ pos: k.vec2(base.x - mW / 2, tip.y), width: mW, height: h, color: colorOf("#3a3a3a"), anchor: "topleft" });
        // Highlight stripe (left face)
        k.drawRect({ pos: k.vec2(base.x - mW / 2, tip.y), width: mW * 0.3, height: h, color: colorOf("#585858"), opacity: 0.8, anchor: "topleft" });
        // Cross-bracing marks
        const steps = Math.max(2, Math.floor(h / (18 * sc)));
        for (let i = 1; i < steps; i++) {
            const yy = tip.y + (h * i) / steps;
            k.drawLine({ p1: k.vec2(base.x - mW * 0.5, yy), p2: k.vec2(base.x + mW * 0.5, yy), width: sc, color: colorOf("#606060"), opacity: 0.6 });
        }
        // Cap plate at top
        const capW = mW * 2.4, capH = Math.max(3, mW * 0.55);
        k.drawRect({ pos: k.vec2(tip.x - capW / 2, tip.y - capH / 2), width: capW, height: capH, color: colorOf("#282828"), anchor: "topleft" });
    }

    function drawGround(wx1, wx2, wy, sc, side) {
        // Asphalt is drawn CENTERED on the anchor line (half above, half below)
        // so its top aligns with the top of a wood_road plank on the bridge
        // (plank center at wy, half-width 5). The car's drivable surface therefore
        // reads as a single continuous line across approach and bridge.
        const HALF_ROAD = ROAD_H / 2;
        const roadTop = toScreen(wx1, wy - HALF_ROAD);
        const roadBot = toScreen(wx2, wy + HALF_ROAD);
        const cliffBot = toScreen(wx2, wy + TABLE_DEPTH);
        const w = roadBot.x - roadTop.x;
        const roadH = Math.max(roadBot.y - roadTop.y, 6 * sc);
        const cliffH = cliffBot.y - roadBot.y;

        // ── Asphalt road surface ──
        k.drawRect({ pos: roadTop, width: w, height: roadH, color: colorOf("#3a3a3a"), anchor: "topleft" });
        // Dashed yellow line — drawn right at the driving surface (top edge of
        // the asphalt) so the "stand on the yellow line" visual holds.
        const lineY = roadTop.y + Math.max(1, 1.5 * sc);
        const dashW = 12 * sc;
        const gapW = 8 * sc;
        for (let dx = 0; dx < w; dx += dashW + gapW) {
            // Clip the final dash to the road width so it doesn't hang out
            // over the cliff edge when the road length isn't a clean multiple
            // of (dash + gap).
            const segW = Math.min(dashW, w - dx);
            k.drawRect({ pos: k.vec2(roadTop.x + dx, lineY - 1), width: segW, height: Math.max(2, 1.5 * sc), color: colorOf("#e8c840"), anchor: "topleft", opacity: 0.7 });
        }
        // Subtle top highlight
        k.drawRect({ pos: roadTop, width: w, height: Math.max(1, 1.5 * sc), color: colorOf("#ffffff"), anchor: "topleft", opacity: 0.12 });

        // ── Grass strip (thin green edge between road and dirt) ──
        const grassH = Math.max(3, 6 * sc);
        k.drawRect({ pos: k.vec2(roadTop.x, roadBot.y), width: w, height: grassH, color: colorOf("#4a8c3f"), anchor: "topleft" });
        // Lighter grass tuft line on top edge
        k.drawRect({ pos: k.vec2(roadTop.x, roadBot.y), width: w, height: Math.max(1, 2 * sc), color: colorOf("#6ab854"), anchor: "topleft", opacity: 0.7 });

        // ── Dark dirt layer ──
        const darkDirtH = cliffH * 0.35;
        k.drawRect({ pos: k.vec2(roadTop.x, roadBot.y + grassH), width: w, height: darkDirtH, color: colorOf("#4a3822"), anchor: "topleft" });

        // ── Light dirt / sandy layer ──
        const lightDirtY = roadBot.y + grassH + darkDirtH;
        const lightDirtH = cliffH - grassH - darkDirtH;
        k.drawRect({ pos: k.vec2(roadTop.x, lightDirtY), width: w, height: lightDirtH, color: colorOf("#8b7355"), anchor: "topleft" });
        // Subtle rock lines
        const rockStep = Math.max(10, 20 * sc);
        for (let py = lightDirtY + rockStep; py < cliffBot.y; py += rockStep)
            k.drawLine({ p1: k.vec2(roadTop.x, py), p2: k.vec2(roadTop.x + w, py), width: 1, color: colorOf("#010101"), opacity: 0.06 });

        // ── Extend dirt to screen bottom ──
        const screenBot = k.height();
        const remainH = screenBot - cliffBot.y;
        if (remainH > 0) {
            k.drawRect({ pos: k.vec2(roadTop.x, cliffBot.y), width: w, height: remainH, color: colorOf("#5a4030"), anchor: "topleft" });
        }

        // ── Cliff inner edge shadow ──
        // "left" cliff approach faces a gap on the right → shadow on right.
        // "right" approach faces a gap on the left → shadow on left.
        // "both" is for free-standing mid-land — gaps on both sides.
        const shadowH = darkDirtH + lightDirtH + remainH;
        const shadowY = roadBot.y + grassH;
        if (side === "left" || side === "both") {
            k.drawRect({ pos: k.vec2(roadTop.x + w - 2, shadowY), width: 3, height: shadowH, color: colorOf("#010101"), anchor: "topleft", opacity: 0.12 });
        }
        if (side === "right" || side === "both") {
            k.drawRect({ pos: k.vec2(roadTop.x, shadowY), width: 3, height: shadowH, color: colorOf("#010101"), anchor: "topleft", opacity: 0.12 });
        }
    }

    // ─── Water in the gap (sim/end mode only) ────────
    function drawWater(W, H, sc) {
        if (state.mode === "build") {
            // Build-mode waterline marker — a subtle horizontal line at the
            // water surface plus a faint blue dim below it. Helps the player
            // see where the water level will be without obscuring the layout.
            const waterWorldY = Math.max(lY, rY) + TABLE_DEPTH * 0.36;
            const waterY = toScreen(lX, waterWorldY).y;
            // Dim band underneath — kept low-opacity so beams stay readable.
            k.drawRect({
                pos: k.vec2(0, waterY),
                width: W, height: H - waterY,
                color: colorOf("#2a4f7a"),
                anchor: "topleft", opacity: 0.12,
            });
            // Thin marker line at the surface.
            k.drawLine({
                p1: k.vec2(0, waterY), p2: k.vec2(W, waterY),
                width: 1, color: colorOf("#3b6d9e"), opacity: 0.55,
            });
            return;
        }

        // Wave animation also keys off sim speed — keeps the surface ripples
        // in lockstep with everything else when the player fast-forwards.
        waterFrame += 0.08 * state.simSpeed;
        const frame = Math.floor(waterFrame) % 32;

        // Water surface position
        const waterWorldY = Math.max(lY, rY) + TABLE_DEPTH * 0.36;
        const waterScreen = toScreen(lX, waterWorldY);
        const waterY = waterScreen.y;
        const tileW = 16 * sc * 1.5;
        const tileH = 16 * sc * 1.5;

        // Solid fill from just below the wave sprite to screen bottom
        k.drawRect({ pos: k.vec2(0, waterY + tileH * 0.4), width: W, height: H - waterY, color: colorOf("#3b6d9e"), anchor: "topleft" });
        // (Wave tile strip is drawn separately via drawWaterSurface so it can
        // overlay submerged bridge pieces.)

        // Subtle darker bands below surface for depth
        const bandStart = waterY + tileH * 0.6;
        for (let wy = bandStart; wy < H; wy += 25) {
            const bandOp = 0.04 + Math.sin(wy * 0.02 + waterFrame * 0.3) * 0.02;
            k.drawRect({ pos: k.vec2(0, wy), width: W, height: 10, color: colorOf("#2a5a8a"), anchor: "topleft", opacity: bandOp });
        }

        // ── Fish (stateful) ──
        // Positions are remembered frame-to-frame so fish can turn around when
        // they approach a mid-gap rock instead of swimming straight through it.
        if (!state._fish) {
            // speed is in pixels per SECOND (multiplied by dt below). The
            // original mathematical fish drifted at ~60 px/sec; staying close
            // to that so they feel like they're idling, not racing.
            state._fish = [
                { x: 80,      yOff: 40, dir:  1, phase: 0,   speed: 55 },
                { x: W - 80,  yOff: 60, dir: -1, phase: 2.1, speed: 42 },
            ];
        }
        const fishFrame = Math.floor(waterFrame * 0.5) % 10;
        const fishSz = 16 * sc;
        const dt = k.dt() || 1 / 60;

        // Mid-gap rock positions (screen X + rock half-width at the fish's Y).
        const rockBlocks = [];
        for (const n of state.nodes) {
            if (!n.fixed || n.builtin) continue;
            if (n.x <= lX || n.x >= rX) continue;
            const rockTop = toScreen(n.x, n.y);
            // Match drawMidPier's taper math so "close to rock" is accurate at
            // the fish's actual depth.
            const topHalfW = 22 * sc;
            const botHalfW = 52 * sc;
            rockBlocks.push({ topY: rockTop.y - 4 * sc, botY: H + 20, cx: rockTop.x, topHalfW, botHalfW });
        }
        const rockHalfAt = (r, y) => {
            const t = Math.max(0, Math.min(1, (y - r.topY) / (r.botY - r.topY)));
            return r.topHalfW + (r.botHalfW - r.topHalfW) * t;
        };

        try {
            for (const f of state._fish) {
                // Update position — speed is px/sec, dt is seconds.
                f.x += f.dir * f.speed * dt;
                // Wrap around the screen edges (with a margin so the fish
                // slides off and back on cleanly).
                if (f.dir > 0 && f.x > W + 60) f.x = -60;
                if (f.dir < 0 && f.x < -60)    f.x = W + 60;

                const fy = waterY + f.yOff * sc + Math.sin(waterFrame * 0.8 + f.phase) * 6;

                // Turn around if the fish is about to swim into a rock pier.
                for (const r of rockBlocks) {
                    const half = rockHalfAt(r, fy);
                    const clearance = 18 * sc;                // turn-around distance
                    const approaching = f.dir > 0 ? (f.x < r.cx && f.x > r.cx - half - clearance)
                                                  : (f.x > r.cx && f.x < r.cx + half + clearance);
                    if (approaching) {
                        f.dir *= -1;
                        // Nudge the fish away so it doesn't immediately flip back.
                        f.x += f.dir * 2;
                        break;
                    }
                }

                k.drawSprite({
                    sprite: "fish",
                    frame: (fishFrame + Math.round(f.phase * 2)) % 10,
                    pos: k.vec2(f.x, fy),
                    width: fishSz,
                    height: fishSz,
                    anchor: "center",
                    // Sprite faces RIGHT by default — flip when swimming left.
                    flipX: f.dir < 0,
                });
            }
        } catch(e) {}
    }

    // Draw just the animated wave tile surface — called AFTER submerged members
    // so waves overlay any bridge pieces dipping into the water, instead of
    // being hidden behind them.
    function drawWaterSurface(W, sc) {
        if (state.mode === "build") return;
        const waterWorldY = Math.max(lY, rY) + TABLE_DEPTH * 0.36;
        const waterY = toScreen(lX, waterWorldY).y;
        const tileW = 16 * sc * 1.5;
        const tileH = 16 * sc * 1.5;
        const frame = Math.floor(waterFrame) % 32;
        try {
            for (let tx = -tileW; tx < W + tileW; tx += tileW) {
                k.drawSprite({
                    sprite: "water_tile",
                    frame,
                    pos: k.vec2(tx, waterY - tileH * 0.4),
                    width: tileW + 1,
                    height: tileH,
                    anchor: "topleft",
                });
            }
        } catch (e) {}
    }

    // ─── Splash effects ─────────────────────────────
    function drawSplashes(sc) {
        for (const s of state.splashes) {
            const p = toScreen(s.x, s.y);
            const splashSz = 24 * sc;
            try {
                k.drawSprite({
                    sprite: "splash",
                    frame: Math.min(s.frame, 17),
                    pos: k.vec2(p.x, p.y - splashSz * 0.3),
                    width: splashSz,
                    height: splashSz,
                    anchor: "center",
                });
            } catch(e) {}
            // Small ripple ring
            if (s.timer < 4) {
                const t = s.timer;
                k.drawCircle({ pos: p, radius: t * 8 * sc, fill: false, outline: { width: 1, color: colorOf("#ffffff") }, opacity: Math.max(0, 0.4 - t / 5) });
            }
        }
    }

    // ─── Members ─────────────────────────────────────
    // `layer` selects which subset to draw:
    //   "roads"      — road planks only (drawn before vehicles, so the car sits on top)
    //   "structural" — non-road beams only (drawn after vehicles for a 3D-truss feel)
    //   "all"        — everything (default; build mode and other safe contexts)
    function drawMembers(sc, layer = "all") {
        const wantRoad = (m) => MATERIALS[m.type].isRoad;
        // Water surface (mirrors drawWater's math). Structural members get
        // CLIPPED at this line: the above-water portion draws after the water
        // layer, the submerged portion draws before it. So a beam dangling
        // halfway into the water shows only its upper half.
        const waterY = Math.max(lY, rY) + TABLE_DEPTH * 0.36;

        // Returns effective endpoints {x1,y1,x2,y2} for this layer, or null
        // if the member shouldn't render in this pass.
        // Road members get water-clipped too — when a fallen plank dips below
        // the surface, its submerged portion shows up in "structural-submerged"
        // (where the underwater tint is applied) instead of being hidden by
        // the opaque water rect.
        function clipForLayer(m) {
            const a = m.n1, b = m.n2;
            if (layer === "all") return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };

            const aSub = a.y >= waterY;
            const bSub = b.y >= waterY;
            const isRoad = wantRoad(m);

            // Both endpoints below water → only the submerged layer renders.
            if (aSub && bSub) {
                return layer === "structural-submerged"
                    ? { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
                    : null;
            }
            // Both endpoints above water → roads pass for road members,
            // structural pass for everything else.
            if (!aSub && !bSub) {
                if (isRoad) return layer === "roads" ? { x1: a.x, y1: a.y, x2: b.x, y2: b.y } : null;
                return layer === "structural" ? { x1: a.x, y1: a.y, x2: b.x, y2: b.y } : null;
            }
            // Member crosses the waterline — clip at waterY into above/below halves.
            const t = (waterY - a.y) / (b.y - a.y);
            const ix = a.x + t * (b.x - a.x);
            const iy = waterY;
            const above = isRoad ? "roads" : "structural";
            if (layer === above) {
                const top = aSub ? b : a;                          // above-water endpoint
                return { x1: top.x, y1: top.y, x2: ix, y2: iy };
            }
            if (layer === "structural-submerged") {
                const bot = aSub ? a : b;                          // below-water endpoint
                return { x1: bot.x, y1: bot.y, x2: ix, y2: iy };
            }
            return null;
        }

        // Squared threshold for the per-member delete-hover check below.
        // Computed once per drawMembers call so we never recompute for each
        // member. Inputs (mouseWorld, sc) are stable for the duration of
        // this draw pass.
        const _delThreshSq = (12 / sc) * (12 / sc);
        const _mwx = state.mouseWorld.x;
        const _mwy = state.mouseWorld.y;

        // Helper: get member color (stress-based in sim, material color in build)
        function getMemberColor(m) {
            const mat = MATERIALS[m.type];
            // Steel beams are already red (their material color) — overlaying
            // a red stress tint on top is redundant and washes out the look,
            // so keep steel rendered in its material color even in sim mode.
            if (m.type === "steel") {
                if (state.delMode && distToSegmentSq(_mwx, _mwy, m.n1, m.n2) < _delThreshSq) return C.danger;
                return mat.color;
            }
            if ((state.mode === "sim" || state.mode === "end") && state.showStress) {
                const s = Math.min(1, m.stress);
                if (s < 0.15) return C.stressLow;
                if (s < 0.50) return C.stressMid;
                return C.stressHigh;
            }
            if (state.delMode && distToSegmentSq(_mwx, _mwy, m.n1, m.n2) < _delThreshSq) return C.danger;
            return mat.color;
        }

        // Draw joint fills for road segments (skip broken). Above-water joints
        // render in the "roads" pass; submerged joints render in the
        // "structural-submerged" pass with the same blue/dark tint as members.
        if (layer === "roads" || layer === "structural-submerged" || layer === "all") {
            for (const m of state.members) {
                if (!MATERIALS[m.type].isRoad || m.broken) continue;
                const mat = MATERIALS[m.type];
                const r = mat.width * sc * 0.5;
                const col = colorOf(getMemberColor(m));
                for (const n of [m.n1, m.n2]) {
                    const submerged = n.y >= waterY;
                    if (layer === "roads" && submerged) continue;
                    if (layer === "structural-submerged" && !submerged) continue;
                    const p = toScreen(n.x, n.y);
                    if (n.fixed) {
                        if (state.mode === "build" && layer !== "structural-submerged") {
                            k.drawRect({ pos: k.vec2(p.x - r, p.y - r), width: r * 2, height: r * 2, color: col, anchor: "topleft" });
                        }
                    } else if (state.mode !== "build") {
                        k.drawCircle({ pos: p, radius: r, color: col });
                        if (submerged) {
                            // Match the underwater tint applied to submerged members
                            k.drawCircle({ pos: p, radius: r, color: colorOf("#3b6d9e"), opacity: 0.55 });
                            k.drawCircle({ pos: p, radius: r, color: colorOf("#0a1530"), opacity: 0.20 });
                        }
                    }
                }
            }
        }

        for (const m of state.members) {
            const clip = clipForLayer(m);
            if (!clip) continue;
            const p1 = toScreen(clip.x1, clip.y1);
            const p2 = toScreen(clip.x2, clip.y2);
            const mat = MATERIALS[m.type];
            const w = mat.width * sc;
            const dx = p2.x - p1.x, dy = p2.y - p1.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            // Normal vector (perpendicular to member, scaled)
            const nx = -dy / len, ny = dx / len;

            // Skip all broken members — the visible halves are the UNBROKEN segments
            if (m.broken) continue;

            if (m.builtin) {
                k.drawLine({ p1, p2, width: w * 1.2, color: colorOf("#7a5520") });
                continue;
            }

            const color = getMemberColor(m);
            const opacity = 1;
            const col = colorOf(color);

            if (m.type === "wood_road") {
                // ── WOOD ROAD — chunky plank with grain lines ──
                // Main plank body
                k.drawLine({ p1, p2, width: w, color: col, opacity });
                // Pixel art edge lines (top and bottom of plank)
                const edgeOff = w * 0.4;
                k.drawLine({
                    p1: k.vec2(p1.x + nx * edgeOff, p1.y + ny * edgeOff),
                    p2: k.vec2(p2.x + nx * edgeOff, p2.y + ny * edgeOff),
                    width: 1, color: colorOf("#c4943c"), opacity: 0.5 * opacity,
                });
                k.drawLine({
                    p1: k.vec2(p1.x - nx * edgeOff, p1.y - ny * edgeOff),
                    p2: k.vec2(p2.x - nx * edgeOff, p2.y - ny * edgeOff),
                    width: 1, color: colorOf("#7a5520"), opacity: 0.4 * opacity,
                });
                // Wood grain notches along length
                const grainSpacing = Math.max(8, 12 * sc);
                const grainW = w * 0.25;
                for (let t = grainSpacing; t < len - 4; t += grainSpacing) {
                    const gx = p1.x + (dx / len) * t;
                    const gy = p1.y + (dy / len) * t;
                    k.drawLine({
                        p1: k.vec2(gx + nx * grainW, gy + ny * grainW),
                        p2: k.vec2(gx - nx * grainW, gy - ny * grainW),
                        width: 1, color: colorOf("#7a5520"), opacity: 0.25 * opacity,
                    });
                }

            } else if (m.type === "wood_beam") {
                // ── WOOD BEAM — with cross marks ──
                k.drawLine({ p1, p2, width: w, color: col, opacity });
                // Highlight stripe
                k.drawLine({
                    p1: k.vec2(p1.x + nx * w * 0.2, p1.y + ny * w * 0.2),
                    p2: k.vec2(p2.x + nx * w * 0.2, p2.y + ny * w * 0.2),
                    width: 1, color: colorOf("#EDD8B7"), opacity: 0.5 * opacity,
                });
                // Cross marks every ~20px
                const crossSp = Math.max(14, 20 * sc);
                const crossW = w * 0.35;
                for (let t = crossSp; t < len - 4; t += crossSp) {
                    const cx = p1.x + (dx / len) * t;
                    const cy = p1.y + (dy / len) * t;
                    // Small X
                    k.drawLine({
                        p1: k.vec2(cx - 1.5, cy - 1.5), p2: k.vec2(cx + 1.5, cy + 1.5),
                        width: 1, color: colorOf("#C49A6C"), opacity: 0.3 * opacity,
                    });
                    k.drawLine({
                        p1: k.vec2(cx + 1.5, cy - 1.5), p2: k.vec2(cx - 1.5, cy + 1.5),
                        width: 1, color: colorOf("#C49A6C"), opacity: 0.3 * opacity,
                    });
                }

            } else if (m.type === "steel") {
                // ── STEEL — solid red beam with rivet dots, no shine line ──
                const bw = Math.max(w, 3);
                // Main beam
                k.drawLine({ p1, p2, width: bw, color: col, opacity });
                // Top/bottom flange shading — darker reds, no metallic blues
                const flangeOff = bw * 0.4;
                k.drawLine({
                    p1: k.vec2(p1.x + nx * flangeOff, p1.y + ny * flangeOff),
                    p2: k.vec2(p2.x + nx * flangeOff, p2.y + ny * flangeOff),
                    width: 1.5, color: colorOf("#e06060"), opacity: 0.55 * opacity,
                });
                k.drawLine({
                    p1: k.vec2(p1.x - nx * flangeOff, p1.y - ny * flangeOff),
                    p2: k.vec2(p2.x - nx * flangeOff, p2.y - ny * flangeOff),
                    width: 1.5, color: colorOf("#7a2020"), opacity: 0.6 * opacity,
                });
                // Rivet dots — small dark-red squares evenly spaced
                const rivetSp = Math.max(10, 16 * sc);
                for (let t = rivetSp * 0.5; t < len; t += rivetSp) {
                    const rx = p1.x + (dx / len) * t;
                    const ry = p1.y + (dy / len) * t;
                    k.drawRect({ pos: k.vec2(rx - 1, ry - 1), width: 2, height: 2, color: colorOf("#5a1010"), opacity: 0.6 * opacity, anchor: "topleft" });
                }

            } else if (m.type === "reinforced_road") {
                // ── REINFORCED ROAD — dark plank with steel rivets ──
                k.drawLine({ p1, p2, width: w, color: col, opacity });
                // Steel plate edge lines
                const edgeOff = w * 0.4;
                k.drawLine({
                    p1: k.vec2(p1.x + nx * edgeOff, p1.y + ny * edgeOff),
                    p2: k.vec2(p2.x + nx * edgeOff, p2.y + ny * edgeOff),
                    width: 1, color: colorOf("#a08050"), opacity: 0.5 * opacity,
                });
                k.drawLine({
                    p1: k.vec2(p1.x - nx * edgeOff, p1.y - ny * edgeOff),
                    p2: k.vec2(p2.x - nx * edgeOff, p2.y - ny * edgeOff),
                    width: 1, color: colorOf("#4a3018"), opacity: 0.4 * opacity,
                });
                // Steel rivet dots along length
                const rivetSp = Math.max(8, 12 * sc);
                for (let t = rivetSp * 0.5; t < len; t += rivetSp) {
                    const rx = p1.x + (dx / len) * t;
                    const ry = p1.y + (dy / len) * t;
                    k.drawRect({ pos: k.vec2(rx - 1, ry - 1), width: 2.5, height: 2.5, color: colorOf("#b0b0b0"), opacity: 0.6 * opacity, anchor: "topleft" });
                }
                // Steel reinforcement stripe down center
                k.drawLine({ p1, p2, width: 1.5, color: colorOf("#a8b4c0"), opacity: 0.35 * opacity });

            } else if (m.type === "stone_road") {
                // ── STONE ROAD — gray slab with masonry joints ──
                k.drawLine({ p1, p2, width: w, color: col, opacity });
                // Top/bottom edge highlights
                const edgeOff = w * 0.42;
                k.drawLine({
                    p1: k.vec2(p1.x + nx * edgeOff, p1.y + ny * edgeOff),
                    p2: k.vec2(p2.x + nx * edgeOff, p2.y + ny * edgeOff),
                    width: 1, color: colorOf("#b8b8b8"), opacity: 0.4 * opacity,
                });
                k.drawLine({
                    p1: k.vec2(p1.x - nx * edgeOff, p1.y - ny * edgeOff),
                    p2: k.vec2(p2.x - nx * edgeOff, p2.y - ny * edgeOff),
                    width: 1, color: colorOf("#5a5a5a"), opacity: 0.4 * opacity,
                });
                // Masonry joint lines (perpendicular hash marks)
                const jointSp = Math.max(10, 14 * sc);
                const jointW = w * 0.4;
                for (let t = jointSp; t < len - 4; t += jointSp) {
                    const jx = p1.x + (dx / len) * t;
                    const jy = p1.y + (dy / len) * t;
                    k.drawLine({
                        p1: k.vec2(jx + nx * jointW, jy + ny * jointW),
                        p2: k.vec2(jx - nx * jointW, jy - ny * jointW),
                        width: 1, color: colorOf("#4a4a4a"), opacity: 0.3 * opacity,
                    });
                }

            } else if (m.type === "rope") {
                // ── ROPE — twisted hemp look, sags as a catenary when slack ──
                // Sag amount: rope slack length translated into screen-space drop
                const _rdx = m.n2.x - m.n1.x, _rdy = m.n2.y - m.n1.y;
                const curDist = Math.sqrt(_rdx * _rdx + _rdy * _rdy);
                const slackWorld = Math.max(0, m.rest - curDist);
                const sagPx = Math.min(40 * sc, slackWorld * sc * 0.55);

                // Build the rope path as a polyline along the catenary
                const segs = Math.max(10, Math.floor(len / 7));
                const pts = new Array(segs + 1);
                for (let i = 0; i <= segs; i++) {
                    const tt = i / segs;
                    const lx = p1.x + (p2.x - p1.x) * tt;
                    const ly = p1.y + (p2.y - p1.y) * tt;
                    const drop = sagPx * 4 * tt * (1 - tt);   // parabola, max at midpoint
                    pts[i] = k.vec2(lx, ly + drop);
                }

                const rw = Math.max(w, 3);
                // Dark shadow stroke
                for (let i = 0; i < segs; i++) {
                    k.drawLine({ p1: pts[i], p2: pts[i + 1], width: rw + 1.5, color: colorOf("#3a2a06"), opacity: 0.45 * opacity });
                }
                // Main rope body
                for (let i = 0; i < segs; i++) {
                    k.drawLine({ p1: pts[i], p2: pts[i + 1], width: rw, color: col, opacity });
                }
                // Braid marks — small diagonal slashes giving the twist texture
                const braidSp = Math.max(6, 8 * sc);
                for (let t = braidSp * 0.5; t < len; t += braidSp) {
                    const tt = Math.min(1, t / len);
                    const idx = Math.floor(tt * segs);
                    if (idx >= pts.length - 1) continue;
                    const a = pts[idx], b = pts[idx + 1];
                    const segDx = b.x - a.x, segDy = b.y - a.y;
                    const segLen = Math.sqrt(segDx * segDx + segDy * segDy) || 1;
                    const sLocal = (t - idx * (len / segs)) / segLen;
                    const cx = a.x + segDx * sLocal;
                    const cy = a.y + segDy * sLocal;
                    const sNx = -segDy / segLen, sNy = segDx / segLen;
                    const r = rw * 0.5;
                    k.drawLine({
                        p1: k.vec2(cx + sNx * r - segDx / segLen * 1.2, cy + sNy * r - segDy / segLen * 1.2),
                        p2: k.vec2(cx - sNx * r + segDx / segLen * 1.2, cy - sNy * r + segDy / segLen * 1.2),
                        width: 0.9, color: colorOf("#3a2a06"), opacity: 0.45 * opacity,
                    });
                }
                // Endpoint loops — only at actual chain ends (skip interior chain joints)
                if (!m.n1._chainNode) {
                    k.drawCircle({ pos: pts[0], radius: rw * 0.7 + 0.5, color: colorOf("#3a2a06"), opacity: 0.55 * opacity });
                    k.drawCircle({ pos: pts[0], radius: rw * 0.55, color: col, opacity });
                }
                if (!m.n2._chainNode) {
                    k.drawCircle({ pos: pts[segs], radius: rw * 0.7 + 0.5, color: colorOf("#3a2a06"), opacity: 0.55 * opacity });
                    k.drawCircle({ pos: pts[segs], radius: rw * 0.55, color: col, opacity });
                }

            } else if (m.type === "cable") {
                // ── STEEL CABLE — sleek dark metallic line with sheen ──
                const _cdx = m.n2.x - m.n1.x, _cdy = m.n2.y - m.n1.y;
                const curDist = Math.sqrt(_cdx * _cdx + _cdy * _cdy);
                const slackWorld = Math.max(0, m.rest - curDist);
                // Cable is much stiffer than rope visually — small sag only
                const sagPx = Math.min(20 * sc, slackWorld * sc * 0.35);

                const segs = Math.max(8, Math.floor(len / 8));
                const pts = new Array(segs + 1);
                for (let i = 0; i <= segs; i++) {
                    const tt = i / segs;
                    const lx = p1.x + (p2.x - p1.x) * tt;
                    const ly = p1.y + (p2.y - p1.y) * tt;
                    const drop = sagPx * 4 * tt * (1 - tt);
                    pts[i] = k.vec2(lx, ly + drop);
                }

                const cw = Math.max(w, 2);
                // Dark outline
                for (let i = 0; i < segs; i++) {
                    k.drawLine({ p1: pts[i], p2: pts[i + 1], width: cw + 1.2, color: colorOf("#1a1a1a"), opacity: 0.45 * opacity });
                }
                // Main cable
                for (let i = 0; i < segs; i++) {
                    k.drawLine({ p1: pts[i], p2: pts[i + 1], width: cw, color: col, opacity });
                }
                // Sheen highlight along the top edge of each segment
                for (let i = 0; i < segs; i++) {
                    const segDx = pts[i + 1].x - pts[i].x, segDy = pts[i + 1].y - pts[i].y;
                    const segLen = Math.sqrt(segDx * segDx + segDy * segDy) || 1;
                    const offX = -segDy / segLen * (cw * 0.25);
                    const offY = segDx / segLen * (cw * 0.25);
                    k.drawLine({
                        p1: k.vec2(pts[i].x + offX, pts[i].y + offY),
                        p2: k.vec2(pts[i + 1].x + offX, pts[i + 1].y + offY),
                        width: 0.8, color: colorOf("#9aa0a8"), opacity: 0.55 * opacity,
                    });
                }
                // End clamps — only at actual chain ends (skip interior joints)
                if (!m.n1._chainNode) {
                    k.drawRect({ pos: k.vec2(pts[0].x - 2.2, pts[0].y - 2.2), width: 4.4, height: 4.4, color: colorOf("#1a1a1a"), opacity: 0.7 * opacity, anchor: "topleft" });
                    k.drawRect({ pos: k.vec2(pts[0].x - 1.6, pts[0].y - 1.6), width: 3.2, height: 3.2, color: col, opacity, anchor: "topleft" });
                }
                if (!m.n2._chainNode) {
                    k.drawRect({ pos: k.vec2(pts[segs].x - 2.2, pts[segs].y - 2.2), width: 4.4, height: 4.4, color: colorOf("#1a1a1a"), opacity: 0.7 * opacity, anchor: "topleft" });
                    k.drawRect({ pos: k.vec2(pts[segs].x - 1.6, pts[segs].y - 1.6), width: 3.2, height: 3.2, color: col, opacity, anchor: "topleft" });
                }
            }

            // Underwater tint — only for the submerged layer. Overlay a
            // translucent water-blue stripe along the member, plus a slight
            // darken pass, matching the rock pier's "seen through water"
            // vocabulary so fallen pieces read as drowned rather than missing.
            if (layer === "structural-submerged") {
                const overlayW = Math.max(w, 3) + 1;
                k.drawLine({ p1, p2, width: overlayW, color: colorOf("#3b6d9e"), opacity: 0.55 });
                k.drawLine({ p1, p2, width: overlayW, color: colorOf("#0a1530"), opacity: 0.20 });
            }
        }

        // ── Draw joint dots at free nodes (build-mode only — they clash with
        //     vehicles and road art during simulation) ──
        if (state.mode === "build") {
            for (const m of state.members) {
                if (m.builtin) continue;
                const r = 2 * sc;
                for (const n of [m.n1, m.n2]) {
                    if (n.fixed) continue;
                    if (n._chainNode) continue;  // chain joints don't get the dark dot
                    const p = toScreen(n.x, n.y);
                    k.drawRect({ pos: k.vec2(p.x - r, p.y - r), width: r * 2, height: r * 2, color: colorOf("#5a4a30"), anchor: "topleft" });
                }
            }
        }
    }

    // ─── Ghost beam while dragging ──────────────────
    function drawGhostBeam(sc) {
        if (!state.dragging || !state.dragStart || state.mode !== "build") return;
        const sn = snapForBuild(state.mouseWorld.x, state.mouseWorld.y);
        const st = state.dragStart;
        if (sn.x === st.x && sn.y === st.y) return;

        const d = Math.hypot(sn.x - st.x, sn.y - st.y);
        const mat = MATERIALS[state.selectedMat];
        // In LINE mode, road placements must land on an existing node — mirror
        // of the commit-time check. Single-segment road placements are free to
        // extend to a fresh grid point.
        const roadEndOk = !(mat.isRoad && state.lineMode) || !!state.nodes.find(n => n.x === sn.x && n.y === sn.y);
        const ok = d > 5 && (state.lineMode ? d > GRID : d <= mat.maxLength) && roadEndOk;

        const p1 = toScreen(st.x, st.y);
        const p2 = toScreen(sn.x, sn.y);

        // Range circle (only for straight mode) — dashed white perimeter
        // that rotates so dashes drift right→left across the top, giving
        // the build radius a subtle "live" feel.
        if (!state.lineMode) {
            const ringR = mat.maxLength * sc;
            const ringCol = colorOf(ok ? "#ffffff" : C.danger);
            const dashLen = 8;       // arc length per dash (screen px)
            const gapLen  = 6;       // arc length per gap (screen px)
            const period  = dashLen + gapLen;
            const segCount = Math.max(24, Math.round((2 * Math.PI * ringR) / 4));
            // Phase advances clockwise; subtracting flips the visual flow so
            // dashes travel counter-clockwise (right→left across the top).
            const phase = -k.time() * 30;
            for (let i = 0; i < segCount; i++) {
                const t1 = i / segCount;
                const t2 = (i + 1) / segCount;
                const a1 = t1 * Math.PI * 2;
                const a2 = t2 * Math.PI * 2;
                // Distance along perimeter to this segment's midpoint
                const arcMid = ((t1 + t2) / 2) * 2 * Math.PI * ringR;
                const m = ((arcMid + phase) % period + period) % period;
                if (m > dashLen) continue;        // in the gap
                k.drawLine({
                    p1: k.vec2(p1.x + Math.cos(a1) * ringR, p1.y + Math.sin(a1) * ringR),
                    p2: k.vec2(p1.x + Math.cos(a2) * ringR, p1.y + Math.sin(a2) * ringR),
                    width: 1.2,
                    color: ringCol,
                    opacity: 0.55,
                });
            }
        }

        // Ghost beam — line fill preview or single segment
        if (state.lineMode && d > GRID) {
            const linePts = getLinePoints(st.x, st.y, sn.x, sn.y);
            const ghostCol = colorOf(ok ? C.accent : C.danger);
            for (let li = 0; li < linePts.length - 1; li++) {
                const lp1 = toScreen(linePts[li].x, linePts[li].y);
                const lp2 = toScreen(linePts[li + 1].x, linePts[li + 1].y);
                k.drawLine({ p1: lp1, p2: lp2, width: mat.width * sc * 0.5, color: ghostCol, opacity: 0.5 });
            }
            // Dots at intermediate nodes
            for (let li = 1; li < linePts.length - 1; li++) {
                const lp = toScreen(linePts[li].x, linePts[li].y);
                k.drawCircle({ pos: lp, radius: 4, color: ghostCol, opacity: 0.6 });
            }
        } else {
            k.drawLine({
                p1, p2,
                width: mat.width * sc * 0.5,
                color: colorOf(ok ? C.pencil : C.danger),
                opacity: ok ? 0.5 : 0.3,
            });
        }

        // Cost label
        if (d > 10) {
            let cost;
            if (state.lineMode && d > GRID) {
                const linePts = getLinePoints(st.x, st.y, sn.x, sn.y);
                cost = 0;
                for (let li = 0; li < linePts.length - 1; li++)
                    cost += Math.round(Math.hypot(linePts[li+1].x - linePts[li].x, linePts[li+1].y - linePts[li].y) * mat.price / 10);
            } else {
                cost = Math.round(d * mat.price / 10);
            }
            const mid = toScreen((st.x + sn.x) / 2, (st.y + sn.y) / 2);
            k.drawText({
                text: `$${cost}`,
                pos: k.vec2(mid.x + 8, mid.y - 10),
                size: 6,
                font: "PressStart2P",
                color: colorOf("#ffffff"),
                opacity: 0.8,
            });
        }

        // Snap indicator on target node
        if (state.nodes.find(n => n.x === sn.x && n.y === sn.y)) {
            k.drawCircle({ pos: p2, radius: 8, fill: false, outline: { width: 2, color: colorOf(C.accent) }, opacity: 0.6 });
        }
    }

    // ─── Auto-extend preview ─────────────────────────
    // When the last placed road has set up the chain, show a faint ghost of
    // where the next click would drop the segment. Pulses gently so it's
    // clearly hint-only, not part of the bridge.
    function drawAutoExtendGhost(sc) {
        if (state.mode !== "build") return;
        if (state.dragging) return;                     // active drag overrides
        if (state.delMode || state.archMode || state.selectMode || state.lineMode) return;
        const lr = state.lastRoadEnd;
        if (!lr) return;
        const mat = MATERIALS[state.selectedMat];
        if (!mat || !mat.isRoad) return;
        if (!state.nodes.includes(lr.node)) { state.lastRoadEnd = null; return; }

        const px = lr.node.x + lr.dx;
        const py = lr.node.y + lr.dy;
        if (px < lX || px > rX) return;

        const p1 = toScreen(lr.node.x, lr.node.y);
        const p2 = toScreen(px, py);

        const pulse = 0.5 + 0.25 * Math.sin(k.time() * 3.5);
        // Ghost line in the material color
        k.drawLine({
            p1, p2,
            width: mat.width * sc * 0.5,
            color: colorOf(mat.color),
            opacity: 0.25 * pulse + 0.18,
        });
        // Endpoint marker — hollow accent ring so the click target is obvious
        k.drawCircle({
            pos: p2, radius: 7,
            fill: false, outline: { width: 1.6, color: colorOf(C.accent) },
            opacity: 0.45 + 0.35 * pulse,
        });
    }

    // ─── Select tool halo — matches the arch tool look. Layered rendering:
    // call with "roads" before the road draw pass and with "structural" before
    // the structural pass. The endpoint dots piggyback on the structural pass
    // so they render on top of everything.
    //
    // While a marquee drag is in progress, we also highlight members currently
    // inside the box as a live preview of what will be selected on release.
    function drawSelectHalo(sc, layer = "structural") {
        if (!state.selectMode || state.mode !== "build") return;
        // Build the set of "visually selected" members for this frame:
        // committed selection + any members currently inside the marquee box.
        let visible = state.selectedMembers;
        if (state.selectBoxing && state.selectBoxStart && state.selectBoxEnd) {
            const preview = getMembersInBox(state.selectBoxStart, state.selectBoxEnd);
            visible = new Set(state.selectedMembers);
            for (const m of preview) visible.add(m);
        }
        const haloCol = colorOf(C.accent);
        // Single-node drag (no members selected): show a blue outline on the
        // joint being moved so the player gets the same visual cue they'd get
        // from a marquee selection.
        const singleNode = (!visible || visible.size === 0)
            && state.selectMoving && state.selectMoveOrig
            && state.selectMoveOrig.size === 1;
        if (singleNode && layer === "structural") {
            for (const n of state.selectMoveOrig.keys()) {
                const sp = toScreen(n.x, n.y);
                k.drawCircle({ pos: sp, radius: 10, fill: false, outline: { width: 2.4, color: haloCol }, opacity: 0.95 });
                k.drawCircle({ pos: sp, radius: 14, fill: false, outline: { width: 1.4, color: haloCol }, opacity: 0.45 });
            }
        }
        if (!visible || visible.size === 0) return;
        for (const m of visible) {
            if (m.broken) continue;
            const isRoad = MATERIALS[m.type].isRoad;
            if (layer === "roads" && !isRoad) continue;
            if (layer === "structural" && isRoad) continue;
            const p1 = toScreen(m.n1.x, m.n1.y);
            const p2 = toScreen(m.n2.x, m.n2.y);
            const mat = MATERIALS[m.type];
            const hw = (mat.width * sc) + 5;
            k.drawLine({ p1, p2, width: hw, color: haloCol, opacity: 0.55 });
        }
        // Endpoint rings drawn only on the structural pass so they sit on top.
        // All joints use hollow outline circles — fixed anchors get a thicker
        // stroke + small center dot to stay visually distinct.
        if (layer === "structural") {
            const endpoints = new Set();
            for (const m of visible) {
                if (m.broken) continue;
                endpoints.add(m.n1);
                endpoints.add(m.n2);
            }
            for (const n of endpoints) {
                const sp = toScreen(n.x, n.y);
                const locked = n.fixed || n.builtin;
                k.drawCircle({
                    pos: sp, radius: 7,
                    fill: false,
                    outline: { width: locked ? 3 : 2.2, color: haloCol },
                    opacity: 0.95,
                });
                if (locked) {
                    // Small center dot marks this as a fixed anchor (won't move on drag)
                    k.drawCircle({ pos: sp, radius: 1.8, color: haloCol, opacity: 0.95 });
                }
            }
        }
    }

    // ─── Select tool: marching-ants marquee rectangle drawn while dragging ──
    function drawSelectBox(sc) {
        if (!state.selectMode || !state.selectBoxing) return;
        if (!state.selectBoxStart || !state.selectBoxEnd) return;
        const p1 = toScreen(state.selectBoxStart.x, state.selectBoxStart.y);
        const p2 = toScreen(state.selectBoxEnd.x, state.selectBoxEnd.y);
        const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
        const w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y);

        // Subtle darker tint inside the box so it reads as a cut-out without
        // adding any color. Pure low-opacity black sits on top of whatever's
        // below (grid, terrain, background).
        k.drawRect({ pos: k.vec2(x, y), width: w, height: h, color: colorOf("#000000"), opacity: 0.10, anchor: "topleft" });

        // Marching-ants: dashes slide clockwise around the perimeter using a
        // time-based phase offset. White stroke with a thin brown shadow.
        const dash = 7, gap = 5;
        const cycle = dash + gap;   // 12
        const phase = (k.time() * 22) % cycle;    // ~22 px/sec drift

        const drawMarchingEdge = (ax, ay, bx, by) => {
            const dxe = bx - ax, dye = by - ay;
            const len = Math.hypot(dxe, dye);
            if (len === 0) return;
            const ux = dxe / len, uy = dye / len;
            // Start at -phase so dashes appear to enter from the edge's start
            for (let t = -phase; t < len; t += cycle) {
                const t1 = Math.max(0, t);
                const t2 = Math.min(len, t + dash);
                if (t2 <= t1) continue;
                const a = k.vec2(ax + ux * t1, ay + uy * t1);
                const b = k.vec2(ax + ux * t2, ay + uy * t2);
                // Brown shadow underneath (wider) for contrast against light backgrounds
                k.drawLine({ p1: a, p2: b, width: 3, color: colorOf("#5a3418"), opacity: 0.75 });
                // White dash on top
                k.drawLine({ p1: a, p2: b, width: 1.6, color: colorOf("#ffffff"), opacity: 0.95 });
            }
        };
        // Draw edges in clockwise order so the phase offset flows in one direction.
        drawMarchingEdge(x,     y,     x + w, y);     // top: left → right
        drawMarchingEdge(x + w, y,     x + w, y + h); // right: top → bottom
        drawMarchingEdge(x + w, y + h, x,     y + h); // bottom: right → left
        drawMarchingEdge(x,     y + h, x,     y);     // left: bottom → top
    }

    // ─── Arch edit halo (drawn BEFORE members so glow is behind beams) ──
    function drawArchEditHalo(sc) {
        if (!state.archMode || state.mode !== "build") return;
        if (state.editingArchId == null) return;
        const archData = state.arches.find(a => a.id === state.editingArchId);
        if (!archData?.nodeSequence) return;
        const interiorSet = new Set(archData.nodeSequence.slice(1, -1));
        const haloCol = colorOf(C.accent);
        for (const m of state.members) {
            if (m.broken) continue;
            const isArchMember = m.archId === state.editingArchId;
            const isAttached = !isArchMember && (interiorSet.has(m.n1) || interiorSet.has(m.n2));
            if (!isArchMember && !isAttached) continue;
            const mp1 = toScreen(m.n1.x, m.n1.y);
            const mp2 = toScreen(m.n2.x, m.n2.y);
            const hw = (MATERIALS[m.type].width * sc) + 5;
            k.drawLine({ p1: mp1, p2: mp2, width: hw, color: haloCol, opacity: isAttached ? 0.3 : 0.55 });
        }
    }

    // ─── Arch preview ──────────────────────────────
    function drawArchPreview(sc) {
        if (!state.archMode || state.mode !== "build") return;
        // Pick up material swaps while editing (updates member types even if
        // the apex handle isn't being dragged this frame).
        if (state.editingArchId != null) syncArchInPlace();

        const previewCol = colorOf(C.accent);

        // Phase A & B helper: ring every valid candidate node so player sees options
        if (!state.archStart || !state.archEnd) {
            for (const n of state.nodes) {
                if (n.builtin) continue;
                if (!n.fixed && !isConnectedToAnchor(state.nodes, state.members, n.x, n.y)) continue;
                const np = toScreen(n.x, n.y);
                k.drawCircle({ pos: np, radius: 6, fill: false, outline: { width: 2, color: previewCol }, opacity: 0.55 });
            }
        }

        if (!state.archStart) return;

        // Lock-in dot for the start anchor
        const sp = toScreen(state.archStart.x, state.archStart.y);
        k.drawCircle({ pos: sp, radius: 8, color: previewCol, opacity: 0.85 });

        // Phase B: only start chosen — arch follows the cursor. End snaps to a
        // valid anchor when hovering near one (solid dot); otherwise floats at
        // the cursor (smaller dot, lower opacity) so the shape is always visible.
        if (!state.archEnd) {
            const previewArch = computeArchPhaseBPreview();
            if (previewArch) {
                const ep = toScreen(previewArch.end.x, previewArch.end.y);
                const wMat = MATERIALS[state.selectedMat];
                for (let i = 0; i < previewArch.points.length - 1; i++) {
                    const pp1 = toScreen(previewArch.points[i].x, previewArch.points[i].y);
                    const pp2 = toScreen(previewArch.points[i + 1].x, previewArch.points[i + 1].y);
                    k.drawLine({ p1: pp1, p2: pp2, width: wMat.width * sc * 0.6, color: previewCol, opacity: previewArch.snapped ? 0.7 : 0.45 });
                }
                if (previewArch.snapped) {
                    k.drawCircle({ pos: ep, radius: 8, color: previewCol, opacity: 0.85 });
                } else {
                    k.drawCircle({ pos: ep, radius: 5, color: previewCol, opacity: 0.5 });
                }
            }
            return;
        }

        // Phase C: both endpoints set — chord reference + preview arch + apex handle.
        // When editing a placed arch, the REAL arch is already rendered by
        // drawMembers (nodes moved in place via syncArchInPlace), so we skip
        // drawing the preview overlay and just show the chord + handle.
        const ep = toScreen(state.archEnd.x, state.archEnd.y);

        k.drawLine({ p1: sp, p2: ep, width: 1, color: previewCol, opacity: 0.25 });

        if (state.editingArchId == null) {
            const arch = computeArch();
            if (arch) {
                const wMat = MATERIALS[state.selectedMat];
                for (let i = 0; i < arch.points.length - 1; i++) {
                    const pp1 = toScreen(arch.points[i].x, arch.points[i].y);
                    const pp2 = toScreen(arch.points[i + 1].x, arch.points[i + 1].y);
                    k.drawLine({ p1: pp1, p2: pp2, width: wMat.width * sc * 0.6, color: previewCol, opacity: 0.7 });
                }
                for (let i = 1; i < arch.points.length - 1; i++) {
                    const pp = toScreen(arch.points[i].x, arch.points[i].y);
                    k.drawCircle({ pos: pp, radius: 4, color: previewCol, opacity: 0.75 });
                }
            }
        }

        // End anchor lock dot (always, so the endpoint is obvious)
        k.drawCircle({ pos: ep, radius: 8, color: previewCol, opacity: 0.85 });

        // Apex handle — clearly draggable: filled disc + ring + cross-hair
        const apex = getArchApexScreen();
        if (apex) {
            const r = state.archDragging ? 11 : 9;
            k.drawCircle({ pos: k.vec2(apex.x + 1, apex.y + 1), radius: r + 1, color: colorOf("#000000"), opacity: 0.3 });
            k.drawCircle({ pos: apex, radius: r, color: colorOf("#fff8e0") });
            k.drawCircle({ pos: apex, radius: r, fill: false, outline: { width: 2.5, color: previewCol } });
            k.drawLine({ p1: k.vec2(apex.x, apex.y - r * 0.55), p2: k.vec2(apex.x, apex.y + r * 0.55), width: 2, color: previewCol });
            k.drawLine({ p1: k.vec2(apex.x - r * 0.55, apex.y), p2: k.vec2(apex.x + r * 0.55, apex.y), width: 2, color: previewCol });
        }
    }

    // ─── Nodes (small joint dots) ──────────────────
    function drawNodes(sc) {
        // Only show node handles in build mode — they vanish during the sim.
        if (state.mode !== "build") return;
        const mpos = k.mousePos();
        for (const n of state.nodes) {
            if (n.builtin) continue;
            if (n.fixed) continue;
            if (n._chainNode) continue;  // intermediate rope/cable nodes are invisible
            const p = toScreen(n.x, n.y);
            // Hover state — handle pops larger when the cursor is over it.
            const hovered = Math.hypot(mpos.x - p.x, mpos.y - p.y) < 8 * sc;
            const half = (hovered ? 5.5 : 4.5) * sc;
            // Drop shadow
            k.drawRect({
                pos: k.vec2(p.x - half + 1, p.y - half + 1.5),
                width: half * 2, height: half * 2,
                color: colorOf("#010101"),
                anchor: "topleft", opacity: 0.3, radius: 1,
            });
            // Yellow handle body
            k.drawRect({
                pos: k.vec2(p.x - half, p.y - half),
                width: half * 2, height: half * 2,
                color: colorOf(hovered ? "#ffe17a" : "#f0c040"),
                anchor: "topleft", radius: 1,
            });
            // Top highlight strip
            k.drawRect({
                pos: k.vec2(p.x - half, p.y - half),
                width: half * 2, height: Math.max(1, sc * 0.7),
                color: colorOf("#fff1a0"),
                anchor: "topleft",
            });
            // Dark outline
            k.drawRect({
                pos: k.vec2(p.x - half, p.y - half),
                width: half * 2, height: half * 2,
                fill: false, outline: { width: 1, color: colorOf("#7a5010") },
                anchor: "topleft", radius: 1,
            });
        }
    }

    // ─── Vehicles (sprite-based) ───────────────────
    function drawVehicles(sc) {
        for (let vi = 0; vi < state.vehicles.length; vi++) {
            const v = state.vehicles[vi];
            if (!v.active && v.y > 1100) continue;

            const p = toScreen(v.x, v.y);
            const px = p.x;
            const py = p.y;
            const hw = v.cfg.w / 2 * sc;
            const hh = v.cfg.h / 2 * sc;

            // Suspension bob — gentle vertical wobble while driving so the
            // static sprite reads as actually moving over the road. Disabled
            // when falling/splashed/finished so we don't fight the physics.
            const driving = state.mode === "sim" && v.active && !v.finished
                          && !v._falling && !v._splashed;
            const bobOffset = driving
                ? Math.sin(k.time() * 13 + v.x * 0.05) * 1.0 * sc
                : 0;
            const drawY = py + bobOffset;

            // Wheel-spin marks — short hash marks under each wheel that scroll
            // backwards based on the vehicle's x position. Reads as "wheels
            // turning" without animating the sprite itself.
            if (driving && v.cfg.sprite !== "veh_bicycle") {
                const wheelCount = Math.max(2, v.cfg.wheels || 2);
                const wheelSpan = v.cfg.w * 0.6 * sc;
                const wheelY = drawY + hh * 0.9;
                for (let wi = 0; wi < wheelCount; wi++) {
                    const t = wheelCount === 1 ? 0.5 : wi / (wheelCount - 1);
                    const wxC = px - wheelSpan / 2 + t * wheelSpan;
                    const phaseBase = ((v.x * 0.45) % 4 + 4) % 4;
                    for (let s = 0; s < 4; s++) {
                        const sP = ((phaseBase + s) % 4) - 2;
                        const fade = 1 - Math.abs(sP) / 2;
                        if (fade <= 0) continue;
                        const offX = sP * 2.2 * sc;
                        k.drawLine({
                            p1: k.vec2(wxC + offX - 1.4 * sc, wheelY),
                            p2: k.vec2(wxC + offX + 1.4 * sc, wheelY),
                            width: 1, color: colorOf("#000000"),
                            opacity: 0.22 * fade,
                        });
                    }
                }
            }

            const spriteKey = v.cfg.sprite;
            const vAngle = v.angle || 0;
            const yOffWorld = v._onBridge && v.cfg.spriteYOffsetBridge != null
                ? v.cfg.spriteYOffsetBridge
                : (v.cfg.spriteYOffset || 0);
            const spriteYOff = yOffWorld * sc;
            if (spriteKey) {
                const sprW = hw * 4;
                const submerged = !!v._splashed;
                // Sprites are drawn facing right by default (flipX: true on
                // a left-facing source). For left-bound vehicles we want them
                // facing left, so undo the flip.
                const dir = v._dir || 1;
                k.drawSprite({
                    sprite: spriteKey,
                    pos: k.vec2(px, drawY - hh * 0.3 + spriteYOff),
                    width: sprW,
                    height: sprW,
                    anchor: "center",
                    flipX: dir > 0,
                    angle: k.rad2deg(vAngle),
                    color: submerged ? colorOf("#456b95") : undefined,
                    opacity: submerged ? 0.85 : 1,
                });
            }

            // Multi-vehicle label — a single letter floating above the car
            // in a per-session random color from the SNAP palette. Same
            // gentle bob + tilt vocabulary as the FINISH text so they feel
            // visually related. Color is rolled once at scene init and on
            // every reset (via rerollLabelColors), not animated each frame.
            if (v.label && !v._splashed) {
                const letterY = drawY - hh * 4.2 + spriteYOff;
                const now = k.time();
                const bob  = Math.sin(now * 3.0) * 1.5;
                const tilt = Math.sin(now * 2.1) * 4;
                const sz   = 11 * sc;
                const labelColor = (state._carLabelColors && state._carLabelColors[vi]) || SNAP_COLORS[0];

                k.pushTransform();
                k.pushTranslate(px, letterY + bob);
                k.pushRotate(tilt);

                k.drawText({
                    text: v.label, pos: k.vec2(1.5, 1.5),
                    size: sz, font: "PressStart2P",
                    color: colorOf("#1a0e05"),
                    opacity: 0.5, anchor: "center",
                });
                const finishedColor = (v._passedFlag || v.finished) ? "#4ade80" : labelColor;
                k.drawText({
                    text: v.label, pos: k.vec2(0, 0),
                    size: sz, font: "PressStart2P",
                    color: colorOf(finishedColor),
                    anchor: "center",
                });

                k.popTransform();
            }
        }
    }

    // ─── Particles ──────────────────────────────────
    function drawParticles(sc) {
        for (const p of state.particles) {
            const cp = toScreen(p.x, p.y);
            k.drawCircle({
                pos: cp,
                radius: p.r * p.life * sc,
                color: colorOf(p.color),
                opacity: p.life,
            });
        }
    }

    // (SNAP_COLORS palette hoisted to the top of the scene so init-time
    // helpers like rerollLabelColors can read from it.)

    function spawnSnapVfx(wx, wy) {
        // Shuffle palette so each letter gets a unique color (Fisher–Yates on a copy)
        const palette = SNAP_COLORS.slice();
        for (let i = palette.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [palette[i], palette[j]] = [palette[j], palette[i]];
        }
        // One popup per snap event — letters carry their own color + slight random tilt
        const letters = "SNAP!".split("").map((ch, i) => ({
            ch,
            color: palette[i],  // guaranteed distinct (5 letters ≤ 6 palette entries)
            tilt: (Math.random() - 0.5) * 24,    // degrees
            bob:  Math.random() * Math.PI * 2,   // phase for idle wiggle
            dy:   (Math.random() - 0.5) * 6,     // slight vertical jitter
        }));
        state.snapPopups.push({
            x: wx, y: wy - 20,   // spawn slightly above the break point
            age: 0, life: 80,    // ~1.3s at 60Hz
            letters,
        });

        // Confetti burst — ~28 rotated rectangles exploding outward
        for (let i = 0; i < 28; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 2 + Math.random() * 4;
            state.snapConfetti.push({
                x: wx, y: wy,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 2,   // bias upward for a pop
                rot: Math.random() * Math.PI * 2,
                rotSpd: (Math.random() - 0.5) * 0.4,
                w: 4 + Math.random() * 4,
                h: 6 + Math.random() * 5,
                color: SNAP_COLORS[Math.floor(Math.random() * SNAP_COLORS.length)],
                age: 0, life: 90,                  // ~1.5s at 60Hz
            });
        }
    }

    function drawSnapConfetti(sc) {
        for (const c of state.snapConfetti) {
            const cp = toScreen(c.x, c.y);
            const t = c.age / c.life;
            const opacity = Math.min(1, (1 - t) * 2); // fade in last half of life

            const hw = c.w * 0.5 * sc;
            const hh = c.h * 0.5 * sc;
            const cos = Math.cos(c.rot), sin = Math.sin(c.rot);
            const pts = [
                k.vec2(cp.x + (-hw * cos - (-hh) * sin), cp.y + (-hw * sin + (-hh) * cos)),
                k.vec2(cp.x + ( hw * cos - (-hh) * sin), cp.y + ( hw * sin + (-hh) * cos)),
                k.vec2(cp.x + ( hw * cos -   hh  * sin), cp.y + ( hw * sin +   hh  * cos)),
                k.vec2(cp.x + (-hw * cos -   hh  * sin), cp.y + (-hw * sin +   hh  * cos)),
            ];
            const fill = colorOf(c.color);
            k.drawTriangle({ p1: pts[0], p2: pts[1], p3: pts[2], color: fill, opacity });
            k.drawTriangle({ p1: pts[0], p2: pts[2], p3: pts[3], color: fill, opacity });
        }
    }

    function drawSnapPopups(sc) {
        for (const p of state.snapPopups) {
            const t = p.age / p.life;

            // Scale curve: punch-in (overshoot), settle, hold, blow-up fade-out
            let scale, opacity;
            if (t < 0.15) {
                const k2 = t / 0.15;
                scale = k2 * 1.25;
                opacity = k2;
            } else if (t < 0.25) {
                const k2 = (t - 0.15) / 0.10;
                scale = 1.25 - k2 * 0.25;
                opacity = 1;
            } else if (t < 0.70) {
                scale = 1;
                opacity = 1;
            } else {
                const k2 = (t - 0.70) / 0.30;
                scale = 1 + k2 * 0.35;
                opacity = 1 - k2;
            }

            const cp = toScreen(p.x, p.y);
            const fontSize = 28 * sc * scale;
            const letterSpacing = fontSize * 1.05;  // PressStart2P is near-square, needs ~full-em
            const totalW = (p.letters.length - 1) * letterSpacing;
            const startX = cp.x - totalW / 2;

            for (let i = 0; i < p.letters.length; i++) {
                const L = p.letters[i];
                const lx = startX + i * letterSpacing;
                const wiggle = Math.sin(p.age * 0.2 + L.bob) * 2 * sc;
                const ly = cp.y + L.dy * sc + wiggle;

                // Rotate each letter individually via transform stack
                k.pushTransform();
                k.pushTranslate(lx, ly);
                k.pushRotate(L.tilt);

                // Shadow pass — dark, slightly offset, behind
                k.drawText({
                    text: L.ch,
                    pos: k.vec2(2 * sc, 2 * sc),
                    size: fontSize,
                    font: "PressStart2P",
                    color: colorOf("#1a0e05"),
                    opacity: opacity * 0.45,
                    anchor: "center",
                });
                // Main colored letter
                k.drawText({
                    text: L.ch,
                    pos: k.vec2(0, 0),
                    size: fontSize,
                    font: "PressStart2P",
                    color: colorOf(L.color),
                    opacity,
                    anchor: "center",
                });

                k.popTransform();
            }
        }
    }

    // ─── Finish flags ───────────────────────────────
    // Flag variant comes from the level config (mv.flag: "red" | "blue").
    // The sprite is rendered as-is — no per-vehicle hex tinting, since the
    // pixel-art shading reads cleanly only in its native palette.
    const FLAG_SPRITE = { red: "flag", blue: "flagBlue" };
    const flagSpriteFor = (mv) => FLAG_SPRITE[mv && mv.flag] || "flag";

    function drawFlags(sc) {
        // FLAG_INLAND_* imported from constants.js (shared with physics finish thresholds)
        const baseYR = rY - ROAD_H / 2;
        const baseYL = lY - ROAD_H / 2;
        if (lvlDef.multiVehicle) {
            let nextR = 0, nextL = 0;
            lvlDef.multiVehicle.forEach((mv, i) => {
                const v = state.vehicles[i];
                // _passedFlag fires the moment the car crosses its flag — for
                // passOnly cars that's well before .finished (which waits
                // until they're fully off-screen).
                const triggered = !!(v && (v._passedFlag || v.finished));
                const goalSide = v?._goalSide || mv.goalSide || (mv.dir === -1 ? "L" : "R");
                const sprite = flagSpriteFor(mv);
                if (goalSide === "L") {
                    drawOneFlag(lX - FLAG_INLAND_L - nextL * 70, baseYL, mv.label, triggered, sc, "L", i, sprite);
                    nextL++;
                } else {
                    drawOneFlag(rX + FLAG_INLAND_R + nextR * 70, baseYR, mv.label, triggered, sc, "R", i, sprite);
                    nextR++;
                }
            });
        } else {
            drawOneFlag(rX + FLAG_INLAND_R, baseYR, null, state.mode === "end" && state.finished, sc, "R", 0, "flag");
        }
    }

    function drawOneFlag(wx, wy, label, triggered, sc, side = "R", vehicleIdx = 0, sprite = "flag") {
        const p = toScreen(wx, wy);
        const flagH = sc * 58;      // slightly smaller than before — easier on the eye
        const flagW = flagH;

        // Flag sprite has a small empty strip at the bottom of its frame, so
        // we shift the draw origin down by ~5% of the rendered height. That
        // makes the pole base actually touch the road surface.
        const flagBottomY = p.y + flagH * 0.08;
        const frame = Math.floor(state.flagWave * 3) % 5;
        try {
            k.drawSprite({
                sprite,
                frame: frame,
                pos: k.vec2(p.x, flagBottomY),
                width: flagW,
                height: flagH,
                anchor: "botleft",
                flipX: side === "L",
            });
        } catch(e) {
            // Fallback rectangle flag
            const poleH = flagH;
            k.drawLine({ p1: k.vec2(p.x, flagBottomY), p2: k.vec2(p.x, flagBottomY - poleH), width: 2, color: colorOf("#94a3b8") });
            k.drawRect({
                pos: k.vec2(p.x + sc * 13, flagBottomY - poleH + sc * 8),
                width: sc * 26,
                height: sc * 17,
                color: colorOf(sprite === "flagBlue" ? "#3a6ec0" : "#c43030"),
                anchor: "center",
            });
        }

        // Label layout — stacked. The car-letter (A / B / …) sits ABOVE the
        // word FINISH and renders at ~1.6× the FINISH letter size, in the
        // same color as the floating letter over its matching car (pulled
        // from _carLabelColors so the pairing is unambiguous). The FINISH
        // row keeps its per-letter random colors and the soft bob/tilt.
        const finishSize = Math.max(6, 6 * sc);
        // Match the size of the floating letter above each car (11 * sc).
        const carLetterSize = 11 * sc;
        const labelCx = p.x + flagW * 0.5;
        const finishBaseY = flagBottomY - flagH - 6 * sc;
        const carLetterY = finishBaseY - carLetterSize - 4 * sc;
        const now = k.time();
        const flagColors = (state._flagTextColors && state._flagTextColors[vehicleIdx]) || [];
        const carLetterCol = (state._carLabelColors && state._carLabelColors[vehicleIdx]) || SNAP_COLORS[0];

        // Top row: just the car letter (skipped on the single-vehicle case).
        if (label) {
            const bob  = Math.sin(now * 3.0) * 1.5;
            const tilt = Math.sin(now * 2.1) * 4;
            k.pushTransform();
            k.pushTranslate(labelCx, carLetterY + bob);
            k.pushRotate(tilt);
            k.drawText({
                text: label, pos: k.vec2(2, 2),
                size: carLetterSize, font: "PressStart2P",
                color: colorOf("#1a0e05"),
                opacity: 0.5,
                anchor: "center",
            });
            k.drawText({
                text: label, pos: k.vec2(0, 0),
                size: carLetterSize, font: "PressStart2P",
                color: colorOf(triggered ? "#4ade80" : carLetterCol),
                anchor: "center",
            });
            k.popTransform();
        }

        // Bottom row: the word "FINISH" with per-letter random colors.
        const finishTxt = "FINISH";
        const kernW = finishSize * 1.05;
        let cursor = labelCx - (finishTxt.length * kernW) / 2 + kernW * 0.5;
        for (let i = 0; i < finishTxt.length; i++) {
            const ch = finishTxt[i];
            const col = triggered ? "#4ade80" : (flagColors[i] || SNAP_COLORS[i % SNAP_COLORS.length]);
            const bob  = Math.sin(now * 3.0 + i * 0.6) * 1.5;
            const tilt = Math.sin(now * 2.1 + i * 0.9) * 4;

            k.pushTransform();
            k.pushTranslate(cursor, finishBaseY + bob);
            k.pushRotate(tilt);

            k.drawText({
                text: ch, pos: k.vec2(1.5, 1.5),
                size: finishSize, font: "PressStart2P",
                color: colorOf("#1a0e05"),
                opacity: 0.45,
                anchor: "center",
            });
            k.drawText({
                text: ch, pos: k.vec2(0, 0),
                size: finishSize, font: "PressStart2P",
                color: colorOf(col),
                anchor: "center",
            });

            k.popTransform();
            cursor += kernW;
        }
    }

    // ═══════════════════════════════════════════════════
    //  UI DRAWING (screen-space)
    // ═══════════════════════════════════════════════════

    function drawToolbar() {
        const W = k.width();
        const tb = getToolbar();

        // Wooden toolbar bar
        k.drawRect({ pos: k.vec2(0, 0), width: W, height: tb.h + tb.pad, color: colorOf("#d37e3d"), anchor: "topleft" });
        k.drawRect({ pos: k.vec2(0, tb.h + tb.pad - 3), width: W, height: 3, color: colorOf("#8e4924"), anchor: "topleft" });
        // Subtle wood grain
        for (let tx = 0; tx < W; tx += 14) {
            k.drawLine({ p1: k.vec2(tx, 0), p2: k.vec2(tx + 3, tb.h + tb.pad), width: 0.5, color: colorOf("#8e4924"), opacity: 0.12 });
        }
        k.drawRect({ pos: k.vec2(0, tb.h + tb.pad), width: W, height: 2, color: colorOf("#010101"), anchor: "topleft", opacity: 0.3 });

        // Budget display — glow + shake scales with how over-budget you are
        const cost = calcCost(state.members);
        const overBudget = cost > lvl.budget;
        const budgetPct = cost / lvl.budget;
        const warn = budgetPct > 0.85;
        const budgetColor = overBudget ? "#ff4444" : warn ? "#ffaa22" : "#fff8e0";
        const t = k.time();
        // Pulse strength: 0..1. Ramps up between 85% and 100%, then pegs at 1 when over.
        const pulse = overBudget ? 1 : warn ? Math.min(1, (budgetPct - 0.85) / 0.15) : 0;
        // Shake offset — stronger when red, subtle when yellow
        const shakeAmp = overBudget ? 2.5 : warn ? 0.8 * pulse : 0;
        const shakeX = shakeAmp ? (Math.sin(t * 38) + Math.sin(t * 63)) * 0.5 * shakeAmp : 0;
        const shakeY = shakeAmp ? (Math.cos(t * 47) + Math.sin(t * 71)) * 0.4 * shakeAmp : 0;
        const budgetText = `$${cost.toLocaleString()} / $${lvl.budget.toLocaleString()}`;
        const bx = 12 + shakeX;
        // Budget + level name centered as a pair on the toolbar — the combined
        // block (~28px tall) sits with its middle on the bar's midline, matching
        // the vertical center of the icon row on the right side.
        const by = Math.round((tb.h + tb.pad) / 2 - 13) + shakeY;

        // Glow — pulsing soft rect behind the text, stronger the worse it gets
        if (pulse > 0) {
            const glowPulse = 0.5 + 0.5 * Math.sin(t * (overBudget ? 9 : 5));
            const glowAlpha = (overBudget ? 0.4 : 0.2) * (0.5 + 0.5 * glowPulse);
            const textW = budgetText.length * 14 * 0.9;   // approx PressStart2P width
            for (let ring = 3; ring >= 1; ring--) {
                k.drawRect({
                    pos: k.vec2(bx - 4 - ring, by - 4 - ring),
                    width: textW + 8 + ring * 2,
                    height: 22 + ring * 2,
                    color: colorOf(budgetColor),
                    opacity: glowAlpha * (0.35 / ring),
                    anchor: "topleft",
                    radius: 4 + ring,
                });
            }
        }

        k.drawText({
            text: budgetText,
            pos: k.vec2(bx, by),
            size: 14,
            font: "PressStart2P",
            color: colorOf(budgetColor),
        });

        // Level name — sits right under the budget readout, still inside the
        // wooden toolbar strip.
        k.drawText({
            text: lvlDef.name,
            pos: k.vec2(12, by + 18),
            size: 8,
            font: "PressStart2P",
            color: colorOf("#fff8e0"),
            opacity: 0.5,
        });

        // ─── Material icons (no box, no halo — icon IS the button) ───
        const mposMat = k.mousePos();
        const dtMat = k.dt() || 1 / 60;
        // Buttons are all centered on the bar's midline; match the row here.
        const rowY = tb.simBtn.y;
        for (let i = 0; i < tb.matKeys.length; i++) {
            const baseKey = tb.matKeys[i];
            const upgradeKey = upgradesUnlocked ? MATERIAL_UPGRADES[baseKey] : null;
            const isExpanded = state.matExpanded.has(baseKey);
            const displayKey = isExpanded ? upgradeKey : baseKey;
            const mat = MATERIALS[displayKey];
            const bx = tb.matX[i];
            const by = rowY;
            const isSel = state.selectedMat === displayKey;
            const iconCx = bx + tb.matBtnW / 2;
            const iconCy = by + 16;

            // Hover easing — 0 when cursor is away, 1 when over the button
            const hovered = mposMat.x >= bx && mposMat.x <= bx + tb.matBtnW
                         && mposMat.y >= by && mposMat.y <= by + 32;
            const prev = state.matHover[baseKey] || 0;
            state.matHover[baseKey] = hovered
                ? Math.min(1, prev + dtMat * 10)
                : Math.max(0, prev - dtMat * 12);
            const h = state.matHover[baseKey];

            // Swap animation — a quick squish-into-self scale that crosses
            // through 0 width when the icon swaps mid-animation. Plays in
            // both directions; clean and snappy with no extra overlay.
            if (state.matRevealT[baseKey] != null && state.matRevealT[baseKey] < 1) {
                state.matRevealT[baseKey] = Math.min(1, state.matRevealT[baseKey] + dtMat * 5);
            }
            const revealT = state.matRevealT[baseKey] != null ? state.matRevealT[baseKey] : 1;
            // Squish: 1 → 0 → 1 — first half collapses (old icon vanishes),
            // second half expands (new icon zooms back in). cos(πt) gives that
            // smooth in-out without the bouncy overshoot.
            const swap = revealT < 1
                ? Math.abs(Math.cos(revealT * Math.PI))
                : 1;

            const baseScale = 2.0;
            const scale = baseScale * (isSel ? 1.12 : 1) * (1 + h * 0.1) * swap;

            k.pushTransform();
            k.pushTranslate(iconCx, iconCy);
            k.pushScale(scale, scale);
            if (isSel) drawMatIconOutlineFor(displayKey, 0, 0, "#fff8e0", 1.8);
            drawMatIconFor(displayKey, 0, 0, mat.color);
            k.popTransform();

            // Small "+" badge in the upper-right corner when this slot has
            // an upgrade available but isn't currently revealing it. A subtle
            // hint that double-clicking does something.
            if (upgradeKey && !isExpanded) {
                const bX = bx + tb.matBtnW - 10;
                const bY = by + 4;
                k.drawCircle({ pos: k.vec2(bX + 0.5, bY + 0.5), radius: 5, color: colorOf("#000000"), opacity: 0.3 });
                k.drawCircle({ pos: k.vec2(bX, bY), radius: 4.5, color: colorOf("#5a3418") });
                k.drawCircle({ pos: k.vec2(bX, bY), radius: 3.5, color: colorOf("#d37e3d") });
                k.drawText({
                    text: "+",
                    pos: k.vec2(bX, bY - 1),
                    size: 9, font: "PressStart2P",
                    color: colorOf("#fff8e0"),
                    anchor: "center",
                });
            }
            // Tiny "×" in the upper-right when EXPANDED so the player knows
            // they can double-click again to collapse back to the base tier.
            if (upgradeKey && isExpanded) {
                const bX = bx + tb.matBtnW - 10;
                const bY = by + 4;
                k.drawCircle({ pos: k.vec2(bX + 0.5, bY + 0.5), radius: 5, color: colorOf("#000000"), opacity: 0.3 });
                k.drawCircle({ pos: k.vec2(bX, bY), radius: 4.5, color: colorOf("#5a3418") });
                k.drawCircle({ pos: k.vec2(bX, bY), radius: 3.5, color: colorOf("#8e4924") });
                k.drawText({
                    text: "×",
                    pos: k.vec2(bX, bY - 1),
                    size: 9, font: "PressStart2P",
                    color: colorOf("#fff8e0"),
                    anchor: "center",
                });
            }
        }

        // ─── Vertical divider between materials and tools ───
        // Sits in the middle of the gap between the last material slot and the
        // first tool button so the two groups read as distinct sections.
        if (tb.matKeys.length > 0) {
            const lastMatX = tb.matX[tb.matKeys.length - 1] + tb.matBtnW;
            const divX = Math.round((lastMatX + tb.selectBtn.x) / 2);
            const divY = tb.selectBtn.y + 4;
            const divH = tb.selectBtn.h - 8;
            // Dark shadow + cream highlight for a crisp inlay look
            k.drawRect({ pos: k.vec2(divX + 0.5, divY), width: 1.5, height: divH, color: colorOf("#5a3418"), anchor: "topleft", opacity: 0.55 });
            k.drawRect({ pos: k.vec2(divX - 0.5, divY), width: 1, height: divH, color: colorOf("#fff8e0"), anchor: "topleft", opacity: 0.25 });
        }

        // ─── Action buttons ───
        // Toggleable tools (line/arch/delete) zoom on hover + get a brown outline
        // when active — matching the material selection feel.
        drawToolIconBtn(tb.selectBtn, drawSelectToolIcon, state.selectMode, "select");
        drawToolIconBtn(tb.lineBtn,   drawLineToolIcon,  state.lineMode,   "line");
        drawToolIconBtn(tb.archBtn,   drawArchToolIcon,  state.archMode,   "arch");
        drawToolIconBtn(tb.delBtn,    drawXIcon,         state.delMode,    "del");
        // Undo/redo always render in cream with the full hover-zoom animation —
        // no greyed-out state, consistent with the rest of the tool tray.
        drawToolIconBtn(tb.undoBtn, drawUndoIcon, false, "undo");
        drawToolIconBtn(tb.redoBtn, drawRedoIcon, false, "redo");
        // Split speed control — double-chevron buttons flanking a value readout.
        drawToolIconBtn(tb.speedDownBtn, drawSpeedDownIcon, false, "speedDown");
        drawToolIconBtn(tb.speedUpBtn,   drawSpeedUpIcon,   false, "speedUp");
        const speedTextX = (tb.speedDownBtn.x + tb.speedDownBtn.w + tb.speedUpBtn.x) / 2;
        const speedTextY = tb.speedDownBtn.y + tb.speedDownBtn.h / 2;
        // Hand-drawn pixel font so the readout fits with the rest of the icons.
        // 0.5x needs a smaller pixel size so the 4 chars fit in the narrow gap.
        const speedText = `${state.simSpeed}x`;
        drawPixelText(speedText, speedTextX, speedTextY, "#fff8e0", speedText.length > 2 ? 2 : 3);
        drawToolIconBtn(tb.menuBtn, drawMenuIcon, false, "menu");

        // SIM button: play icon idle (no outline), stop icon in sim mode (brown
        // outline like the other active tools). Toggles with the same feel.
        const isSim = state.mode === "sim";
        drawToolIconBtn(tb.simBtn, isSim ? drawStopIcon : drawPlayIcon, isSim, "sim");

        // ─── AI & Hint buttons — hanging wooden sign ───
        drawHangingAiHintSign(tb);
    }

    // icon can be: a 2D pixel grid, a function (cx, cy, col) => void, or falsy.
    function drawIconBtn(rect, icon, iconColor, bgColor, pxSize, text) {
        // Drop shadow for a raised-chip look
        k.drawRect({ pos: k.vec2(rect.x + 1, rect.y + 2), width: rect.w, height: rect.h, color: colorOf("#010101"), opacity: 0.25, anchor: "topleft", radius: 3 });
        // Background
        k.drawRect({ pos: k.vec2(rect.x, rect.y), width: rect.w, height: rect.h, color: colorOf(bgColor || "#8e4924"), anchor: "topleft", radius: 3 });
        // Top highlight
        k.drawRect({ pos: k.vec2(rect.x, rect.y), width: rect.w, height: 1, color: colorOf("#ffffff"), opacity: 0.2, anchor: "topleft" });
        k.drawRect({ pos: k.vec2(rect.x, rect.y), width: rect.w, height: rect.h, fill: false, outline: { width: 1, color: colorOf("#010101") }, anchor: "topleft", opacity: 0.3, radius: 3 });

        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        const isFn = typeof icon === "function";
        const hasIcon = !!icon;

        if (hasIcon && text) {
            const iconW = isFn ? 16 : icon[0].length * pxSize;
            const textW = text.length * 6;
            const gap = 4;
            const totalW = iconW + gap + textW;
            const leftX = cx - totalW / 2;
            if (isFn) icon(leftX + iconW / 2, cy, iconColor);
            else drawIcon(icon, leftX + iconW / 2, cy, iconColor, pxSize);
            k.drawText({ text, pos: k.vec2(leftX + iconW + gap, cy - 4), size: 7, font: "PressStart2P", color: colorOf(iconColor) });
        } else if (hasIcon) {
            if (isFn) icon(cx, cy, iconColor);
            else drawIcon(icon, cx, cy, iconColor, pxSize);
        } else if (text) {
            k.drawText({ text, pos: k.vec2(cx, cy), size: 8, font: "PressStart2P", color: colorOf(iconColor), anchor: "center" });
        }
    }

    // ─── Hint panel ─────────────────────────────────
    function drawHintPanel() {
        if (!state.hintOpen) return;
        const W = k.width();
        const H = k.height();
        const panelW = Math.min(300, W * 0.4);
        // Auto-size the panel based on the wrapped hint text. PatrickHand
        // averages ~5.8 px per character at size 16, and each line takes
        // size + lineSpacing = 20px. Header eats ~30px, bottom padding ~8px.
        const charsPerLine = Math.max(20, (panelW - 20) / 5.8);
        const estLines = Math.max(2, Math.ceil(lvlDef.hint.length / charsPerLine));
        const panelH = Math.max(110, 30 + estLines * 20 + 8);
        const px = W - panelW - 14;
        const py = H - panelH - 14;

        // Sticky note
        k.drawRect({ pos: k.vec2(px + 2, py + 2), width: panelW, height: panelH, color: colorOf("#000000"), opacity: 0.1, anchor: "topleft", radius: 2 });
        k.drawRect({ pos: k.vec2(px, py), width: panelW, height: panelH, color: colorOf("#fff9c4"), anchor: "topleft", radius: 1 });
        k.drawRect({ pos: k.vec2(px + panelW / 2 - 20, py - 5), width: 40, height: 12, color: colorOf(C.tape), anchor: "topleft", opacity: 0.55 });

        k.drawText({ text: "HINT", pos: k.vec2(px + 10, py + 10), size: 10, font: "PressStart2P", color: colorOf(C.markerBlue) });
        k.drawText({ text: lvlDef.hint, pos: k.vec2(px + 10, py + 30), size: 16, font: "PatrickHand", color: colorOf(C.pencil), width: panelW - 20, lineSpacing: 4 });
    }

    // ─── Per-level tutorial ─────────────────────────
    // Each entry is a sequence of popups; the active sequence is picked by
    // levelIdx. A step can carry `awaitExpand: <materialKey>` which makes
    // the popup wait for the player to actually double-click that material
    // slot before advancing — used to teach the tier-2 reveal on level 2.
    const TUTORIAL_STEPS_BY_LEVEL = {
        0: [
            { key: "budget", title: "BUDGET",  text: "You've got $7,000 to spend. Every piece you place costs money. Stay under budget or it won't count." },
            { key: "road",   title: "ROAD",    text: "Vehicles drive on the ROAD. Drop planks along the top of your bridge, anchor to anchor." },
            { key: "beam",   title: "SUPPORT", text: "BEAMS hold the road up from below. Cars can't drive on them, but without support the road will sag and snap." },
            { key: "tools",  title: "TOOLS",   text: "Your tools live up here. Poke around. Each one does something useful." },
            { key: "help",   title: "STUCK?",  text: "Tap the hanging sign for help. The question mark shows a quick hint. The robot opens an AI tutor that teaches engineering alongside your build." },
            { key: "options", title: "OPTIONS", text: "Sign on the right toggles the GRID, GRID-SNAP for free placement, and the green/yellow/red STRESS colors that show during sim. Use whichever helps you build." },
            { key: "goal",   title: "THE GOAL", text: "The car starts on the left and needs to reach the flag on the right. Get it across the gap safely." },
            { key: "play",   title: "PLAY",    text: "Ready? Hit the play button to run the simulation. If the car makes it across, you win." },
        ],
        1: [
            { key: "pier",      title: "THE PIER",      text: "A stone rock pokes out of the water in the middle of the gap. Use it as a PIER. Splitting one long span into two shorter ones makes each half far easier to hold up." },
            { key: "vehicle",   title: "HEAVIER LOAD",  text: "This time a JEEP crosses, not a car. Heavier than what you've handled before, so wood alone may snap. You'll want stronger materials in key spots." },
            { key: "betterRoad", title: "STRONGER ROAD", text: "Each material has a stronger TIER 2 version. DOUBLE-CLICK the road slot to reveal the STONE ROAD. Heavier, more expensive, but holds up under load.", awaitExpand: "wood_road" },
            { key: "betterBeam", title: "STRONGER BEAM", text: "Same trick on the beam. DOUBLE-CLICK the beam slot to reveal the STEEL BEAM. Pricier, but it bends a lot less under stress.", awaitExpand: "wood_beam" },
            { key: "mix",       title: "MIX & MATCH",   text: "Use the upgrades only where the load is heaviest. Wood elsewhere. The little + badge on each slot reminds you the upgrade is there." },
            { key: "play",      title: "BUILD & PLAY",  text: "Build the road across using the rock pier, triangulate underneath with beams, then hit PLAY." },
        ],
        2: [
            { key: "towerAnchor", title: "NEW ANCHORS",  text: "Two new anchors up top, one on each tower. Hook into them just like the cliff edges." },
            { key: "ropeSlot",    title: "ROPE TOOL",    text: "Meet ROPE, your new third slot. It only pulls, never pushes. Drop it from a tower down to the road. Double-click for STEEL CABLE if you want tougher.", awaitExpand: "rope" },
            { key: "vehicle",     title: "HEAVY RV",     text: "An RV is rolling up. Heaviest thing yet. Wood and beams alone won't cut it. Lean on those towers." },
            { key: "creative",    title: "GET CREATIVE", text: "No single right answer here. Hang the road from above, brace it from below, mix and match. Go nuts." },
            { key: "play",        title: "BUILD & PLAY", text: "Towers up top, rope coming down, road across, beams underneath. Once it looks RV-proof, hit PLAY." },
        ],
    };
    const TUTORIAL_STEPS = TUTORIAL_STEPS_BY_LEVEL[levelIdx] || [];

    function getTutorialTarget(key) {
        const tb = getToolbar();
        const W = k.width();
        const H = k.height();
        const padH = tb.h + tb.pad;
        if (key === "budget") {
            return { x: 0, y: 0, w: 220, h: padH };
        }
        if (key === "road") {
            return { x: tb.matX[0] - 4, y: tb.simBtn.y - 4, w: tb.matBtnW + 8, h: 40 };
        }
        if (key === "beam") {
            return { x: tb.matX[1] - 4, y: tb.simBtn.y - 4, w: tb.matBtnW + 8, h: 40 };
        }
        if (key === "tools") {
            return {
                x: tb.selectBtn.x - 6,
                y: tb.selectBtn.y - 6,
                w: tb.redoBtn.x + tb.redoBtn.w - tb.selectBtn.x + 12,
                h: tb.selectBtn.h + 12,
            };
        }
        if (key === "help") {
            // Spotlight the hanging sign itself + a bit of the rope above so
            // the player can see what's holding it up. We start the ring a
            // short way below the toolbar instead of right at it, so the
            // highlight reads as "look down here at the sign", not "look up
            // at the toolbar".
            const signTopY    = tb.aiBtn.y - 14;
            const signBottomY = tb.aiBtn.y + tb.aiBtn.h;
            return {
                x: tb.aiBtn.x - 22,
                y: signTopY,
                w: (tb.hintBtn.x + tb.hintBtn.w) - tb.aiBtn.x + 44,
                h: (signBottomY - signTopY) + 20,
            };
        }
        if (key === "options") {
            // Spotlight the right-edge hanging sign + a bit of the bar above
            // it so the player sees how the toggles are mounted.
            const sb = getSidebar();
            return {
                x: sb.signLeft - 8,
                y: sb.barY - 6,
                w: sb.signW + 16,
                h: (sb.signTop + sb.signH) - sb.barY + 12,
            };
        }
        if (key === "goal") {
            return { x: W * 0.15, y: H * 0.45, w: W * 0.7, h: H * 0.5 };
        }
        if (key === "play") {
            return { x: tb.simBtn.x - 6, y: tb.simBtn.y - 6, w: tb.simBtn.w + 12, h: tb.simBtn.h + 12 };
        }
        // ── Level 2 specific targets ────────────────────────
        if (key === "pier") {
            // Spotlight the rock pier — find any mid-gap anchor and project to screen
            const midNode = state.nodes.find(n => n.fixed && !n.builtin && n.x > lX && n.x < rX);
            if (midNode) {
                const p = toScreen(midNode.x, midNode.y);
                return { x: p.x - 80, y: p.y - 60, w: 160, h: 200 };
            }
            return { x: W * 0.3, y: H * 0.5, w: W * 0.4, h: H * 0.4 };
        }
        if (key === "vehicle") {
            // Spotlight the vehicle on the left side of the bridge
            const v = state.vehicles[0];
            if (v) {
                const p = toScreen(v.x, v.y);
                return { x: p.x - 60, y: p.y - 50, w: 120, h: 100 };
            }
            return { x: 0, y: H * 0.4, w: 200, h: H * 0.3 };
        }
        if (key === "betterRoad") {
            return { x: tb.matX[0] - 4, y: tb.simBtn.y - 4, w: tb.matBtnW + 8, h: 40 };
        }
        if (key === "betterBeam") {
            return { x: tb.matX[1] - 4, y: tb.simBtn.y - 4, w: tb.matBtnW + 8, h: 40 };
        }
        if (key === "mix") {
            return {
                x: tb.matX[0] - 6, y: tb.simBtn.y - 6,
                w: tb.matX[1] + tb.matBtnW - tb.matX[0] + 12,
                h: 44,
            };
        }
        // ── Level 3 specific targets ────────────────────────
        if (key === "towerAnchor") {
            // Two narrow spotlights, one per tower beam. The towers don't
            // sit exactly at lX/rX (the level config offsets them by ±36),
            // so we just take the tallest fixed non-builtin node on each
            // side of midX. Each rect hugs the steel mast from its anchor
            // top down to road level.
            const above = state.nodes.filter(n => n.fixed && !n.builtin && n.y < Math.min(lY, rY));
            const left  = above.filter(n => n.x <  midX).sort((a, b) => a.y - b.y)[0];
            const right = above.filter(n => n.x >= midX).sort((a, b) => a.y - b.y)[0];
            const beamRect = (top, baseWY) => {
                const p = toScreen(top.x, top.y);
                const baseY = toScreen(top.x, baseWY).y;
                const w = 56;
                return { x: p.x - w / 2, y: p.y - 18, w, h: (baseY - p.y) + 18 };
            };
            const rects = [];
            if (left)  rects.push(beamRect(left,  lY));
            if (right) rects.push(beamRect(right, rY));
            if (rects.length === 2) return rects;
            if (rects.length === 1) return rects[0];
            return { x: 0, y: H * 0.05, w: W, h: H * 0.6 };
        }
        if (key === "ropeSlot") {
            const ropeIdx = (lvlDef.materials || []).indexOf("rope");
            if (ropeIdx >= 0) {
                return { x: tb.matX[ropeIdx] - 4, y: tb.simBtn.y - 4, w: tb.matBtnW + 8, h: 40 };
            }
            return { x: tb.matX[0] - 4, y: tb.simBtn.y - 4, w: tb.matBtnW + 8, h: 40 };
        }
        if (key === "ropeCount") {
            return { x: W * 0.1, y: H * 0.05, w: W * 0.8, h: H * 0.8 };
        }
        if (key === "creative") {
            // Spotlight the entire build area: from the tower tops down to
            // the waterline, framed by the two cliff anchors. Use the
            // tallest fixed node on each side of midX (towers don't sit
            // exactly at lX/rX); fall back to a centered region if neither
            // exists.
            const above = state.nodes.filter(n => n.fixed && !n.builtin && n.y < Math.min(lY, rY));
            const lTop  = above.filter(n => n.x <  midX).sort((a, b) => a.y - b.y)[0];
            const rTop  = above.filter(n => n.x >= midX).sort((a, b) => a.y - b.y)[0];
            const topY = lTop && rTop
                ? Math.min(toScreen(lTop.x, lTop.y).y, toScreen(rTop.x, rTop.y).y) - 30
                : H * 0.15;
            const botY = toScreen(lX, Math.max(lY, rY)).y + 80;
            // Extend horizontally past the cliff edges so the RV on the
            // left approach AND the goal flag on the right approach both
            // sit inside the highlight. Vehicle starts at lX + vStartX
            // (default -55, level 3 uses -110); flag is at rX + 80.
            const leftPad  = Math.abs(lvlDef.vStartXOffset ?? -55) + 60;
            const rightPad = 80 + 60;
            const leftX  = toScreen(lX - leftPad,  lY).x;
            const rightX = toScreen(rX + rightPad, rY).x;
            return { x: leftX, y: topY, w: rightX - leftX, h: botY - topY };
        }
        return { x: 0, y: 0, w: W, h: H };
    }

    function handleTutorialClick() {
        const step = TUTORIAL_STEPS[state.tutorialStep];
        if (!step) { state.tutorialActive = false; return; }
        // First click finishes the typing animation, second click advances.
        if (state.tutorialTyped < step.text.length) {
            state.tutorialTyped = step.text.length;
            return;
        }
        // For interactive steps, the player has to actually perform the
        // action (e.g. double-click the material slot) — no clickthrough.
        // Auto-advance is handled in drawTutorialOverlay.
        if (step.awaitExpand) return;
        state.tutorialStep++;
        state.tutorialTyped = 0;
        if (state.tutorialStep >= TUTORIAL_STEPS.length) {
            state.tutorialActive = false;
        }
    }

    // Cache the tutorial spotlight rect by step. Building it can be costly
    // (filters + sorts over state.nodes, getToolbar(), toScreen, etc.) and
    // the result is stable for the duration of a step — anchors don't move
    // and the toolbar layout doesn't change while the tutorial is open.
    let _tutTgtCache = null;
    let _tutTgtCacheStep = -1;
    function tutorialTargetCached(stepObj) {
        if (state.tutorialStep === _tutTgtCacheStep && _tutTgtCache) return _tutTgtCache;
        _tutTgtCache = getTutorialTarget(stepObj.key);
        _tutTgtCacheStep = state.tutorialStep;
        return _tutTgtCache;
    }

    function drawTutorialOverlay() {
        let step = TUTORIAL_STEPS[state.tutorialStep];
        if (!step) { state.tutorialActive = false; return; }
        const W = k.width();
        const H = k.height();
        const dt = k.dt() || 1 / 60;
        const t = k.time();

        // Advance the typing reveal — ~42 characters per second feels snappy
        // without being instant.
        let typingDone = state.tutorialTyped >= step.text.length;
        if (!typingDone) {
            state.tutorialTyped = Math.min(step.text.length, state.tutorialTyped + dt * 42);
            typingDone = state.tutorialTyped >= step.text.length;
        }

        // Interactive steps auto-advance the moment the player performs the
        // gating action (e.g. double-clicks the material slot to reveal the
        // upgrade). Wait until the typing finishes so they actually read it.
        // We re-bind `step` to the new step in-place rather than returning —
        // returning would skip the dim/spotlight draw for one frame, creating
        // a visible flash.
        if (typingDone && step.awaitExpand && state.matExpanded.has(step.awaitExpand)) {
            state.tutorialStep++;
            state.tutorialTyped = 0;
            if (state.tutorialStep >= TUTORIAL_STEPS.length) {
                state.tutorialActive = false;
                return;
            }
            step = TUTORIAL_STEPS[state.tutorialStep];
            typingDone = false;
        }

        // ─── Dim backdrop with cutouts around the target rect(s) ───
        // Supports either a single rect or an array of rects (e.g. one per
        // tower on level 3). We dim the union bounding box's exterior with
        // four bands, then for multi-rect targets paint dim back over the
        // gap regions inside the union that aren't covered by any rect.
        const tgtRaw = tutorialTargetCached(step);
        const tgts = Array.isArray(tgtRaw) ? tgtRaw : [tgtRaw];
        const dim = "#010101";
        const dimA = 0.55;
        // Compute union bounds with a plain loop — the original `Math.min(...arr.map(...))`
        // pattern allocates a small array per call (4 calls × every frame).
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < tgts.length; i++) {
            const r = tgts[i];
            if (r.x < minX) minX = r.x;
            if (r.y < minY) minY = r.y;
            const rRight = r.x + r.w;
            const rBot   = r.y + r.h;
            if (rRight > maxX) maxX = rRight;
            if (rBot   > maxY) maxY = rBot;
        }
        // Outer four bands
        k.drawRect({ pos: k.vec2(0, 0), width: W, height: Math.max(0, minY), color: colorOf(dim), opacity: dimA, anchor: "topleft" });
        k.drawRect({ pos: k.vec2(0, maxY), width: W, height: Math.max(0, H - maxY), color: colorOf(dim), opacity: dimA, anchor: "topleft" });
        k.drawRect({ pos: k.vec2(0, minY), width: Math.max(0, minX), height: maxY - minY, color: colorOf(dim), opacity: dimA, anchor: "topleft" });
        k.drawRect({ pos: k.vec2(maxX, minY), width: Math.max(0, W - maxX), height: maxY - minY, color: colorOf(dim), opacity: dimA, anchor: "topleft" });
        // For multi-rect targets, dim the inside-union gaps too. We sort
        // the rects left-to-right and dim the horizontal gaps between
        // each adjacent pair plus any top/bottom slack against the union.
        if (tgts.length > 1) {
            const sorted = [...tgts].sort((a, b) => a.x - b.x);
            for (let i = 0; i < sorted.length; i++) {
                const r = sorted[i];
                if (r.y > minY) {
                    k.drawRect({ pos: k.vec2(r.x, minY), width: r.w, height: r.y - minY, color: colorOf(dim), opacity: dimA, anchor: "topleft" });
                }
                if (r.y + r.h < maxY) {
                    k.drawRect({ pos: k.vec2(r.x, r.y + r.h), width: r.w, height: maxY - (r.y + r.h), color: colorOf(dim), opacity: dimA, anchor: "topleft" });
                }
                if (i < sorted.length - 1) {
                    const next = sorted[i + 1];
                    const gapX = r.x + r.w;
                    const gapW = next.x - gapX;
                    if (gapW > 0) {
                        k.drawRect({ pos: k.vec2(gapX, minY), width: gapW, height: maxY - minY, color: colorOf(dim), opacity: dimA, anchor: "topleft" });
                    }
                }
            }
        }

        // Pulsing highlight ring around each spotlight rect.
        const ringPulse = 0.5 + 0.5 * Math.sin(t * 4);
        const ringCol = "#ffd479";
        for (const r of tgts) {
            for (let ring = 3; ring >= 1; ring--) {
                k.drawRect({
                    pos: k.vec2(r.x - ring, r.y - ring),
                    width: r.w + ring * 2, height: r.h + ring * 2,
                    fill: false,
                    outline: { width: 2, color: colorOf(ringCol) },
                    opacity: (0.3 + 0.35 * ringPulse) * (ring === 1 ? 1 : 0.35 / ring),
                    anchor: "topleft",
                    radius: 4,
                });
            }
        }
        // Use the union bounding box for panel placement below.
        const tgt = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

        // ─── Text panel — opposite side of the spotlight ───
        // If the target sits in the top half, drop the panel to the bottom;
        // otherwise float it near the top. Keeps it out of the way of the arrow.
        const panelW = Math.min(480, W - 60);
        const panelH = 140;
        const panelX = Math.round((W - panelW) / 2);
        const targetCY = tgt.y + tgt.h / 2;
        const panelY = targetCY < H / 2 ? H - panelH - 30 : 30;

        // Sticky-note card (matches the hint panel vocabulary)
        k.drawRect({ pos: k.vec2(panelX + 3, panelY + 4), width: panelW, height: panelH, color: colorOf("#000000"), opacity: 0.35, anchor: "topleft", radius: 3 });
        k.drawRect({ pos: k.vec2(panelX, panelY), width: panelW, height: panelH, color: colorOf("#fff9c4"), anchor: "topleft", radius: 2 });
        k.drawRect({ pos: k.vec2(panelX + panelW / 2 - 28, panelY - 6), width: 56, height: 14, color: colorOf(C.tape), anchor: "topleft", opacity: 0.55 });

        // Title
        k.drawText({
            text: step.title,
            pos: k.vec2(panelX + 16, panelY + 14),
            size: 14,
            font: "PressStart2P",
            color: colorOf(C.markerBlue),
        });
        // Step counter (e.g. "2 / 6") in the top-right corner
        k.drawText({
            text: `${state.tutorialStep + 1} / ${TUTORIAL_STEPS.length}`,
            pos: k.vec2(panelX + panelW - 16, panelY + 14),
            size: 9,
            font: "PressStart2P",
            color: colorOf(C.pencil),
            opacity: 0.55,
            anchor: "topright",
        });

        // Typed body text with a blinking caret at the end while typing.
        const shown = Math.floor(state.tutorialTyped);
        const body = step.text.slice(0, shown);
        const caret = (!typingDone && Math.floor(t * 2) % 2 === 0) ? "|" : "";
        k.drawText({
            text: body + caret,
            pos: k.vec2(panelX + 16, panelY + 44),
            size: 18,
            font: "PatrickHand",
            color: colorOf(C.pencil),
            width: panelW - 32,
            lineSpacing: 4,
        });

        // Click-to-continue hint — only once the line is fully typed. For
        // interactive steps, prompt the action instead of "click to continue".
        if (typingDone) {
            const pulse = 0.55 + 0.45 * Math.sin(t * 5);
            const isLast = state.tutorialStep === TUTORIAL_STEPS.length - 1;
            const prompt = step.awaitExpand
                ? "DOUBLE-CLICK TO TRY IT"
                : (isLast ? "CLICK TO START" : "CLICK TO CONTINUE");
            k.drawText({
                text: prompt,
                pos: k.vec2(panelX + panelW - 16, panelY + panelH - 14),
                size: 9,
                font: "PressStart2P",
                color: colorOf(step.awaitExpand ? C.markerGreen : C.markerBlue),
                opacity: pulse,
                anchor: "botright",
            });
        }
    }

    // ─── Pulsing glow around the members the AI just placed ─────────
    // Uses the same vocabulary as the tutorial's spotlight ring: a couple of
    // outline rings stacked at decreasing opacity, breathing on a sine.
    function drawAiBuildHighlight(sc) {
        if (state.aiHighlightTimer <= 0 || !state.aiHighlightMembers?.length) return;
        const t = k.time();
        const fade = Math.min(1, state.aiHighlightTimer / 1.6);
        const pulse = 0.5 + 0.5 * Math.sin(t * 5);
        const haloCol = colorOf("#ffd479");
        for (const m of state.aiHighlightMembers) {
            if (!m || m.broken) continue;
            const p1 = toScreen(m.n1.x, m.n1.y);
            const p2 = toScreen(m.n2.x, m.n2.y);
            const mat = MATERIALS[m.type];
            const baseW = (mat?.width || 6) * sc + 4;
            // Three fattening lines for a soft glow
            for (let g = 3; g >= 1; g--) {
                k.drawLine({
                    p1, p2,
                    width: baseW + g * 4,
                    color: haloCol,
                    opacity: fade * (0.18 + 0.22 * pulse) / g,
                });
            }
            // Endpoint accent dots
            for (const p of [p1, p2]) {
                k.drawCircle({
                    pos: p, radius: 7 + pulse * 1.5,
                    fill: false,
                    outline: { width: 2, color: haloCol },
                    opacity: fade * (0.45 + 0.35 * pulse),
                });
            }
        }
    }

    // ─── AI helper panel — typed-out coach with dim backdrop ───────────
    // Visual vocabulary borrowed from the tutorial overlay so it reads as
    // "instructor talking to you" rather than a passive sidebar:
    //   • full-screen dim backdrop (slightly less than the tutorial so the
    //     bridge is still visible — the lesson is teaching about it)
    //   • centered wooden card with a robot avatar
    //   • title + explanation type out at ~60 chars/sec with a blinking caret
    //   • CLICK or press the button to fast-forward typing, click again to
    //     build & advance
    function drawAiPanel() {
        state.aiOptionRects = [];
        state.aiNextRect = null;
        if (!state.aiPanelOpen) return;

        const W = k.width();
        const H = k.height();
        const t = k.time();
        const lesson = state.aiResult;
        const hasSteps = lesson && Array.isArray(lesson.steps);

        // Dim backdrop
        k.drawRect({ pos: k.vec2(0, 0), width: W, height: H, color: colorOf("#010101"), opacity: 0.32, anchor: "topleft" });

        // Panel sized for legibility — fixed wide card centered horizontally,
        // anchored a bit above bottom so the spotlit members below stay visible.
        const panelW = Math.min(560, W * 0.62);
        const padX = 22;
        const padY = 18;

        const estLines = (text, width) => {
            const cpl = Math.max(8, Math.floor((width - 4) / 5.8));
            return Math.max(1, Math.ceil((text || "").length / cpl));
        };
        const estHeight = (text, size, lineSpacing, width) =>
            estLines(text, width) * (size + lineSpacing);

        let panelH = 180;
        let titleH = 0, explH = 0;

        if (state.aiLoading) {
            panelH = 130;
        } else if (hasSteps) {
            const step = lesson.steps[state.aiStepIdx];
            const innerW = panelW - padX * 2 - 64; // 64 leaves room for robot avatar
            if (state.aiPhase === "step" && step) {
                titleH = estHeight(step.title || "Step", 22, 4, innerW);
                explH  = estHeight(step.explanation || "", 18, 5, innerW);
                panelH = padY + 38 + titleH + 10 + explH + 60 + padY;
            } else if (state.aiPhase === "done") {
                const sumH = estHeight(lesson.summary || "", 18, 5, innerW);
                panelH = padY + 38 + 28 + sumH + 60 + padY;
            }
        } else if (state.aiResult?.error) {
            panelH = padY + 38 + estHeight(state.aiResult.error, 18, 5, panelW - padX * 2) + padY + 12;
        } else if (state.aiResult?.explanation) {
            panelH = padY + 38 + 28 + estHeight(state.aiResult.explanation, 18, 5, panelW - padX * 2) + padY + 12;
        }

        const px = Math.round((W - panelW) / 2);
        // Position toward the top so the bridge area below stays visible.
        const py = 60;

        // ── Wooden-card frame (matches modal/leaderboard styling) ──
        k.drawRect({ pos: k.vec2(px + 4, py + 6), width: panelW, height: panelH, color: colorOf("#000000"), opacity: 0.4, anchor: "topleft", radius: 6 });
        k.drawRect({ pos: k.vec2(px - 3, py - 3), width: panelW + 6, height: panelH + 6, color: colorOf("#5a3210"), anchor: "topleft", radius: 6 });
        k.drawRect({ pos: k.vec2(px, py), width: panelW, height: panelH, color: colorOf("#fff5d0"), anchor: "topleft", radius: 5 });
        // Top gold highlight
        k.drawRect({ pos: k.vec2(px + 8, py + 6), width: panelW - 16, height: 4, color: colorOf("#ffe9a8"), opacity: 0.5, anchor: "topleft", radius: 2 });
        // Tape strip
        k.drawRect({ pos: k.vec2(px + panelW / 2 - 28, py - 8), width: 56, height: 14, color: colorOf(C.tape), anchor: "topleft", opacity: 0.65 });

        // Robot avatar bobbing in the corner — gives the panel a "coach" feel
        const avX = px + 32;
        const avY = py + 36 + Math.sin(t * 2.4) * 2;
        // Soft glow behind the avatar (so it pops against the cream)
        k.drawCircle({ pos: k.vec2(avX, avY + 2), radius: 19, color: colorOf(C.markerBlue), opacity: 0.18 });
        drawRobotIcon(avX, avY, C.markerBlue);

        // Header — "AI HELPER" + step counter
        k.drawText({ text: "AI HELPER", pos: k.vec2(px + padX + 50, py + padY), size: 11, font: "PressStart2P", color: colorOf(C.markerBlue) });
        if (hasSteps) {
            const totalSteps = lesson.steps.length;
            k.drawText({
                text: `Step ${Math.min(state.aiStepIdx + 1, totalSteps)} / ${totalSteps}`,
                pos: k.vec2(px + panelW - padX, py + padY),
                size: 11, font: "PressStart2P", color: colorOf(C.pencil), opacity: 0.55, anchor: "topright",
            });
        }

        // Loading state — typing dots
        if (state.aiLoading) {
            const dots = ".".repeat(1 + (Math.floor(t * 3) % 3));
            k.drawText({
                text: "Thinking" + dots,
                pos: k.vec2(px + padX + 50, py + padY + 32),
                size: 22, font: "PatrickHand", color: colorOf(C.pencil), opacity: 0.7,
            });
            return;
        }

        if (state.aiResult?.error) {
            k.drawText({ text: state.aiResult.error, pos: k.vec2(px + padX + 50, py + padY + 32), size: 18, font: "PatrickHand", color: colorOf(C.danger), width: panelW - padX * 2 - 50, lineSpacing: 4 });
            return;
        }

        if (!hasSteps && state.aiResult?.explanation) {
            if (state.aiResult.concept) {
                k.drawText({ text: state.aiResult.concept, pos: k.vec2(px + padX + 50, py + padY + 28), size: 18, font: "PatrickHand", color: colorOf(C.markerGreen) });
            }
            k.drawText({ text: state.aiResult.explanation, pos: k.vec2(px + padX + 50, py + padY + 56), size: 18, font: "PatrickHand", color: colorOf(C.pencil), width: panelW - padX * 2 - 50, lineSpacing: 5 });
            return;
        }

        if (!hasSteps) {
            const beaten = getCompleted().includes(levelIdx);
            const tip = beaten ? "Click the AI button to start." : "Beat this level first to unlock the AI helper!";
            k.drawText({ text: tip, pos: k.vec2(px + padX + 50, py + padY + 32), size: 18, font: "PatrickHand", color: colorOf(C.pencil), opacity: 0.6, width: panelW - padX * 2 - 50, lineSpacing: 4 });
            return;
        }

        const step = lesson.steps[state.aiStepIdx];

        if (state.aiPhase === "step" && step) {
            const titleStr = step.title || "Step";
            const explStr  = step.explanation || "";

            const innerX = px + padX + 50;
            const innerW = panelW - padX * 2 - 60;

            // Title — chunky marker-blue with a hand-written feel
            const titleY = py + padY + 28;
            k.drawText({ text: titleStr, pos: k.vec2(innerX, titleY), size: 22, font: "PatrickHand", color: colorOf(C.markerBlue), width: innerW, lineSpacing: 4 });

            // Gold highlight underline beneath the title — focal cue
            const titleStrW = Math.min(innerW, titleStr.length * 11);
            k.drawRect({
                pos: k.vec2(innerX, titleY + titleH + 1),
                width: titleStrW,
                height: 3,
                color: colorOf("#ffd479"),
                opacity: 0.85,
                anchor: "topleft", radius: 1,
            });

            // Explanation — bigger, more readable than before
            const explY = titleY + titleH + 14;
            k.drawText({ text: explStr, pos: k.vec2(innerX, explY), size: 18, font: "PatrickHand", color: colorOf(C.pencil), width: innerW, lineSpacing: 5 });

            // Build button with a soft pulsing halo
            const btnW = 180, btnH = 36;
            const btnX = px + panelW - btnW - padX;
            const btnY = py + panelH - btnH - padY;
            state.aiNextRect = { x: btnX, y: btnY, w: btnW, h: btnH };
            const isLast = state.aiStepIdx === lesson.steps.length - 1;
            const btnPulse = 0.5 + 0.5 * Math.sin(t * 4);
            k.drawRect({
                pos: k.vec2(btnX - 4, btnY - 4),
                width: btnW + 8, height: btnH + 8,
                color: colorOf(C.markerBlue),
                opacity: 0.18 + 0.22 * btnPulse,
                anchor: "topleft", radius: 6,
            });
            k.drawRect({ pos: k.vec2(btnX + 1, btnY + 2), width: btnW, height: btnH, color: colorOf("#000000"), opacity: 0.3, anchor: "topleft", radius: 4 });
            k.drawRect({ pos: k.vec2(btnX, btnY), width: btnW, height: btnH, color: colorOf(C.markerBlue), anchor: "topleft", radius: 4 });
            const btnLabel = isLast ? "Build & Finish!" : "Build & Next";
            k.drawText({ text: btnLabel, pos: k.vec2(btnX + btnW / 2, btnY + btnH / 2 + 1), size: 12, font: "PressStart2P", color: colorOf("#ffffff"), anchor: "center" });
            return;
        }

        if (state.aiPhase === "done") {
            const innerX = px + padX + 50;
            const innerW = panelW - padX * 2 - 60;
            const bannerY = py + padY + 28;
            k.drawText({ text: "LESSON COMPLETE", pos: k.vec2(innerX, bannerY), size: 13, font: "PressStart2P", color: colorOf(C.markerGreen) });
            k.drawText({ text: lesson.summary || "Great work — hit PLAY to see the bridge in action.", pos: k.vec2(innerX, bannerY + 32), size: 18, font: "PatrickHand", color: colorOf(C.pencil), width: innerW, lineSpacing: 5 });

            const btnW = 130, btnH = 34;
            const btnX = px + panelW - btnW - padX;
            const btnY = py + panelH - btnH - padY;
            state.aiNextRect = { x: btnX, y: btnY, w: btnW, h: btnH };
            const pulse = 0.5 + 0.5 * Math.sin(t * 3.5);
            k.drawRect({ pos: k.vec2(btnX - 4, btnY - 4), width: btnW + 8, height: btnH + 8, color: colorOf(C.markerGreen), opacity: 0.18 + 0.22 * pulse, anchor: "topleft", radius: 6 });
            k.drawRect({ pos: k.vec2(btnX + 1, btnY + 2), width: btnW, height: btnH, color: colorOf("#000000"), opacity: 0.3, anchor: "topleft", radius: 4 });
            k.drawRect({ pos: k.vec2(btnX, btnY), width: btnW, height: btnH, color: colorOf(C.markerGreen), anchor: "topleft", radius: 4 });
            k.drawText({ text: "Close", pos: k.vec2(btnX + btnW / 2, btnY + btnH / 2 + 1), size: 13, font: "PressStart2P", color: colorOf("#ffffff"), anchor: "center" });
        }
    }

    // ─── Modal (result screen) ──────────────────────
    // Modal button positions — kept here so the click handler can reuse them.
    // Y values are offsets from the modal center (my). Btn3's offset depends on
    // whether the AI button is present.
    // Modal layout constants. Button Y positions are computed relative to the
    // modal BOTTOM so they stay pinned to the notebook's bottom ruled lines
    // regardless of how tall the card grows (win vs fail, with/without AI).
    // Modal layout — wooden-board card. Left column: cost + grade up top,
    // big icon buttons across the bottom. Right column: leaderboard takes
    // the full right side. No description text, no per-button labels.
    const MODAL_BTN_SIZE = 62;
    const MODAL_BTN_GAP  = 10;

    function getModalLayout() {
        if (!state.modal) return null;
        const W = k.width(), H = k.height();
        const beaten = getCompleted().includes(levelIdx);
        const hasGrade = state.modal.grade != null;
        const isWin = state.modal.win === true;
        const hasLeaderboard = isWin;

        // Wider, taller card on win (leaderboard takes the right side);
        // compact on fail — title + 3 icons in 4 planks. Win was running
        // a bit too tall and leaving empty space inside the leaderboard;
        // 360 fits 6 rows (top 5 + you) snugly.
        const mw = hasLeaderboard ? Math.min(720, W * 0.88) : 380;
        const mh = hasLeaderboard ? 360 : 160;
        const mx = W / 2, my = H / 2;
        const hh = mh / 2;

        // Inner padding from the card's edge.
        const padX = 28;
        const padTop = 22;
        // Per-modal bottom padding. Win uses a generous gap so the icons
        // sit higher (vertically pulled up off the bottom edge); fail
        // tightens to push icons into the last plank.
        const padBot = hasLeaderboard ? 50 : 12;

        // Title — centered vertically on the top plank for both modals.
        // Plank height is mh / boardCount (5 boards on win, 4 on fail).
        const boardCount = hasLeaderboard ? 5 : 4;
        const boardH = mh / boardCount;
        const titleY = -hh + boardH / 2;

        // Two columns when win; single centered column otherwise.
        const colGap = 24;
        const innerW  = mw - padX * 2;
        const leftColW  = hasLeaderboard ? Math.round((innerW - colGap) * 0.46) : innerW;
        const rightColW = hasLeaderboard ? innerW - colGap - leftColW : 0;
        const colTopY   = titleY + 36;
        const colBotY   = hh - padBot;
        const colHeight = colBotY - colTopY;
        const leftColX  = -mw / 2 + padX;
        const rightColX = hasLeaderboard ? leftColX + leftColW + colGap : 0;

        // Icon-button row anchored to the BOTTOM of the left column.
        const actions = ["menu", "replay"];
        if (beaten) actions.push("ai");
        if (isWin) actions.push("next");
        const rowW = actions.length * MODAL_BTN_SIZE + (actions.length - 1) * MODAL_BTN_GAP;
        // Center the icon row inside the left column (or modal if no leaderboard).
        const colCx = hasLeaderboard ? leftColX + leftColW / 2 : 0;
        const rowStartX = colCx - rowW / 2;
        const rowY = colBotY - MODAL_BTN_SIZE / 2;
        const buttons = {};
        actions.forEach((key, i) => {
            buttons[key] = {
                key,
                cx: rowStartX + MODAL_BTN_SIZE / 2 + i * (MODAL_BTN_SIZE + MODAL_BTN_GAP),
                cy: rowY,
                w: MODAL_BTN_SIZE,
                h: MODAL_BTN_SIZE,
            };
        });

        return {
            mx, my, mw, mh, hh,
            beaten, hasGrade, hasLeaderboard, isWin,
            titleY,
            leftColX, leftColW, leftColCx: colCx,
            rightColX, rightColW,
            colTopY, colHeight,
            buttons, actions,
        };
    }

    function drawModal() {
        const m = state.modal;
        const W = k.width(), H = k.height();
        const cFn = (h) => colorOf(h);

        // Dim backdrop
        k.drawRect({ pos: k.vec2(0, 0), width: W, height: H, color: cFn("#1a0e05"), anchor: "topleft", opacity: 0.55 });

        const L = getModalLayout();
        const { mx, my, mw, mh, hh, beaten, isWin, hasLeaderboard } = L;

        // Soft layered drop shadow — minimal radius so it tracks the
        // near-square corners of the plank stack.
        for (let s = 1; s <= 4; s++) {
            k.drawRect({
                pos: k.vec2(mx + s, my + s + 1),
                width: mw + s, height: mh + s,
                color: cFn("#000000"), anchor: "center", opacity: 0.07, radius: 2,
            });
        }

        const cardLeft = mx - mw / 2;
        const cardRight = mx + mw / 2;
        const cardTop = my - hh;
        const cardBot = my + hh;

        // ── Wooden boards body ──
        // Horizontal planks stacked vertically with dark seam lines between
        // them. Corners stay nearly square (radius 2) so the modal reads as
        // a stack of cut boards, not a rounded rectangle. Grain runs the
        // full width so each plank looks like a single piece of timber.
        // Fail uses one fewer plank so the planks themselves don't shrink.
        const boardCount = isWin ? 5 : 4;
        const boardH = mh / boardCount;
        const boardTints = ["#d37e3d", "#cf7833", "#d68040", "#cb7531", "#d57e3a"];
        // Cracks for fail modals — deterministic per modal so they don't
        // animate. Each crack is a list of (x, y) jitter offsets along a
        // vertical run that crosses one plank.
        const showCracks = !isWin;
        for (let i = 0; i < boardCount; i++) {
            const by = cardTop + i * boardH;
            const tint = boardTints[i % boardTints.length];
            k.drawRect({
                pos: k.vec2(cardLeft, by), width: mw, height: boardH,
                color: cFn(tint), anchor: "topleft",
            });
            // Top highlight stripe (catches light)
            k.drawRect({
                pos: k.vec2(cardLeft, by), width: mw, height: 1.6,
                color: cFn("#e89c4a"), opacity: 0.55, anchor: "topleft",
            });
            // Bottom shadow stripe (the seam to the next plank)
            if (i < boardCount - 1) {
                k.drawRect({
                    pos: k.vec2(cardLeft, by + boardH - 2.4),
                    width: mw, height: 2.4,
                    color: cFn("#3a2110"), opacity: 0.55, anchor: "topleft",
                });
            }
            // Wood grain — drawn as thin full-width rects rather than lines
            // so the streaks reach exactly to the modal's edges (1px lines
            // were tapering off under anti-aliasing).
            const grainOff = (i * 5) % 11;
            for (let g = 0; g < 4; g++) {
                const gy = by + 8 + g * 16 + grainOff;
                if (gy > by + boardH - 6) break;
                k.drawRect({
                    pos: k.vec2(cardLeft, gy),
                    width: mw, height: 0.9,
                    color: cFn("#8e4924"), opacity: 0.22,
                    anchor: "topleft",
                });
            }
            // Knots — every other plank, alternating sides.
            if (i === 1 || i === 3) {
                const knotX = i === 1 ? cardLeft + mw * 0.18 : cardRight - mw * 0.22;
                const knotY = by + boardH * 0.5;
                k.drawCircle({ pos: k.vec2(knotX, knotY), radius: 5.5, color: cFn("#7d4519"), opacity: 0.55 });
                k.drawCircle({ pos: k.vec2(knotX, knotY), radius: 3.5, color: cFn("#5e351a"), opacity: 0.6 });
                k.drawCircle({
                    pos: k.vec2(knotX, knotY), radius: 5.5,
                    fill: false, outline: { width: 0.8, color: cFn("#3a2110") },
                    opacity: 0.5,
                });
            }
            // Random scars + nail holes on every modal. Deterministic from
            // a seed (m.openTime) so they stay put while the modal is up,
            // but vary between sessions / wins / fails. More visible than
            // the previous "subtle" pass — the user wanted them to read.
            {
                const seed = ((m.openTime || 1) * 1000 | 0) ^ (i * 0x9E3779B1) ^ (isWin ? 0xA17 : 0xB42);
                let s = seed >>> 0 || 1;
                const rand = () => {
                    s = (s * 1664525 + 1013904223) >>> 0;
                    return s / 0xFFFFFFFF;
                };
                // Scars — 1 to 3 per plank, varying length and position.
                const scarCount = 1 + Math.floor(rand() * 3);
                for (let sc = 0; sc < scarCount; sc++) {
                    const scarX = cardLeft + mw * (0.05 + rand() * 0.85);
                    const scarLen = 14 + rand() * 38;
                    const scarY = by + boardH * (0.18 + rand() * 0.7);
                    const tilt = (rand() - 0.5) * 1.5;
                    k.drawLine({
                        p1: k.vec2(scarX, scarY),
                        p2: k.vec2(scarX + scarLen, scarY + tilt),
                        width: 1.2, color: cFn("#3a2110"), opacity: 0.6 + rand() * 0.2,
                    });
                    // Lighter inner edge for depth
                    k.drawLine({
                        p1: k.vec2(scarX, scarY + 1.3),
                        p2: k.vec2(scarX + scarLen * (0.4 + rand() * 0.5), scarY + 1.3 + tilt * 0.7),
                        width: 0.7, color: cFn("#5e351a"), opacity: 0.45,
                    });
                }
                // Nail holes — 1 to 3 per plank, scattered.
                const nailCount = 1 + Math.floor(rand() * 3);
                for (let n = 0; n < nailCount; n++) {
                    const nx = cardLeft + mw * (0.05 + rand() * 0.9);
                    const ny = by + boardH * (0.2 + rand() * 0.6);
                    const nr = 1.6 + rand() * 1.0;
                    // Outer ring (slight bevel)
                    k.drawCircle({ pos: k.vec2(nx, ny), radius: nr + 0.6, color: cFn("#7d4519"), opacity: 0.55 });
                    // Hole — dark center
                    k.drawCircle({ pos: k.vec2(nx, ny), radius: nr, color: cFn("#1a0e05"), opacity: 0.78 });
                    // Tiny inner highlight on one side, sells the depth
                    k.drawCircle({ pos: k.vec2(nx - nr * 0.35, ny - nr * 0.35), radius: nr * 0.35, color: cFn("#5e351a"), opacity: 0.5 });
                }
            }

            // Fail-state damage — splintered chips along the bottom seam
            // and a jagged crack snaking across one plank. Deterministic
            // per board so it's stable while the modal is up.
            if (showCracks && (i === 0 || i === 2)) {
                // Splinters poking down from the bottom seam — small dark
                // triangles that look like wood chipping off.
                const splintCount = 4;
                for (let s = 0; s < splintCount; s++) {
                    const sx = cardLeft + mw * (0.18 + s * 0.22) + Math.sin(i * 9.7 + s * 3.1) * 8;
                    const sy = by + boardH - 2;
                    const sw = 4 + Math.sin(i * 4.3 + s * 7.1) * 1.5;
                    const sh = 4 + Math.sin(i * 6.9 + s * 2.3) * 1.8;
                    k.drawTriangle({
                        p1: k.vec2(sx - sw, sy),
                        p2: k.vec2(sx + sw, sy),
                        p3: k.vec2(sx + Math.sin(s * 5.3) * 2, sy + sh),
                        color: cFn("#3a2110"), opacity: 0.6,
                    });
                }
            }
            if (showCracks && i === 1) {
                // A jagged crack zigzagging vertically across this plank.
                const crackTop = by + 4;
                const crackBot = by + boardH - 4;
                const baseX = cardLeft + mw * 0.62;
                const segs = 7;
                let prevX = baseX, prevY = crackTop;
                for (let s = 1; s <= segs; s++) {
                    const t = s / segs;
                    // Pseudo-random jitter, deterministic on segment index.
                    const jx = baseX + Math.sin(s * 12.91) * 7;
                    const jy = crackTop + (crackBot - crackTop) * t;
                    k.drawLine({
                        p1: k.vec2(prevX, prevY), p2: k.vec2(jx, jy),
                        width: 1.6, color: cFn("#1a0e05"), opacity: 0.78,
                    });
                    // Subtle inner highlight, half-width, makes the crack
                    // read as having depth instead of being a flat line.
                    k.drawLine({
                        p1: k.vec2(prevX + 0.6, prevY), p2: k.vec2(jx + 0.6, jy),
                        width: 0.6, color: cFn("#8e4924"), opacity: 0.5,
                    });
                    prevX = jx; prevY = jy;
                }
            }
        }
        // Outer outline — square-ish corners to match the plank stack.
        k.drawRect({
            pos: k.vec2(mx, my), width: mw, height: mh,
            fill: false, outline: { width: 1.6, color: cFn("#3a2110") },
            anchor: "center", radius: 2, opacity: 0.75,
        });

        // ── Title ──
        // Win: green title with green underline (success cue).
        // Fail: title carved into the wood — dark fill + faint cream
        // highlight just below the strokes for a chiseled look. The red
        // marker color clashed with the wooden body.
        const elapsed0 = m.openTime != null ? Math.max(0, k.time() - m.openTime) : 2;
        const titleY = my + L.titleY;
        const titleSz = 18;
        const easeBack = (x) => {
            if (x >= 1) return 1;
            const c1 = 1.7, c3 = c1 + 1;
            return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
        };
        const titleAnimDur = 0.35;
        const titleT = Math.min(1, elapsed0 / titleAnimDur);
        const titleScale = Math.max(0, easeBack(titleT));
        const titleBob = titleT >= 1 ? Math.sin(k.time() * 1.4) * 0.6 : 0;

        // ── Hot-iron branding ─────────────────────────────────
        // Both win and fail use the same brand-and-cool animation: the
        // title pretends to be branded into the wood with a glowing iron
        // rod, then cools down to its final color. Win cools to bright
        // green (success cue); fail cools to dark carved brown.
        const lerpHex = (a, b, t) => {
            const ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
            const br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
            const r = Math.round(ar + (br - ar) * t);
            const g = Math.round(ag + (bg - ag) * t);
            const bl = Math.round(ab + (bb - ab) * t);
            return "#" + [r, g, bl].map(c => c.toString(16).padStart(2, "0")).join("");
        };
        const burnDur = 1.6;
        const burnT = Math.min(1, elapsed0 / burnDur);
        // Color stops: shared red-hot start, both modals cool to the same
        // carved brown — the wood absorbs the heat the same way regardless
        // of whether you won or lost. The green title was reading as
        // disconnected from the wooden theme.
        const STOPS = ["#e60a0a", "#b81a0c", "#7a2510", "#3a2110"];
        let burnColor;
        if (burnT < 0.35) {
            burnColor = lerpHex(STOPS[0], STOPS[1], burnT / 0.35);
        } else if (burnT < 0.70) {
            burnColor = lerpHex(STOPS[1], STOPS[2], (burnT - 0.35) / 0.35);
        } else {
            burnColor = lerpHex(STOPS[2], STOPS[3], (burnT - 0.70) / 0.30);
        }
        // Subtle flicker while still hot.
        const flicker = burnT < 0.45 ? Math.sin(k.time() * 28) * 0.06 : 0;

        k.pushTransform();
        k.pushTranslate(mx, titleY + titleBob);
        k.pushScale(titleScale, titleScale);

        // Hot glow behind the text — fades out as it cools. Uses orange
        // tones regardless of final color; that's the iron radiating heat,
        // independent of what color the brand cools to.
        const glowOpacity = Math.max(0, 1 - burnT * 1.4);
        if (glowOpacity > 0.02) {
            for (let p = 0; p < 4; p++) {
                const oc = lerpHex("#ff7a14", "#ffd166", p / 3);
                k.drawText({
                    text: m.title, pos: k.vec2(0, 0),
                    size: titleSz + p * 1.3, font: "PressStart2P",
                    color: cFn(oc), anchor: "center",
                    opacity: glowOpacity * (0.18 - p * 0.025),
                });
            }
        }
        // Carved cream highlight (the routed-out edge of the brand) fades
        // in as the iron cools — gives both win and fail engravings the
        // same finished look at the end of the animation.
        const carvedHighlightOp = Math.max(0, Math.min(1, (burnT - 0.55) / 0.40)) * 0.45;
        if (carvedHighlightOp > 0.01) {
            k.drawText({
                text: m.title, pos: k.vec2(1, 2),
                size: titleSz, font: "PressStart2P",
                color: cFn("#fff8e0"), opacity: carvedHighlightOp,
                anchor: "center",
            });
        }
        // Main letter face — lerped from hot to final.
        k.drawText({
            text: m.title, pos: k.vec2(0, 0),
            size: titleSz, font: "PressStart2P",
            color: cFn(burnColor),
            opacity: 1 - flicker * 0.5,
            anchor: "center",
        });
        k.popTransform();

        // ── Embers / sparks rising off the brand ─────────────────
        // Deterministic per-ember cycle based on absolute time + a phase
        // offset. Embers spawn at the title's lower edge, drift up + a
        // touch sideways, and fade out. Emission intensity decays with
        // burnT so the sparks die down as the iron cools. Fires for both
        // win and fail — same hot-iron branding.
        {
            const titleW = m.title.length * (titleSz * 0.65);
            const emberCount = 14;
            const emitStrength = Math.max(0, 1 - burnT * 0.85);
            if (emitStrength > 0.05) {
                const t = k.time();
                for (let e = 0; e < emberCount; e++) {
                    const cycle = 0.55 + (e % 3) * 0.13;
                    const seedPhase = (e * 0.713) % 1;
                    const phase = ((t + seedPhase) % cycle) / cycle;     // 0 → 1 within cycle
                    const xOffset = Math.sin(e * 17.31) * titleW * 0.5;
                    const xDrift = Math.sin(e * 4.7 + phase * 6) * 4;
                    const yRise  = -phase * 26;
                    const ex = mx + xOffset + xDrift;
                    const ey = titleY + titleBob + titleSz * 0.4 + yRise;
                    // Color: bright yellow at spawn, fading to red, then transparent
                    const colT = phase;
                    let c = colT < 0.45
                        ? "#fff1a0"             // hot bright spark
                        : colT < 0.75 ? "#ff9a2a" : "#c43818";
                    const op = (1 - phase) * 0.85 * emitStrength;
                    const r = 1.4 + (1 - phase) * 1.5;
                    k.drawCircle({ pos: k.vec2(ex, ey), radius: r, color: cFn(c), opacity: op });
                    // Small bright core for the closest sparks
                    if (phase < 0.4) {
                        k.drawCircle({
                            pos: k.vec2(ex, ey), radius: r * 0.5,
                            color: cFn("#ffffff"), opacity: op * 0.85,
                        });
                    }
                }
                // Occasional puff — thicker, slower particles every few embers.
                for (let p = 0; p < 4; p++) {
                    const cycle = 1.2;
                    const seedPhase = (p * 0.31) % 1;
                    const t2 = k.time();
                    const phase = ((t2 + seedPhase) % cycle) / cycle;
                    const xOffset = Math.sin(p * 9.13) * titleW * 0.35;
                    const yRise  = -phase * 36;
                    const ex = mx + xOffset;
                    const ey = titleY + titleBob + titleSz * 0.3 + yRise;
                    const op = (1 - phase) * 0.4 * emitStrength;
                    const r = 2.2 + phase * 2.5;
                    k.drawCircle({ pos: k.vec2(ex, ey), radius: r, color: cFn("#888888"), opacity: op });
                }
            }
        }

        // ── Fail-modal subtitle ─────────────────────────────
        // Short flavor line in the plank below the title — fades in just
        // as the brand finishes cooling so it doesn't fight the burn.
        // Same fake-bold trick (triple draw at 0.5px offsets) so the thin
        // PatrickHand strokes read at icon scale.
        if (!isWin && m.desc) {
            const descT = Math.max(0, Math.min(1, (elapsed0 - 0.6) / 0.4));
            const descScreenY = my + L.titleY + 38;
            k.drawText({
                text: m.desc, pos: k.vec2(mx + 1, descScreenY + 2),
                size: 20, font: "PatrickHand",
                color: cFn("#1a0e05"), opacity: 0.5 * descT,
                anchor: "center", width: mw - 60, align: "center",
            });
            for (const ox of [-0.5, 0, 0.5]) {
                k.drawText({
                    text: m.desc, pos: k.vec2(mx + ox, descScreenY),
                    size: 20, font: "PatrickHand",
                    color: cFn("#fff8e0"), opacity: 0.95 * descT,
                    anchor: "center", width: mw - 60, align: "center",
                });
            }
        }

        // ── LEFT COLUMN: cost + flavor line + grade ──
        const colTopY = my + L.colTopY;
        const leftCx = mx + (L.leftColCx || (L.leftColX + L.leftColW / 2));
        const elapsed = m.openTime != null ? Math.max(0, k.time() - m.openTime) : 2;

        if (m.cost != null) {
            // Faint "COST" header in pixel font, then the value in a bigger
            // PressStart2P below it for a "stamped" look that matches the
            // wood theme.
            k.drawText({
                text: "COST",
                pos: k.vec2(leftCx, colTopY + 8),
                size: 9, font: "PressStart2P",
                color: cFn("#fff8e0"), opacity: 0.65,
                anchor: "center",
            });
            k.drawText({
                text: `$${m.cost.toLocaleString()}`,
                pos: k.vec2(leftCx + 2, colTopY + 32),
                size: 16, font: "PressStart2P",
                color: cFn("#1a0e05"), opacity: 0.40,
                anchor: "center",
            });
            k.drawText({
                text: `$${m.cost.toLocaleString()}`,
                pos: k.vec2(leftCx, colTopY + 30),
                size: 16, font: "PressStart2P",
                color: cFn("#fffce6"),
                anchor: "center",
            });
        }
        // Flavor subtitle between cost and grade — short message, fades in.
        // Bolded by drawing the cream pass twice with a sub-pixel offset
        // so the strokes thicken (PatrickHand is otherwise pretty thin).
        if (isWin && m.desc) {
            const subT = Math.max(0, Math.min(1, (elapsed - 0.4) / 0.4));
            const subY = colTopY + 56;
            k.drawText({
                text: m.desc, pos: k.vec2(leftCx + 1, subY + 2),
                size: 19, font: "PatrickHand",
                color: cFn("#1a0e05"), opacity: 0.5 * subT,
                anchor: "center", width: L.leftColW - 16, align: "center",
            });
            for (const ox of [-0.5, 0, 0.5]) {
                k.drawText({
                    text: m.desc, pos: k.vec2(leftCx + ox, subY),
                    size: 19, font: "PatrickHand",
                    color: cFn("#fff8e0"), opacity: 0.95 * subT,
                    anchor: "center", width: L.leftColW - 16, align: "center",
                });
            }
        }
        if (m.grade != null) {
            // Grade medallion sits below the subtitle, centered in the column.
            drawGrade(leftCx, colTopY + 102, m.grade, elapsed);
        }

        // ── RIGHT COLUMN: leaderboard panel (recessed inset) ──
        if (hasLeaderboard) {
            const lb = m.leaderboard;
            const panelX = mx + L.rightColX;
            const panelY = colTopY;
            const panelW = L.rightColW;
            const panelH = L.colHeight - 6;       // slim margin off the bottom edge
            // Recessed inset — darker wood with inner shadow at the top.
            k.drawRect({
                pos: k.vec2(panelX, panelY),
                width: panelW, height: panelH,
                color: cFn("#a35e22"), anchor: "topleft", radius: 4,
            });
            // Inner top shadow (depth)
            k.drawRect({
                pos: k.vec2(panelX, panelY),
                width: panelW, height: 2,
                color: cFn("#3a2110"), anchor: "topleft", opacity: 0.45,
            });
            // Inner bottom highlight (rebound light)
            k.drawRect({
                pos: k.vec2(panelX, panelY + panelH - 1),
                width: panelW, height: 1,
                color: cFn("#e89c4a"), anchor: "topleft", opacity: 0.55,
            });
            // Outline
            k.drawRect({
                pos: k.vec2(panelX, panelY),
                width: panelW, height: panelH,
                fill: false, outline: { width: 1, color: cFn("#3a2110") },
                anchor: "topleft", radius: 4, opacity: 0.6,
            });

            // Header — "RANK X / N · TOP P%" or loading
            const headerY = panelY + 18;
            const headerText = lb && lb.userRank
                ? `RANK ${lb.userRank}/${lb.totalPlayers}`
                : (lb ? "LEADERBOARD" : "LOADING…");
            k.drawText({
                text: headerText, pos: k.vec2(panelX + panelW / 2, headerY),
                size: 11, font: "PressStart2P",
                color: cFn("#fff8e0"), anchor: "center",
            });
            // Subheader — top percentile in a smaller, accent color
            if (lb && lb.userPercentile != null) {
                k.drawText({
                    text: `TOP ${100 - lb.userPercentile + 1}%`,
                    pos: k.vec2(panelX + panelW / 2, headerY + 14),
                    size: 8, font: "PressStart2P",
                    color: cFn("#ffd479"), anchor: "center",
                });
            }
            // PB badge
            if (lb && lb.isPB) {
                k.drawText({
                    text: "★ NEW BEST",
                    pos: k.vec2(panelX + panelW / 2, headerY + 28),
                    size: 8, font: "PressStart2P",
                    color: cFn("#ffe17a"), anchor: "center",
                });
            }

            // Entry rows — staggered fade-in starting after the header lands.
            if (lb) {
                const top5 = lb.top.slice(0, 5);
                const userInTop5 = top5.some(e => e.isYou);
                const rows = top5.slice();
                if (!userInTop5 && lb.userEntry && lb.userRank) {
                    rows.push({ ...lb.userEntry, _rank: lb.userRank, _separated: true });
                }
                const rowsStartY = headerY + (lb.isPB ? 44 : 36);
                const rowH = 28;
                const rowL = panelX + 14;
                const rowR = panelX + panelW - 14;
                const rowMidName = panelX + 44;
                const rowFontSize = 17;
                // Stagger animation: first row appears at 0.35s, then 0.10s
                // apart. Each row eases over 0.35s (slide up + fade).
                const rowEntryDelay = 0.35;
                const rowStaggerGap = 0.10;
                const rowAnimDur    = 0.35;
                for (let i = 0; i < rows.length; i++) {
                    const e = rows[i];
                    const startAt = rowEntryDelay + i * rowStaggerGap;
                    const rowT = Math.max(0, Math.min(1, (elapsed - startAt) / rowAnimDur));
                    if (rowT <= 0) continue;
                    const rowEase = 1 - Math.pow(1 - rowT, 3);
                    const slideY  = (1 - rowEase) * 8;          // slide up 8 px
                    const rowAlpha = rowEase;
                    const rowY = rowsStartY + i * rowH + slideY;

                    if (e._separated) {
                        k.drawText({
                            text: "·  ·  ·", pos: k.vec2(panelX + panelW / 2, rowY - 14),
                            size: 14, font: "PatrickHand",
                            color: cFn("#fff8e0"), opacity: 0.5 * rowAlpha,
                            anchor: "center",
                        });
                    }

                    const isYou = !!e.isYou;
                    const rank = e._rank != null ? e._rank : (lb.top.indexOf(e) + 1);
                    const rankStr = `${rank}.`;
                    const nameStr = e.playerName.length > 14 ? e.playerName.slice(0, 13) + "…" : e.playerName;
                    const costStr = `$${e.budgetUsed.toLocaleString()}`;

                    // Alternating row stripe — faint, helps the eye scan rows.
                    if (i % 2 === 0 && !isYou) {
                        k.drawRect({
                            pos: k.vec2(panelX + 4, rowY - 13),
                            width: panelW - 8, height: 26,
                            color: cFn("#7d4519"), opacity: 0.35 * rowAlpha,
                            anchor: "topleft", radius: 3,
                        });
                    }

                    // Highlight the player's row with a brighter glow band
                    // and a left accent bar — pulses gently to draw the eye.
                    if (isYou) {
                        const pulse = 0.55 + 0.20 * Math.sin(k.time() * 3);
                        k.drawRect({
                            pos: k.vec2(panelX + 4, rowY - 13),
                            width: panelW - 8, height: 26,
                            color: cFn("#ffe17a"), opacity: 0.20 * pulse * rowAlpha,
                            anchor: "topleft", radius: 3,
                        });
                        k.drawRect({
                            pos: k.vec2(panelX + 4, rowY - 12),
                            width: 3, height: 24,
                            color: cFn("#fbbf24"), opacity: 0.95 * rowAlpha,
                            anchor: "topleft", radius: 2,
                        });
                    }

                    // Medal colors for the top 3 rank numbers — adds a bit
                    // of personality without making the row hard to scan.
                    const medalColors = ["#fbbf24", "#e5e7eb", "#d6803a"];   // gold, silver, bronze
                    const isMedal = !isYou && rank >= 1 && rank <= 3;
                    const rankColor = isYou ? "#fffce6" : (isMedal ? medalColors[rank - 1] : "#fff8e0");
                    const rowColor  = isYou ? "#fffce6" : "#fff8e0";
                    const rowOp = (isYou ? 1 : 0.92) * rowAlpha;

                    // Rank — rendered in PressStart2P for crisp numerals
                    k.drawText({
                        text: rankStr, pos: k.vec2(rowL, rowY),
                        size: 11, font: "PressStart2P", color: cFn(rankColor),
                        opacity: rowOp, anchor: "left",
                    });
                    // Name (PatrickHand still — its slight slant reads as
                    // signed names rather than data table entries)
                    k.drawText({
                        text: nameStr, pos: k.vec2(rowMidName, rowY),
                        size: rowFontSize, font: "PatrickHand", color: cFn(rowColor),
                        opacity: rowOp, anchor: "left",
                    });
                    // Cost — PressStart2P for crisp digit alignment
                    k.drawText({
                        text: costStr, pos: k.vec2(rowR, rowY),
                        size: 10, font: "PressStart2P", color: cFn(rowColor),
                        opacity: rowOp, anchor: "right",
                    });
                }
            }
        }

        // ── Grade medallion ───────────────────────────────────────
        // Wood-stamped grade plaque: a circular wooden medallion scales-in
        // with a bouncy spring, the letter pops into place on top, and a
        // colored marker arc strokes around it like a teacher's circle.
        // S grade adds a pulsing gold halo + orbiting sparkles for that
        // "you nailed it" punch.
        function drawGrade(cx, cy, letter, t) {
            const gradeColors = {
                S: "#fbbf24",   // bright gold
                A: "#22c55e",   // vibrant green
                B: "#60a5fa",   // sky blue
                C: "#f97316",   // orange
                F: "#ef4444",   // red
            };
            const color = gradeColors[letter] || "#ef4444";
            const writeDur = 0.5, circleDur = 0.7;
            const writeT  = Math.min(1, t / writeDur);
            const circleT = Math.max(0, Math.min(1, (t - writeDur) / circleDur));
            const idleT   = Math.max(0, t - writeDur - circleDur);

            // Spring-out scale (overshoots a bit, settles at 1)
            const easeOutBack = (x) => {
                const c1 = 1.70158, c3 = c1 + 1;
                return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
            };
            const scale = writeT < 1 ? Math.max(0, easeOutBack(writeT)) : 1 + Math.sin(idleT * 2.4) * 0.025;

            // Shimmer for S — lerps between deep gold and a brighter highlight
            let drawColor = color;
            if (letter === "S" && idleT > 0) {
                const phase = idleT * 1.6;
                const v = (Math.sin(phase) + 1) / 2;
                const lerp = (a, b) => Math.round(a + (b - a) * v);
                const r = lerp(0xfb, 0xff), g = lerp(0xbf, 0xe4), b = lerp(0x24, 0x5a);
                drawColor = "#" + [r, g, b].map(c => c.toString(16).padStart(2, "0")).join("");
            }

            // S — pulsing gold halo behind the medallion (only after circle settles)
            if (letter === "S" && idleT > 0) {
                const haloR = 32 + Math.sin(idleT * 2) * 2;
                k.drawCircle({
                    pos: k.vec2(cx, cy), radius: haloR,
                    color: cFn("#ffe17a"),
                    opacity: 0.18 + 0.10 * Math.sin(idleT * 3),
                });
            }

            const medR = 22;

            k.pushTransform();
            k.pushTranslate(cx, cy);
            k.pushScale(scale, scale);

            // Wooden medallion — darker wood than the card so the letter pops.
            k.drawCircle({ pos: k.vec2(0, 1.5), radius: medR, color: cFn("#1a0e05"), opacity: 0.4 });   // shadow
            k.drawCircle({ pos: k.vec2(0, 0), radius: medR, color: cFn("#a35e22") });                  // body
            k.drawCircle({                                                                              // inner highlight
                pos: k.vec2(0, -1), radius: medR - 1.5,
                fill: false, outline: { width: 1, color: cFn("#e89c4a") },
                opacity: 0.45,
            });
            k.drawCircle({                                                                              // outline
                pos: k.vec2(0, 0), radius: medR,
                fill: false, outline: { width: 1.5, color: cFn("#3a2110") },
                opacity: 0.7,
            });

            // Letter — shadow + fill in the grade color. PressStart2P for
            // a chunky "stamped" feel that matches the wood theme.
            const letterSize = 24;
            k.drawText({
                text: letter, pos: k.vec2(1.5, 2),
                size: letterSize, font: "PressStart2P",
                color: cFn("#1a0e05"), opacity: 0.45,
                anchor: "center",
            });
            k.drawText({
                text: letter, pos: k.vec2(0, 0),
                size: letterSize, font: "PressStart2P",
                color: cFn(drawColor),
                anchor: "center",
            });

            k.popTransform();

            // Marker circle — strokes around the medallion clockwise.
            if (circleT > 0) {
                const r = medR + 5;
                const segs = 40;
                const maxA = -Math.PI / 2 + circleT * Math.PI * 2;
                for (let i = 0; i < segs; i++) {
                    const a0 = -Math.PI / 2 + (i / segs) * Math.PI * 2;
                    if (a0 >= maxA) break;
                    const a1 = Math.min(-Math.PI / 2 + ((i + 1) / segs) * Math.PI * 2, maxA);
                    k.drawLine({
                        p1: k.vec2(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r),
                        p2: k.vec2(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r),
                        width: 3, color: cFn(color),
                    });
                }
            }

            // Sparkles orbiting the S grade (after the circle completes)
            if (letter === "S" && idleT > 0) {
                for (let i = 0; i < 4; i++) {
                    const angle = idleT * 0.8 + i * (Math.PI / 2);
                    const dist = 34 + Math.sin(idleT * 1.8 + i) * 2;
                    const sx = cx + Math.cos(angle) * dist;
                    const sy = cy + Math.sin(angle) * dist;
                    const spk = 2.5 + Math.sin(idleT * 3 + i * 0.7) * 1;
                    k.drawCircle({ pos: k.vec2(sx, sy), radius: spk, color: cFn("#ffe17a"), opacity: 0.9 });
                    k.drawLine({ p1: k.vec2(sx - spk - 2, sy), p2: k.vec2(sx + spk + 2, sy), width: 1, color: cFn("#fff7c4"), opacity: 0.9 });
                    k.drawLine({ p1: k.vec2(sx, sy - spk - 2), p2: k.vec2(sx, sy + spk + 2), width: 1, color: cFn("#fff7c4"), opacity: 0.9 });
                }
            }
        }

        // ── Bottom icon-button row ──
        // Just the icons — no plate, no label. Hover scales the icon up
        // and brightens it; the primary action (next-level / try-again)
        // is gold-tinted with a soft pulsing halo behind it so it reads
        // as "click here" without needing a frame.
        const mpos = k.mousePos();
        const dt = k.dt() || 1 / 60;
        const ICONS = {
            menu:   { fn: drawMenuIcon  },
            replay: { fn: (cx, cy, col) => drawCurvedArrow(cx, cy + 1, 11, Math.PI * 0.85, Math.PI * 2.45, col, 2.6) },
            ai:     { fn: drawRobotIcon },
            next:   { fn: drawNextArrow },
        };
        const PRIMARY_KEY = isWin ? "next" : "replay";

        for (const action of L.actions) {
            const btn = L.buttons[action];
            if (!btn) continue;
            const meta = ICONS[action];
            if (!meta) continue;

            const bx = mx + btn.cx, by = my + btn.cy;
            const half = btn.w / 2;
            const hovered = mpos.x >= bx - half && mpos.x <= bx + half
                         && mpos.y >= by - half && mpos.y <= by + half;
            const hoverKey = `modal_${action}`;
            const prev = state.toolHover[hoverKey] || 0;
            state.toolHover[hoverKey] = hovered
                ? Math.min(1, prev + dt * 10)
                : Math.max(0, prev - dt * 12);
            const h = state.toolHover[hoverKey];
            const isPrimary = action === PRIMARY_KEY;

            // Primary gets a soft pulsing halo behind it — "look here".
            if (isPrimary) {
                const pulse = 0.65 + 0.35 * Math.sin(k.time() * 3);
                const haloR = btn.w * 0.55 * (1 + h * 0.1);
                k.drawCircle({
                    pos: k.vec2(bx, by + 1), radius: haloR,
                    color: cFn("#ffd479"),
                    opacity: 0.22 * pulse,
                });
            }

            // Bigger than the toolbar icons since there's no plate to
            // compete with. Primary is gold to anchor the eye. Drawn
            // twice — a dark shadow pass underneath, then the colored
            // icon on top — for tactile depth on the wood.
            const baseScale = isPrimary ? 1.55 : 1.45;
            const scale = baseScale + h * 0.18;
            const iconColor = isPrimary ? "#ffd479" : "#fff8e0";

            k.pushTransform();
            k.pushTranslate(bx + 1.5, by + 2.5);
            k.pushScale(scale, scale);
            meta.fn(0, 0, "#1a0e05");
            k.popTransform();

            k.pushTransform();
            k.pushTranslate(bx, by);
            k.pushScale(scale, scale);
            meta.fn(0, 0, iconColor);
            k.popTransform();
        }
    }
}
