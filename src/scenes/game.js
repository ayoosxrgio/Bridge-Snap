import { C, GRID, MATERIALS, VEHICLES, WORLD_MID_Y, ANCHOR_L_X, PAD_X } from "../constants.js";
import { LEVELS } from "../levels.js";
import { Node, Member, Spark, snapToGrid, distToSegment, isConnectedToAnchor, calcCost, physicsTick, vehicleTick, initPhysicsWorld, destroyPhysicsWorld } from "../physics.js";
import { solveBridge, setApiKey, getApiKey } from "../aiHelper.js";
import { completeLevel, getCompleted } from "../progression.js";
import { onLevelStart, onBridgeFailed, onBridgeSuccess, onLevelComplete, onHintRequest, onRecapRequest } from "../assistantBridge.js";

export function gameScene(k, { levelIdx }) {
    const lvlDef = LEVELS[levelIdx];

    // ─── Camera / coordinate system ─────────────────
    const lX = ANCHOR_L_X;
    const rX = lX + lvlDef.gap;
    const midX = lX + lvlDef.gap / 2;
    const lY = Math.round((WORLD_MID_Y - lvlDef.hDiff / 2) / GRID) * GRID;
    const rY = lY + lvlDef.hDiff;

    const lvl = { gap: lvlDef.gap, hDiff: lvlDef.hDiff, lX, rX, lY, rY, midX, terrain: lvlDef.terrain, vType: lvlDef.vType, budget: lvlDef.budget };

    function getScale() { return k.width() / (lvl.gap + PAD_X * 2); }
    function toScreen(wx, wy) {
        const sc = getScale();
        const offX = PAD_X - ANCHOR_L_X;
        const offY = (k.height() * 0.62) / sc - WORLD_MID_Y;
        return k.vec2((wx + offX) * sc, (wy + offY) * sc);
    }
    function toWorld(sx, sy) {
        const sc = getScale();
        const offX = PAD_X - ANCHOR_L_X;
        const offY = (k.height() * 0.62) / sc - WORLD_MID_Y;
        return { x: sx / sc - offX, y: sy / sc - offY };
    }

    // ─── Game state ─────────────────────────────────
    const state = {
        mode: "build",       // build | sim | end
        delMode: false,
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
        archMode: false,      // arch tool: click A → click B → drag apex handle → click off to commit
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
        editingOldMembers: null,   // stashed members — restored on cancel
        editingOldArchData: null,  // stashed arch record — restored on cancel
        // Undo: each entry is one user action; an action may have placed many
        // members at once (line-fill, arch). Undo pops the latest action and
        // removes everything it added.
        undoStack: [],
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
        // Hint
        hintOpen: true,
        // Lesson panel
        lessonOpen: false,
        // Splash effects
        splashes: [],
        // SNAP! popup + confetti VFX on bridge break
        snapEvents: [],
        snapPopups: [],
        snapConfetti: [],
        // Hover progress [0..1] for modal text buttons — animates the underline
        modalBtnHover: { primary: 0, ai: 0, secondary: 0 },
    };

    // ─── Initialize nodes & anchors ─────────────────
    state.nodes.push(new Node(lX, lY, true));
    state.nodes.push(new Node(rX, rY, true));

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
    function initVehicles() {
        if (lvlDef.multiVehicle) {
            state.vehicles = lvlDef.multiVehicle.map(mv => {
                const base = VEHICLES[mv.vType];
                const cfg = { ...base, color: mv.color, name: mv.label };
                return { cfg, x: lX + mv.startXOffset, y: lY - base.h * 1.4, active: true, finished: false, vy: 0, vx: base.speed, angle: 0, angVel: 0, wheelAngle: 0, label: mv.label };
            });
        } else {
            const vcfg = VEHICLES[lvl.vType];
            state.vehicles = [{ cfg: vcfg, x: lX - 55, y: lY - vcfg.h * 1.4, active: true, finished: false, vy: 0, vx: vcfg.speed, angle: 0, angVel: 0, wheelAngle: 0, label: null }];
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
    }

    initVehicles();

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
    // Line fill icon (dashed horizontal line)
    const ICON_LINE = [
        [0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0],
        [1,1,0,1,1,0,1],
        [0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0],
    ];
    // Arch icon (arc bending upward)
    const ICON_ARCH = [
        [0,0,0,1,0,0,0],
        [0,0,1,0,1,0,0],
        [0,1,0,0,0,1,0],
        [0,1,0,0,0,1,0],
        [1,0,0,0,0,0,1],
        [1,0,0,0,0,0,1],
        [1,0,0,0,0,0,1],
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
                    k.drawRect({ pos: k.vec2(ox + c * pxSize, oy + r * pxSize), width: pxSize + 0.5, height: pxSize + 0.5, color: k.Color.fromHex(color), anchor: "topleft" });
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
            completeLevel(levelIdx, grade);
            const vName = lvlDef.multiVehicle ? "Both vehicles" : VEHICLES[lvl.vType].name;
            onBridgeSuccess({ summary: `${vName} crossed. Cost: $${cost}, Grade: ${grade}, ${memberCount} members` });
            onLevelComplete({ summary: `Level ${lvlDef.name} complete — grade ${grade}` });
            setTimeout(() => {
                state.modal = { win: true, title: "MISSION COMPLETE!", desc: `${vName} crossed safely!`, cost, grade, openTime: k.time() };
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
                state.modal = { win: false, title: "BRIDGE FAILED", desc: "Add triangular supports or reinforce stressed members.", openTime: k.time() };
            }, 1000);
        }
    }

    // ═══════════════════════════════════════════════════
    //  INPUT
    // ═══════════════════════════════════════════════════
    k.onMousePress(() => {
        const pos = k.mousePos();
        // Modal button clicks — mirrors the linkBtn positions in drawModal
        if (state.modal) {
            const L = getModalLayout();
            const halfW = MODAL_BTN_W / 2, halfH = MODAL_BTN_H / 2;
            const inBtn = (cy) => Math.abs(pos.x - L.mx) < halfW && Math.abs(pos.y - (L.my + cy)) < halfH;

            // Primary — Next Level / Try Again
            if (inBtn(L.btnY.primary)) {
                if (state.modal.win) {
                    const nx = levelIdx + 1;
                    if (nx < LEVELS.length) k.go("game", { levelIdx: nx });
                    else k.go("menu", { view: "levelSelect" });
                } else {
                    resetToBuild();
                }
                return;
            }
            // AI — only when level has been beaten at least once
            if (L.beaten && inBtn(L.btnY.ai)) {
                resetToBuild();
                handleAiClick();
                return;
            }
            // Secondary — Replay / Menu
            if (inBtn(L.btnY.secondary)) {
                if (state.modal.win) resetToBuild();
                else k.go("menu", { view: "levelSelect" });
                return;
            }
            return;
        }

        // ─── AI tutor panel clicks (options / next button) ───
        if (handleAiPanelClick(pos.x, pos.y)) return;

        // ─── Toolbar button clicks (screen-space) ───
        if (handleToolbarClick(pos)) return;

        if (state.mode !== "build") return;
        const wp = toWorld(pos.x, pos.y);
        const sn = snapToGrid(wp.x, wp.y, getAnchors());

        // Delete mode
        if (state.delMode) {
            const sc = getScale();
            const hi = state.members.findIndex(m => !m.builtin && distToSegment(wp, m.n1, m.n2) < 16 / sc);
            if (hi !== -1) {
                const m = state.members.splice(hi, 1)[0];
                // Capture orphan nodes BEFORE pruning so undo can restore them
                const orphanNodes = [m.n1, m.n2].filter(n =>
                    !n.fixed && !n.builtin && !state.members.some(mb => mb.n1 === n || mb.n2 === n));
                state.nodes = state.nodes.filter(n => !orphanNodes.includes(n));
                state.undoStack.push({ deleted: { member: m, nodes: orphanNodes } });
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
                        // Stash old members + arch record so cancel can restore them
                        state.editingArchId = archData.id;
                        const oldMembers = state.members.filter(m => m.archId === archData.id);
                        state.editingOldMembers = oldMembers;
                        state.editingOldArchData = archData;
                        state.members = state.members.filter(m => m.archId !== archData.id);
                        state.arches = state.arches.filter(a => a.id !== archData.id);
                        // Also hide the old arch's interior joints — otherwise
                        // their glue dots stay on screen while the player
                        // drags the apex handle. They'll be re-added if the
                        // edit is cancelled (still referenced by oldMembers).
                        const orphanNodes = new Set();
                        for (const m of oldMembers) {
                            for (const n of [m.n1, m.n2]) {
                                if (n.fixed || n.builtin) continue;
                                if (state.members.some(mb => mb.n1 === n || mb.n2 === n)) continue;
                                orphanNodes.add(n);
                            }
                        }
                        state.nodes = state.nodes.filter(n => !orphanNodes.has(n));
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
        // Arch apex handle drag — recompute bulge from cursor's perpendicular offset
        if (state.archDragging && state.archStart && state.archEnd) {
            const A = state.archStart, B = state.archEnd;
            const dx = B.x - A.x, dy = B.y - A.y;
            const chord = Math.hypot(dx, dy);
            if (chord > 0) {
                const nx = -dy / chord, ny = dx / chord;
                const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
                state.archBulge = (state.mouseWorld.x - mx) * nx + (state.mouseWorld.y - my) * ny;
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

        const pos = k.mousePos();
        if (!state.dragging || state.mode !== "build") { state.dragging = false; return; }
        const wp = toWorld(pos.x, pos.y);
        const sn = snapToGrid(wp.x, wp.y, getAnchors());
        const st = state.dragStart;
        if (!st) { state.dragging = false; return; }
        if (sn.x === st.x && sn.y === st.y) { state.dragging = false; return; }

        const d = Math.hypot(sn.x - st.x, sn.y - st.y);
        const mat = MATERIALS[state.selectedMat];

        // Road materials: stay within bridge zone, max 2 road connections per node
        if (mat.isRoad) {
            if (sn.x < lX || sn.x > rX) { state.dragging = false; return; }
            const roadsOnStart = state.members.filter(m => MATERIALS[m.type].isRoad && (m.n1 === st || m.n2 === st)).length;
            const existingEnd = state.nodes.find(n => n.x === sn.x && n.y === sn.y);
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
                // Straight mode: single segment
                const en = findOrCreate(sn.x, sn.y);
                if (en === st) { state.dragging = false; return; }
                const exists = state.members.some(m =>
                    ((m.n1 === st && m.n2 === en) || (m.n2 === st && m.n1 === en)) ||
                    ((m.n1.x === st.x && m.n1.y === st.y && m.n2.x === en.x && m.n2.y === en.y) ||
                     (m.n2.x === st.x && m.n2.y === st.y && m.n1.x === en.x && m.n1.y === en.y))
                );
                if (!exists) {
                    const m = new Member(st, en, state.selectedMat);
                    state.members.push(m);
                    added.push(m);
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
        k.onKeyPress(String(mi + 1), () => { state.selectedMat = matKey; });
    }
    const resetArchState = () => {
        state.archStart = null;
        state.archEnd = null;
        state.archDragging = false;
        state.archBulgeDir = -1;   // next arch starts pointing up by default
    };

    // Cancel any in-progress arch: if we were editing a placed arch, restore it
    // from the stash so the player gets back to where they started.
    function cancelArch() {
        if (state.editingArchId != null && state.editingOldMembers) {
            for (const m of state.editingOldMembers) {
                for (const n of [m.n1, m.n2]) {
                    if (!state.nodes.includes(n)) state.nodes.push(n);
                }
                state.members.push(m);
            }
            if (state.editingOldArchData) state.arches.push(state.editingOldArchData);
        }
        state.editingArchId = null;
        state.editingOldMembers = null;
        state.editingOldArchData = null;
        resetArchState();
    }
    k.onKeyPress("d", () => { state.delMode = !state.delMode; state.lineMode = false; state.archMode = false; resetArchState(); });
    k.onKeyPress("f", () => { state.lineMode = !state.lineMode; state.delMode = false; state.archMode = false; resetArchState(); });
    k.onKeyPress("c", () => { state.archMode = !state.archMode; state.delMode = false; state.lineMode = false; resetArchState(); });
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
    k.onKeyPress("escape", () => { k.go("menu", { view: "levelSelect" }); });

    // Right-click cancels an in-progress arch (clears all locked state, no commit)
    k.onMousePress("right", () => {
        if (state.archMode && (state.archStart || state.archEnd || state.editingArchId != null)) cancelArch();
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
                x: Math.round((x1 + dx * t) / GRID) * GRID,
                y: Math.round((y1 + dy * t) / GRID) * GRID,
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
        // If we were editing a placed arch, the old members and arch record are
        // already stashed (and removed from state). Consume the stash so undo
        // can reverse the WHOLE edit in one pop.
        const editingOld = state.editingArchId != null ? {
            oldMembers: state.editingOldMembers,
            oldArchData: state.editingOldArchData,
        } : null;
        const archId = state.editingArchId != null ? state.editingArchId : state.nextArchId++;

        const added = [];
        for (let i = 0; i < arch.points.length - 1; i++) {
            const p1 = arch.points[i];
            const p2 = arch.points[i + 1];
            const n1 = findOrCreate(p1.x, p1.y);
            const n2 = findOrCreate(p2.x, p2.y);
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
        };
        state.arches.push(newArchData);

        // Clear edit state (stash has been consumed) + sweep orphan nodes
        state.editingArchId = null;
        state.editingOldMembers = null;
        state.editingOldArchData = null;
        state.nodes = state.nodes.filter(n =>
            n.fixed || n.builtin || state.members.some(m => m.n1 === n || m.n2 === n));

        if (editingOld) {
            state.undoStack.push({ edited: {
                newMembers: added, newArchData,
                oldMembers: editingOld.oldMembers, oldArchData: editingOld.oldArchData,
            } });
        } else {
            pushUndoAction(added);
        }
    }

    // Record one action (a list of members placed in a single user gesture)
    function pushUndoAction(members) {
        if (members && members.length) state.undoStack.push({ members });
    }

    function undoLast() {
        if (state.mode !== "build") return;
        const action = state.undoStack.pop();
        if (!action) return;

        if (action.deleted) {
            // Restore a previously-deleted member + any orphan nodes that went with it
            for (const n of action.deleted.nodes) {
                if (!state.nodes.includes(n)) state.nodes.push(n);
            }
            state.members.push(action.deleted.member);
            return;
        }

        if (action.edited) {
            // Arch-edit reversal: remove new arch + record, restore old arch + record
            for (const m of action.edited.newMembers) {
                const idx = state.members.indexOf(m);
                if (idx !== -1) state.members.splice(idx, 1);
            }
            state.arches = state.arches.filter(a => a.id !== action.edited.newArchData.id);
            for (const m of action.edited.oldMembers) {
                for (const n of [m.n1, m.n2]) {
                    if (!state.nodes.includes(n)) state.nodes.push(n);
                }
                state.members.push(m);
            }
            state.arches.push(action.edited.oldArchData);
            state.nodes = state.nodes.filter(n =>
                n.fixed || n.builtin || state.members.some(m => m.n1 === n || m.n2 === n));
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
        for (const id of removedIds) {
            if (!state.members.some(mb => mb.archId === id)) {
                state.arches = state.arches.filter(a => a.id !== id);
            }
        }
        state.nodes = state.nodes.filter(n =>
            n.fixed || n.builtin || state.members.some(m => m.n1 === n || m.n2 === n));
    }

    function toggleSim() {
        state.finishCalled = false;
        if (state.mode === "build") {
            const cost = calcCost(state.members);
            if (cost > lvl.budget) {
                state.modal = { win: false, title: "OVER BUDGET", desc: `$${cost.toLocaleString()} exceeds the $${lvl.budget.toLocaleString()} budget. Remove some members.`, openTime: k.time() };
                return;
            }
            // Cancel any in-progress arch so its preview doesn't render in sim
            cancelArch();
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
        const matBtnW = matKeys.length > 5 ? 56 : 70;
        const matStartX = W / 2 - (matKeys.length * (matBtnW + 4)) / 2;

        return {
            h: tbH, pad,
            matKeys, matBtnW, matStartX,
            // Button positions (approximate bounding boxes)
            simBtn: { x: W - 230, y: pad + 8, w: 100, h: 32 },
            delBtn:   { x: matStartX + matKeys.length * (matBtnW + 4) + 10,  y: pad + 8, w: 50, h: 32 },
            lineBtn:  { x: matStartX + matKeys.length * (matBtnW + 4) + 65,  y: pad + 8, w: 50, h: 32 },
            archBtn: { x: matStartX + matKeys.length * (matBtnW + 4) + 120, y: pad + 8, w: 50, h: 32 },
            undoBtn:  { x: matStartX + matKeys.length * (matBtnW + 4) + 175, y: pad + 8, w: 55, h: 32 },
            speedBtn: { x: W - 125, y: pad + 8, w: 46, h: 32 },
            menuBtn: { x: W - 55, y: pad + 8, w: 48, h: 32 },
            aiBtn: { x: 10, y: pad + tbH + 8, w: 42, h: 36 },
            hintBtn: { x: 58, y: pad + tbH + 8, w: 42, h: 36 },
        };
    }

    function handleToolbarClick(pos) {
        const tb = getToolbar();
        const y = pos.y;

        // Material buttons
        for (let i = 0; i < tb.matKeys.length; i++) {
            const bx = tb.matStartX + i * (tb.matBtnW + 4);
            if (pos.x >= bx && pos.x <= bx + tb.matBtnW && y >= tb.pad + 8 && y <= tb.pad + 40) {
                state.selectedMat = tb.matKeys[i];
                state.delMode = false;
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
            state.delMode = !state.delMode;
            return true;
        }

        // Line fill button
        const lb = tb.lineBtn;
        if (pos.x >= lb.x && pos.x <= lb.x + lb.w && y >= lb.y && y <= lb.y + lb.h) {
            state.lineMode = !state.lineMode;
            state.archMode = false;
            resetArchState();
            state.delMode = false;
            return true;
        }

        // Arch button
        const arb = tb.archBtn;
        if (pos.x >= arb.x && pos.x <= arb.x + arb.w && y >= arb.y && y <= arb.y + arb.h) {
            state.archMode = !state.archMode;
            resetArchState();
            state.lineMode = false;
            state.delMode = false;
            return true;
        }

        // Undo button
        const ub = tb.undoBtn;
        if (pos.x >= ub.x && pos.x <= ub.x + ub.w && y >= ub.y && y <= ub.y + ub.h) {
            undoLast();
            return true;
        }

        // Speed button
        const spb = tb.speedBtn;
        if (pos.x >= spb.x && pos.x <= spb.x + spb.w && y >= spb.y && y <= spb.y + spb.h) {
            const speeds = [1, 2, 4];
            state.simSpeed = speeds[(speeds.indexOf(state.simSpeed) + 1) % 3];
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

        if (!getApiKey()) {
            const key = prompt("Enter your OpenAI API key:");
            if (key) setApiKey(key.trim());
            else return;
        }

        if (state.aiLoading) return;
        state.aiLoading = true;
        state.aiPanelOpen = true;
        state.aiResult = null;
        state.aiStepIdx = 0;
        state.aiPhase = "question";
        state.aiChoiceIdx = -1;
        onRecapRequest();

        // Clear player's bridge so the lesson builds its own from scratch
        state.members = state.members.filter(m => m.builtin);
        state.nodes = state.nodes.filter(n => n.fixed || n.builtin);

        const result = await solveBridge(lvl, lvlDef);
        state.aiLoading = false;
        state.aiResult = result;
    }

    // Place the members for the current lesson step into the world.
    function buildLessonStep(step) {
        if (!step?.members) return;
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
    }

    // Handle a click on an option button or the Next button.
    function handleAiPanelClick(mx, my) {
        if (!state.aiPanelOpen || !state.aiResult?.steps) return false;
        // Option click only when waiting for an answer
        if (state.aiPhase === "question") {
            for (let i = 0; i < state.aiOptionRects.length; i++) {
                const r = state.aiOptionRects[i];
                if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
                    state.aiChoiceIdx = i;
                    state.aiPhase = "feedback";
                    return true;
                }
            }
        }
        // Next button (either "Build!" after feedback, or "Next question" / "Done")
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
        const step = lesson.steps[state.aiStepIdx];

        if (state.aiPhase === "feedback") {
            // Build the pieces for this step, then move to the next question
            buildLessonStep(step);
            state.aiStepIdx += 1;
            state.aiChoiceIdx = -1;
            if (state.aiStepIdx >= lesson.steps.length) {
                state.aiPhase = "done";
            } else {
                state.aiPhase = "question";
            }
        } else if (state.aiPhase === "done") {
            state.aiPanelOpen = false;
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
    function getFpsCap() {
        try {
            const s = JSON.parse(localStorage.getItem("bridgesnap_settings")) || {};
            return typeof s.fpsCap === "number" ? s.fpsCap : 60;
        } catch { return 60; }
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
                    const splashY = Math.max(lY, rY) + TABLE_DEPTH * 0.35;
                    for (const v of state.vehicles) {
                        if (v.active && !v._splashed && v.y > splashY && v.x > lX && v.x < rX && v.vy > 1) {
                            v._splashed = true;
                            state.splashes.push({ x: v.x, y: splashY, frame: 0, timer: 0 });
                        }
                    }

                    const result = vehicleTick(state, lvl, lvlDef);
                    if (result === "win") endGame(true);
                    else if (result === "fail") endGame(false);
                }
            }

            // Check for bridge nodes hitting water (fallen halves)
            const splashWY = Math.max(lY, rY) + TABLE_DEPTH * 0.35;
            for (const n of state.nodes) {
                if (n.invMass === 0 || n._splashed) continue;
                if (n.y > splashWY && n.x > lX - 20 && n.x < rX + 20 && n.vy > 1) {
                    n._splashed = true;
                    state.splashes.push({ x: n.x, y: splashWY, frame: 0, timer: 0 });
                }
            }

            // Splashes, particles, shake — always update for visual polish
            for (const s of state.splashes) { s.timer += 0.5; s.frame = Math.floor(s.timer) % 18; }
            state.splashes = state.splashes.filter(s => s.timer < 18);

            state.particles.forEach(p => p.update());
            state.particles = state.particles.filter(p => p.life > 0);

            // Consume snap events from physics → spawn popup + confetti burst
            if (state.snapEvents.length) {
                for (const ev of state.snapEvents) spawnSnapVfx(ev.x, ev.y);
                state.snapEvents.length = 0;
            }

            // Snap popups: float up, age out
            for (const p of state.snapPopups) {
                p.age++;
                p.y -= 0.35;
            }
            state.snapPopups = state.snapPopups.filter(p => p.age < p.life);

            // Snap confetti: ballistic fall + rotation
            for (const c of state.snapConfetti) {
                c.age++;
                c.x += c.vx;
                c.y += c.vy;
                c.vy += 0.18;
                c.vx *= 0.99;
                c.rot += c.rotSpd;
            }
            state.snapConfetti = state.snapConfetti.filter(c => c.age < c.life);

            if (state.shakeMag > 0.05) state.shakeMag *= 0.80;
            else state.shakeMag = 0;

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
            // Roads first — car drives on top of them
            drawMembers(sc, "roads");
            drawGhostBeam(sc);
            drawArchPreview(sc);
            drawNodes(sc);
            drawWater(W, H, sc);
            drawTerrain(sc);
            drawFlags(sc);        // flags behind vehicles
            drawVehicles(sc);
            // Structural beams in front of the car for a 3D-truss feel — the car
            // appears to pass *through* the bridge frame from the side view
            drawMembers(sc, "structural");
            drawSplashes(sc);
            drawParticles(sc);
            drawSnapConfetti(sc);
            drawSnapPopups(sc);

            // ─── UI overlay (screen space) ──────────────
            drawToolbar();
            drawHintPanel();
            drawAiPanel();
            if (state.modal) drawModal();
        } catch(e) {
            // Show error on screen so we can debug
            k.drawRect({ width: k.width(), height: 60, pos: k.vec2(0, 0), color: k.Color.fromHex("#cc0000"), anchor: "topleft" });
            k.drawText({ text: "ERR: " + e.message, pos: k.vec2(10, 20), size: 14, color: k.Color.fromHex("#ffffff") });
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

    // Load background sprites for this level's set
    try {
        k.loadSprite(`bg_${levelIdx}_1`, `/assets/backgrounds/${bgSet}/1.png`);
        k.loadSprite(`bg_${levelIdx}_2`, `/assets/backgrounds/${bgSet}/2.png`);
        k.loadSprite(`bg_${levelIdx}_3`, `/assets/backgrounds/${bgSet}/3.png`);
        k.loadSprite(`bg_${levelIdx}_4`, `/assets/backgrounds/${bgSet}/4.png`);
    } catch(e) {
        console.warn("Could not load background sprites:", e);
    }

    // Load water sprites
    let waterLoaded = false;
    try {
        k.loadSprite("water_tile", "/assets/Water/Full colour/PNGs/Water Tile.png", { sliceX: 32 });
        k.loadSprite("fish", "/assets/Water/Fish/PNGs/Fish Swimming.png", { sliceX: 10 });
        k.loadSprite("splash", "/assets/Water/Splash Effect/PNG/Splash Effect.png", { sliceX: 18 });
        waterLoaded = true;
    } catch(e) {
        console.warn("Could not load water sprites:", e);
    }
    let waterFrame = 0;

    function drawBackground(W, H, sc) {
        if (state.mode === "sim" || state.mode === "end") {
            // ─── Sim mode: parallax pixel art backgrounds ───
            // Sky color base
            k.drawRect({ width: W, height: H, pos: k.vec2(0, 0), color: k.Color.fromHex("#4a90c8"), anchor: "topleft" });

            bgScroll += 0.3;

            // Draw backgrounds scaled to top 65% of screen so they don't stretch
            const bgH = H * 0.65;
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
        k.drawRect({ width: W, height: H, pos: k.vec2(0, 0), color: k.Color.fromHex("#d9c9a8"), anchor: "topleft" });

        const wLeft = toWorld(0, 0);
        const wRight = toWorld(W, H);

        const step = GRID;       // minor grid (12px world units)
        const major = GRID * 3;  // major grid (36px world units)
        const lineCol = k.Color.fromHex("#8a7350");

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

        // Anchor dots — only in build mode
        if (state.mode === "build") {
            state.nodes.filter(n => n.fixed && !n.builtin).forEach(n => {
                const p = toScreen(n.x, n.y);
                const isMain = (n.x === lX && n.y === lY) || (n.x === rX && n.y === rY);
                const r = isMain ? sc * 4.5 : sc * 3.5;

                if (!isMain) {
                    const bw = r * 2.5, bh = r * 0.8;
                    k.drawRect({ pos: k.vec2(p.x - bw / 2, p.y - bh / 2), width: bw, height: bh, color: k.Color.fromHex("#555555"), anchor: "topleft" });
                }

                k.drawCircle({ pos: k.vec2(p.x + 0.5, p.y + 0.5), radius: r + 1, color: k.Color.fromHex("#010101"), opacity: 0.25 });
                k.drawCircle({ pos: p, radius: r, color: k.Color.fromHex(isMain ? "#c43030" : "#606878") });
                k.drawCircle({ pos: k.vec2(p.x - r * 0.25, p.y - r * 0.25), radius: r * 0.3, color: k.Color.fromHex("#ffffff"), opacity: 0.35 });
            });
        }
    }

    function drawGround(wx1, wx2, wy, sc, side) {
        const roadTop = toScreen(wx1, wy - ROAD_H);
        const roadBot = toScreen(wx2, wy);
        const cliffBot = toScreen(wx2, wy + TABLE_DEPTH);
        const w = roadBot.x - roadTop.x;
        const roadH = Math.max(roadBot.y - roadTop.y, 6 * sc);
        const cliffH = cliffBot.y - roadBot.y;

        // ── Asphalt road surface ──
        k.drawRect({ pos: roadTop, width: w, height: roadH, color: k.Color.fromHex("#3a3a3a"), anchor: "topleft" });
        // Dashed yellow center line
        const lineY = roadTop.y + roadH * 0.45;
        const dashW = 12 * sc;
        const gapW = 8 * sc;
        for (let dx = 0; dx < w; dx += dashW + gapW) {
            k.drawRect({ pos: k.vec2(roadTop.x + dx, lineY - 1), width: dashW, height: Math.max(2, 1.5 * sc), color: k.Color.fromHex("#e8c840"), anchor: "topleft", opacity: 0.7 });
        }
        // Subtle top highlight
        k.drawRect({ pos: roadTop, width: w, height: Math.max(1, 1.5 * sc), color: k.Color.fromHex("#ffffff"), anchor: "topleft", opacity: 0.12 });

        // ── Grass strip (thin green edge between road and dirt) ──
        const grassH = Math.max(3, 6 * sc);
        k.drawRect({ pos: k.vec2(roadTop.x, roadBot.y), width: w, height: grassH, color: k.Color.fromHex("#4a8c3f"), anchor: "topleft" });
        // Lighter grass tuft line on top edge
        k.drawRect({ pos: k.vec2(roadTop.x, roadBot.y), width: w, height: Math.max(1, 2 * sc), color: k.Color.fromHex("#6ab854"), anchor: "topleft", opacity: 0.7 });

        // ── Dark dirt layer ──
        const darkDirtH = cliffH * 0.35;
        k.drawRect({ pos: k.vec2(roadTop.x, roadBot.y + grassH), width: w, height: darkDirtH, color: k.Color.fromHex("#4a3822"), anchor: "topleft" });

        // ── Light dirt / sandy layer ──
        const lightDirtY = roadBot.y + grassH + darkDirtH;
        const lightDirtH = cliffH - grassH - darkDirtH;
        k.drawRect({ pos: k.vec2(roadTop.x, lightDirtY), width: w, height: lightDirtH, color: k.Color.fromHex("#8b7355"), anchor: "topleft" });
        // Subtle rock lines
        const rockStep = Math.max(10, 20 * sc);
        for (let py = lightDirtY + rockStep; py < cliffBot.y; py += rockStep)
            k.drawLine({ p1: k.vec2(roadTop.x, py), p2: k.vec2(roadTop.x + w, py), width: 1, color: k.Color.fromHex("#010101"), opacity: 0.06 });

        // ── Extend dirt to screen bottom ──
        const screenBot = k.height();
        const remainH = screenBot - cliffBot.y;
        if (remainH > 0) {
            k.drawRect({ pos: k.vec2(roadTop.x, cliffBot.y), width: w, height: remainH, color: k.Color.fromHex("#5a4030"), anchor: "topleft" });
        }

        // ── Cliff inner edge shadow ──
        const edgeX = side === "left" ? roadTop.x + w - 2 : roadTop.x;
        k.drawRect({ pos: k.vec2(edgeX, roadBot.y + grassH), width: 3, height: darkDirtH + lightDirtH + remainH, color: k.Color.fromHex("#010101"), anchor: "topleft", opacity: 0.12 });
    }

    // ─── Water in the gap (sim/end mode only) ────────
    function drawWater(W, H, sc) {
        if (state.mode === "build") return;

        waterFrame += 0.08;
        const frame = Math.floor(waterFrame) % 32;

        // Water surface position
        const waterWorldY = Math.max(lY, rY) + TABLE_DEPTH * 0.35;
        const waterScreen = toScreen(lX, waterWorldY);
        const waterY = waterScreen.y;
        const tileW = 16 * sc * 1.5;
        const tileH = 16 * sc * 1.5;

        // Solid fill from just below the wave sprite to screen bottom
        k.drawRect({ pos: k.vec2(0, waterY + tileH * 0.4), width: W, height: H - waterY, color: k.Color.fromHex("#3b6d9e"), anchor: "topleft" });

        // Animated water tile strip on top
        try {
            for (let tx = -tileW; tx < W + tileW; tx += tileW) {
                k.drawSprite({
                    sprite: "water_tile",
                    frame: frame,
                    pos: k.vec2(tx, waterY - tileH * 0.4),
                    width: tileW + 1,
                    height: tileH,
                    anchor: "topleft",
                });
            }
        } catch(e) {}

        // Subtle darker bands below surface for depth
        const bandStart = waterY + tileH * 0.6;
        for (let wy = bandStart; wy < H; wy += 25) {
            const bandOp = 0.04 + Math.sin(wy * 0.02 + waterFrame * 0.3) * 0.02;
            k.drawRect({ pos: k.vec2(0, wy), width: W, height: 10, color: k.Color.fromHex("#2a5a8a"), anchor: "topleft", opacity: bandOp });
        }

        // Fish animation
        const fishFrame = Math.floor(waterFrame * 0.5) % 10;
        const fishSz = 16 * sc;
        try {
            const fishY = waterY + 40 * sc;
            const fishX = ((waterFrame * 12) % (W + 100)) - 50;
            k.drawSprite({
                sprite: "fish",
                frame: fishFrame,
                pos: k.vec2(fishX, fishY + Math.sin(waterFrame * 0.8) * 6),
                width: fishSz,
                height: fishSz,
                anchor: "center",
            });
            const fishX2 = W - ((waterFrame * 8 + 200) % (W + 100)) + 50;
            k.drawSprite({
                sprite: "fish",
                frame: (fishFrame + 3) % 10,
                pos: k.vec2(fishX2, fishY + 20 * sc + Math.sin(waterFrame * 0.6 + 2) * 8),
                width: fishSz,
                height: fishSz,
                anchor: "center",
                flipX: true,
            });
        } catch(e) {}
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
                k.drawCircle({ pos: p, radius: t * 8 * sc, fill: false, outline: { width: 1, color: k.Color.fromHex("#ffffff") }, opacity: Math.max(0, 0.4 - t / 5) });
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
        const skipMember = (m) =>
            (layer === "roads" && !wantRoad(m)) ||
            (layer === "structural" && wantRoad(m));

        // Helper: get member color (stress-based in sim, material color in build)
        function getMemberColor(m) {
            const mat = MATERIALS[m.type];
            if (state.mode === "sim" || state.mode === "end") {
                const s = Math.min(1, m.stress);
                if (s < 0.15) return C.stressLow;
                if (s < 0.50) return C.stressMid;
                return C.stressHigh;
            }
            if (state.delMode && distToSegment(state.mouseWorld, m.n1, m.n2) < 12 / sc) return C.danger;
            return mat.color;
        }

        // Draw joint fills for road segments (skip broken). Road-only by definition,
        // so they only run when the layer wants roads.
        if (layer !== "structural") {
            for (const m of state.members) {
                if (!MATERIALS[m.type].isRoad || m.broken) continue;
                const mat = MATERIALS[m.type];
                const r = mat.width * sc * 0.5;
                const col = k.Color.fromHex(getMemberColor(m));
                for (const n of [m.n1, m.n2]) {
                    const p = toScreen(n.x, n.y);
                    if (n.fixed) {
                        // Squares at fixed anchors are build-time guides; they look
                        // like artifacts once the car is crossing, so hide in sim/end.
                        if (state.mode === "build") {
                            k.drawRect({ pos: k.vec2(p.x - r, p.y - r), width: r * 2, height: r * 2, color: col, anchor: "topleft" });
                        }
                    } else {
                        k.drawCircle({ pos: p, radius: r, color: col });
                    }
                }
            }
        }

        for (const m of state.members) {
            if (skipMember(m)) continue;
            const p1 = toScreen(m.n1.x, m.n1.y);
            const p2 = toScreen(m.n2.x, m.n2.y);
            const mat = MATERIALS[m.type];
            const w = mat.width * sc;
            const dx = p2.x - p1.x, dy = p2.y - p1.y;
            const len = Math.hypot(dx, dy) || 1;
            // Normal vector (perpendicular to member, scaled)
            const nx = -dy / len, ny = dx / len;

            // Skip all broken members — the visible halves are the UNBROKEN segments
            if (m.broken) continue;

            if (m.builtin) {
                k.drawLine({ p1, p2, width: w * 1.2, color: k.Color.fromHex("#7a5520") });
                continue;
            }

            const color = getMemberColor(m);
            const opacity = 1;
            const col = k.Color.fromHex(color);

            if (m.type === "wood_road") {
                // ── WOOD ROAD — chunky plank with grain lines ──
                // Main plank body
                k.drawLine({ p1, p2, width: w, color: col, opacity });
                // Pixel art edge lines (top and bottom of plank)
                const edgeOff = w * 0.4;
                k.drawLine({
                    p1: k.vec2(p1.x + nx * edgeOff, p1.y + ny * edgeOff),
                    p2: k.vec2(p2.x + nx * edgeOff, p2.y + ny * edgeOff),
                    width: 1, color: k.Color.fromHex("#c4943c"), opacity: 0.5 * opacity,
                });
                k.drawLine({
                    p1: k.vec2(p1.x - nx * edgeOff, p1.y - ny * edgeOff),
                    p2: k.vec2(p2.x - nx * edgeOff, p2.y - ny * edgeOff),
                    width: 1, color: k.Color.fromHex("#7a5520"), opacity: 0.4 * opacity,
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
                        width: 1, color: k.Color.fromHex("#7a5520"), opacity: 0.25 * opacity,
                    });
                }

            } else if (m.type === "wood_beam") {
                // ── WOOD BEAM — with cross marks ──
                k.drawLine({ p1, p2, width: w, color: col, opacity });
                // Highlight stripe
                k.drawLine({
                    p1: k.vec2(p1.x + nx * w * 0.2, p1.y + ny * w * 0.2),
                    p2: k.vec2(p2.x + nx * w * 0.2, p2.y + ny * w * 0.2),
                    width: 1, color: k.Color.fromHex("#EDD8B7"), opacity: 0.5 * opacity,
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
                        width: 1, color: k.Color.fromHex("#C49A6C"), opacity: 0.3 * opacity,
                    });
                    k.drawLine({
                        p1: k.vec2(cx + 1.5, cy - 1.5), p2: k.vec2(cx - 1.5, cy + 1.5),
                        width: 1, color: k.Color.fromHex("#C49A6C"), opacity: 0.3 * opacity,
                    });
                }

            } else if (m.type === "steel") {
                // ── STEEL — I-beam with rivet dots ──
                const bw = Math.max(w, 3);
                // Main beam
                k.drawLine({ p1, p2, width: bw, color: col, opacity });
                // Top/bottom flanges (thicker ends)
                const flangeOff = bw * 0.4;
                k.drawLine({
                    p1: k.vec2(p1.x + nx * flangeOff, p1.y + ny * flangeOff),
                    p2: k.vec2(p2.x + nx * flangeOff, p2.y + ny * flangeOff),
                    width: 1.5, color: k.Color.fromHex("#8a9aaa"), opacity: 0.6 * opacity,
                });
                k.drawLine({
                    p1: k.vec2(p1.x - nx * flangeOff, p1.y - ny * flangeOff),
                    p2: k.vec2(p2.x - nx * flangeOff, p2.y - ny * flangeOff),
                    width: 1.5, color: k.Color.fromHex("#6a7a8a"), opacity: 0.5 * opacity,
                });
                // Shine line
                k.drawLine({ p1, p2, width: 1, color: k.Color.fromHex(C.wireShine), opacity: 0.4 * opacity });
                // Rivet dots
                const rivetSp = Math.max(10, 16 * sc);
                for (let t = rivetSp * 0.5; t < len; t += rivetSp) {
                    const rx = p1.x + (dx / len) * t;
                    const ry = p1.y + (dy / len) * t;
                    k.drawRect({ pos: k.vec2(rx - 1, ry - 1), width: 2, height: 2, color: k.Color.fromHex("#d4dde6"), opacity: 0.5 * opacity, anchor: "topleft" });
                }

            } else if (m.type === "reinforced_road") {
                // ── REINFORCED ROAD — dark plank with steel rivets ──
                k.drawLine({ p1, p2, width: w, color: col, opacity });
                // Steel plate edge lines
                const edgeOff = w * 0.4;
                k.drawLine({
                    p1: k.vec2(p1.x + nx * edgeOff, p1.y + ny * edgeOff),
                    p2: k.vec2(p2.x + nx * edgeOff, p2.y + ny * edgeOff),
                    width: 1, color: k.Color.fromHex("#a08050"), opacity: 0.5 * opacity,
                });
                k.drawLine({
                    p1: k.vec2(p1.x - nx * edgeOff, p1.y - ny * edgeOff),
                    p2: k.vec2(p2.x - nx * edgeOff, p2.y - ny * edgeOff),
                    width: 1, color: k.Color.fromHex("#4a3018"), opacity: 0.4 * opacity,
                });
                // Steel rivet dots along length
                const rivetSp = Math.max(8, 12 * sc);
                for (let t = rivetSp * 0.5; t < len; t += rivetSp) {
                    const rx = p1.x + (dx / len) * t;
                    const ry = p1.y + (dy / len) * t;
                    k.drawRect({ pos: k.vec2(rx - 1, ry - 1), width: 2.5, height: 2.5, color: k.Color.fromHex("#b0b0b0"), opacity: 0.6 * opacity, anchor: "topleft" });
                }
                // Steel reinforcement stripe down center
                k.drawLine({ p1, p2, width: 1.5, color: k.Color.fromHex("#a8b4c0"), opacity: 0.35 * opacity });

            } else if (m.type === "stone_road") {
                // ── STONE ROAD — gray slab with masonry joints ──
                k.drawLine({ p1, p2, width: w, color: col, opacity });
                // Top/bottom edge highlights
                const edgeOff = w * 0.42;
                k.drawLine({
                    p1: k.vec2(p1.x + nx * edgeOff, p1.y + ny * edgeOff),
                    p2: k.vec2(p2.x + nx * edgeOff, p2.y + ny * edgeOff),
                    width: 1, color: k.Color.fromHex("#b8b8b8"), opacity: 0.4 * opacity,
                });
                k.drawLine({
                    p1: k.vec2(p1.x - nx * edgeOff, p1.y - ny * edgeOff),
                    p2: k.vec2(p2.x - nx * edgeOff, p2.y - ny * edgeOff),
                    width: 1, color: k.Color.fromHex("#5a5a5a"), opacity: 0.4 * opacity,
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
                        width: 1, color: k.Color.fromHex("#4a4a4a"), opacity: 0.3 * opacity,
                    });
                }

            } else if (m.type === "rope") {
                // ── ROPE — thick brown dashed line with loop knots ──
                const rw = Math.max(w, 3);
                const dashLen = Math.max(8, 10 * sc);
                const gapLen = Math.max(4, 5 * sc);
                let t = 0;
                while (t < len) {
                    const t1 = t;
                    const t2 = Math.min(t + dashLen, len);
                    k.drawLine({
                        p1: k.vec2(p1.x + (dx / len) * t1, p1.y + (dy / len) * t1),
                        p2: k.vec2(p1.x + (dx / len) * t2, p1.y + (dy / len) * t2),
                        width: rw, color: col, opacity,
                    });
                    t += dashLen + gapLen;
                }
                // Thinner highlight strand
                k.drawLine({ p1, p2, width: 1, color: k.Color.fromHex("#c4a040"), opacity: 0.3 * opacity });
                // Knot loops at endpoints
                k.drawCircle({ pos: p1, radius: 2.5, color: col, opacity });
                k.drawCircle({ pos: p2, radius: 2.5, color: col, opacity });

            } else if (m.type === "cable") {
                // ── STEEL CABLE — thin dashed line with knots ──
                const cw = Math.max(w, 2);
                const dashLen = Math.max(6, 8 * sc);
                const gapLen = Math.max(3, 4 * sc);
                let t = 0;
                while (t < len) {
                    const t1 = t;
                    const t2 = Math.min(t + dashLen, len);
                    k.drawLine({
                        p1: k.vec2(p1.x + (dx / len) * t1, p1.y + (dy / len) * t1),
                        p2: k.vec2(p1.x + (dx / len) * t2, p1.y + (dy / len) * t2),
                        width: cw, color: col, opacity,
                    });
                    t += dashLen + gapLen;
                }
                // Knot dots at endpoints
                k.drawRect({ pos: k.vec2(p1.x - 1.5, p1.y - 1.5), width: 3, height: 3, color: col, opacity, anchor: "topleft" });
                k.drawRect({ pos: k.vec2(p2.x - 1.5, p2.y - 1.5), width: 3, height: 3, color: col, opacity, anchor: "topleft" });
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
                    const p = toScreen(n.x, n.y);
                    k.drawRect({ pos: k.vec2(p.x - r, p.y - r), width: r * 2, height: r * 2, color: k.Color.fromHex("#5a4a30"), anchor: "topleft" });
                }
            }
        }
    }

    // ─── Ghost beam while dragging ──────────────────
    function drawGhostBeam(sc) {
        if (!state.dragging || !state.dragStart || state.mode !== "build") return;
        const sn = snapToGrid(state.mouseWorld.x, state.mouseWorld.y, getAnchors());
        const st = state.dragStart;
        if (sn.x === st.x && sn.y === st.y) return;

        const d = Math.hypot(sn.x - st.x, sn.y - st.y);
        const mat = MATERIALS[state.selectedMat];
        const ok = d > 5 && (state.lineMode ? d > GRID : d <= mat.maxLength);

        const p1 = toScreen(st.x, st.y);
        const p2 = toScreen(sn.x, sn.y);

        // Range circle (only for straight mode)
        if (!state.lineMode) {
            const ringR = mat.maxLength * sc;
            k.drawCircle({ pos: p1, radius: ringR, fill: false, outline: { width: 1, color: k.Color.fromHex(ok ? C.accent : C.danger) }, opacity: 0.15 });
        }

        // Ghost beam — line fill preview or single segment
        if (state.lineMode && d > GRID) {
            const linePts = getLinePoints(st.x, st.y, sn.x, sn.y);
            const ghostCol = k.Color.fromHex(ok ? C.accent : C.danger);
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
                color: k.Color.fromHex(ok ? C.pencil : C.danger),
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
                color: k.Color.fromHex("#ffffff"),
                opacity: 0.8,
            });
        }

        // Snap indicator on target node
        if (state.nodes.find(n => n.x === sn.x && n.y === sn.y)) {
            k.drawCircle({ pos: p2, radius: 8, fill: false, outline: { width: 2, color: k.Color.fromHex(C.accent) }, opacity: 0.6 });
        }
    }

    // ─── Arch preview ──────────────────────────────
    function drawArchPreview(sc) {
        if (!state.archMode || state.mode !== "build") return;

        const previewCol = k.Color.fromHex(C.accent);

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

        // Phase C: both endpoints set — render full arch + apex handle
        const arch = computeArch();
        if (!arch) return;

        const ep = toScreen(arch.end.x, arch.end.y);
        // Faint chord reference
        k.drawLine({ p1: sp, p2: ep, width: 1, color: previewCol, opacity: 0.25 });

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
        // End anchor lock dot
        k.drawCircle({ pos: ep, radius: 8, color: previewCol, opacity: 0.85 });

        // Apex handle — clearly draggable: filled disc + ring + cross-hair
        const apex = getArchApexScreen();
        if (apex) {
            const r = state.archDragging ? 11 : 9;
            k.drawCircle({ pos: k.vec2(apex.x + 1, apex.y + 1), radius: r + 1, color: k.Color.fromHex("#000000"), opacity: 0.3 });
            k.drawCircle({ pos: apex, radius: r, color: k.Color.fromHex("#fff8e0") });
            k.drawCircle({ pos: apex, radius: r, fill: false, outline: { width: 2.5, color: previewCol } });
            k.drawLine({ p1: k.vec2(apex.x, apex.y - r * 0.55), p2: k.vec2(apex.x, apex.y + r * 0.55), width: 2, color: previewCol });
            k.drawLine({ p1: k.vec2(apex.x - r * 0.55, apex.y), p2: k.vec2(apex.x + r * 0.55, apex.y), width: 2, color: previewCol });
        }
    }

    // ─── Nodes (small joint dots) ──────────────────
    function drawNodes(sc) {
        // Only show nodes in build mode
        if (state.mode !== "build") return;
        for (const n of state.nodes) {
            if (n.builtin) continue;
            if (n.fixed) continue;
            const p = toScreen(n.x, n.y);

            const r = 1.8;
            k.drawCircle({ pos: k.vec2(p.x + 0.5, p.y + 0.5), radius: r * sc, color: k.Color.fromHex("#010101"), opacity: 0.12 });
            k.drawCircle({ pos: p, radius: r * sc, color: k.Color.fromHex(C.glueDot), opacity: 0.85 });
        }
    }

    // ─── Vehicles (sprite-based) ───────────────────
    function drawVehicles(sc) {
        for (const v of state.vehicles) {
            if (!v.active && v.y > 1100) continue;
            // Hide vehicle once it splashed into water
            if (v._splashed) continue;

            const p = toScreen(v.x, v.y);
            const px = p.x;
            const py = p.y;
            const hw = v.cfg.w / 2 * sc;
            const hh = v.cfg.h / 2 * sc;

            const spriteKey = v.cfg.sprite;
            const vAngle = v.angle || 0;
            if (spriteKey) {
                const sprW = hw * 4;
                k.drawSprite({
                    sprite: spriteKey,
                    pos: k.vec2(px, py - hh * 0.3),
                    width: sprW,
                    height: sprW,
                    anchor: "center",
                    flipX: true,
                    angle: k.rad2deg(vAngle),
                });
            }

            // Multi-vehicle label badge
            if (v.label) {
                k.drawCircle({ pos: k.vec2(px, py - hh * 1.6), radius: 7 * sc, color: k.Color.fromHex("#010101") });
                k.drawCircle({ pos: k.vec2(px, py - hh * 1.6), radius: 5 * sc, color: k.Color.fromHex(v.cfg.color) });
                k.drawText({ text: v.label, pos: k.vec2(px, py - hh * 1.6), size: 6 * sc, font: "PressStart2P", color: k.Color.fromHex("#ffffff"), anchor: "center" });
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
                color: k.Color.fromHex(p.color),
                opacity: p.life,
            });
        }
    }

    // ─── SNAP! popup + confetti burst (on bridge break) ────
    // Colors echo the logo / main-menu confetti palette for a playful craft vibe
    const SNAP_COLORS = ["#e05080","#50a0e0","#e0c030","#50c060","#e07030","#a060d0"];

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
            const fill = k.Color.fromHex(c.color);
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
                    color: k.Color.fromHex("#1a0e05"),
                    opacity: opacity * 0.45,
                    anchor: "center",
                });
                // Main colored letter
                k.drawText({
                    text: L.ch,
                    pos: k.vec2(0, 0),
                    size: fontSize,
                    font: "PressStart2P",
                    color: k.Color.fromHex(L.color),
                    opacity,
                    anchor: "center",
                });

                k.popTransform();
            }
        }
    }

    // ─── Finish flags ───────────────────────────────
    function drawFlags(sc) {
        const FLAG_INLAND = 80;
        if (lvlDef.multiVehicle) {
            lvlDef.multiVehicle.forEach((mv, i) => {
                const triggered = state.vehicles[i]?.finished;
                drawOneFlag(rX + FLAG_INLAND + i * 30, rY, mv.color, mv.label, triggered, sc);
            });
        } else {
            drawOneFlag(rX + FLAG_INLAND, rY, "#dc2626", null, state.mode === "end" && state.finished, sc);
        }
    }

    function drawOneFlag(wx, wy, color, label, triggered, sc) {
        const p = toScreen(wx, wy);
        const flagH = sc * 70;      // taller so the flag reads from the ground
        const flagW = flagH;

        // Animated flag sprite — pole base sits exactly on the road surface
        const flagBottomY = p.y;
        const frame = Math.floor(state.flagWave * 3) % 5;
        try {
            k.drawSprite({
                sprite: "flag",
                frame: frame,
                pos: k.vec2(p.x, flagBottomY),
                width: flagW,
                height: flagH,
                anchor: "botleft",
            });
        } catch(e) {
            // Fallback rectangle flag
            const poleH = flagH;
            k.drawLine({ p1: k.vec2(p.x, flagBottomY), p2: k.vec2(p.x, flagBottomY - poleH), width: 2, color: k.Color.fromHex("#94a3b8") });
            k.drawRect({ pos: k.vec2(p.x + sc * 13, flagBottomY - poleH + sc * 8), width: sc * 26, height: sc * 17, color: k.Color.fromHex(color), anchor: "center" });
        }

        // FINISH label — above the top of the flag, anchored "bot" so the
        // baseline sits right above the waving flag sprite
        const labelY = flagBottomY - flagH - 2 * sc;
        k.drawText({
            text: label ? `CAR ${label}` : "FINISH",
            pos: k.vec2(p.x + flagW * 0.5, labelY),
            size: Math.max(6, 6 * sc),
            font: "PressStart2P",
            color: k.Color.fromHex(triggered ? "#4ade80" : "#ffffff"),
            anchor: "bot",
            opacity: 0.85,
        });
    }

    // ═══════════════════════════════════════════════════
    //  UI DRAWING (screen-space)
    // ═══════════════════════════════════════════════════

    function drawToolbar() {
        const W = k.width();
        const tb = getToolbar();

        // Wooden toolbar bar
        k.drawRect({ pos: k.vec2(0, 0), width: W, height: tb.h + tb.pad, color: k.Color.fromHex("#d37e3d"), anchor: "topleft" });
        k.drawRect({ pos: k.vec2(0, tb.h + tb.pad - 3), width: W, height: 3, color: k.Color.fromHex("#8e4924"), anchor: "topleft" });
        // Subtle wood grain
        for (let tx = 0; tx < W; tx += 14) {
            k.drawLine({ p1: k.vec2(tx, 0), p2: k.vec2(tx + 3, tb.h + tb.pad), width: 0.5, color: k.Color.fromHex("#8e4924"), opacity: 0.12 });
        }
        k.drawRect({ pos: k.vec2(0, tb.h + tb.pad), width: W, height: 2, color: k.Color.fromHex("#010101"), anchor: "topleft", opacity: 0.3 });

        // Budget display
        const cost = calcCost(state.members);
        const overBudget = cost > lvl.budget;
        const budgetPct = cost / lvl.budget;
        const budgetColor = overBudget ? "#ff4444" : budgetPct > 0.85 ? "#ffaa22" : "#fff8e0";
        k.drawText({
            text: `$${cost.toLocaleString()} / $${lvl.budget.toLocaleString()}`,
            pos: k.vec2(12, 6),
            size: 14,
            font: "PressStart2P",
            color: k.Color.fromHex(budgetColor),
        });

        // Level name
        k.drawText({
            text: lvlDef.name,
            pos: k.vec2(12, 28),
            size: 8,
            font: "PressStart2P",
            color: k.Color.fromHex("#fff8e0"),
            opacity: 0.5,
        });

        // ─── Material buttons ───
        for (let i = 0; i < tb.matKeys.length; i++) {
            const key = tb.matKeys[i];
            const mat = MATERIALS[key];
            const bx = tb.matStartX + i * (tb.matBtnW + 4);
            const isSel = state.selectedMat === key;

            // Button background
            k.drawRect({
                pos: k.vec2(bx, tb.pad + 8), width: tb.matBtnW, height: 32,
                color: k.Color.fromHex(isSel ? "#8e4924" : "#b86830"),
                anchor: "topleft",
            });
            if (isSel) {
                k.drawRect({ pos: k.vec2(bx, tb.pad + 8), width: tb.matBtnW, height: 32, fill: false, outline: { width: 2, color: k.Color.fromHex("#fff8e0") }, anchor: "topleft" });
            }
            // Material icon
            const matIcon = MAT_ICONS[key];
            if (matIcon) {
                const iconPx = 2;
                const iconCx = bx + 10;
                const iconCy = tb.pad + 18;
                drawIcon(matIcon, iconCx, iconCy, isSel ? "#fff8e0" : mat.color, iconPx);
            } else {
                k.drawRect({ pos: k.vec2(bx + 6, tb.pad + 14), width: 8, height: 8, color: k.Color.fromHex(mat.color), anchor: "topleft" });
            }
            // Label
            k.drawText({
                text: mat.label.split(" ")[0],
                pos: k.vec2(bx + 20, tb.pad + 19),
                size: 7,
                font: "PressStart2P",
                color: k.Color.fromHex(isSel ? "#fff8e0" : "#f0d8b0"),
            });
        }

        // ─── Action buttons (icon-based) ───
        const iPx = 2; // icon pixel size

        // DEL - X icon
        drawIconBtn(tb.delBtn, ICON_DELETE, state.delMode ? "#ff4444" : "#fff8e0", state.delMode ? "#8a2020" : null, iPx);
        // LINE - dashed line icon
        drawIconBtn(tb.lineBtn, ICON_LINE, state.lineMode ? "#60d0ff" : "#fff8e0", state.lineMode ? "#1a5080" : null, iPx);
        // CURVE - arc icon
        drawIconBtn(tb.archBtn, ICON_ARCH, state.archMode ? "#60d0ff" : "#fff8e0", state.archMode ? "#1a5080" : null, iPx);
        // UNDO - arrow icon
        drawIconBtn(tb.undoBtn, ICON_UNDO, "#fff8e0", null, iPx);
        // SPEED - text
        drawIconBtn(tb.speedBtn, null, "#fff8e0", null, iPx, `${state.simSpeed}x`);
        // SIM - play/stop icon + label
        const isSim = state.mode === "sim";
        drawIconBtn(tb.simBtn, isSim ? ICON_STOP : ICON_PLAY, isSim ? "#fff8e0" : "#fff8e0", isSim ? "#cc3333" : "#16a34a", iPx, isSim ? " STOP" : " PLAY");
        // MENU - hamburger icon
        drawIconBtn(tb.menuBtn, ICON_MENU, "#fff8e0", null, iPx);

        // ─── AI & Hint buttons (below toolbar) ───
        drawSmallBtn(tb.aiBtn, "AI", state.aiPanelOpen);
        drawSmallBtn(tb.hintBtn, "?", state.hintOpen);
    }

    function drawIconBtn(rect, icon, iconColor, bgColor, pxSize, text) {
        // Background
        k.drawRect({ pos: k.vec2(rect.x, rect.y), width: rect.w, height: rect.h, color: k.Color.fromHex(bgColor || "#8e4924"), anchor: "topleft" });
        k.drawRect({ pos: k.vec2(rect.x, rect.y), width: rect.w, height: rect.h, fill: false, outline: { width: 1, color: k.Color.fromHex("#010101") }, anchor: "topleft", opacity: 0.25 });
        // Icon and/or text
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        if (icon && text) {
            // Side by side: icon left, text right
            drawIcon(icon, cx - 20, cy, iconColor, pxSize);
            k.drawText({ text, pos: k.vec2(cx + 8, cy), size: 7, font: "PressStart2P", color: k.Color.fromHex(iconColor), anchor: "center" });
        } else if (icon) {
            drawIcon(icon, cx, cy, iconColor, pxSize);
        } else if (text) {
            k.drawText({ text, pos: k.vec2(cx, cy), size: 8, font: "PressStart2P", color: k.Color.fromHex(iconColor), anchor: "center" });
        }
    }

    function drawSmallBtn(rect, label, active) {
        k.drawRect({
            pos: k.vec2(rect.x, rect.y), width: rect.w, height: rect.h,
            color: k.Color.fromHex(active ? "#d37e3d" : "#8e4924"),
            anchor: "topleft",
        });
        k.drawRect({
            pos: k.vec2(rect.x, rect.y), width: rect.w, height: rect.h,
            fill: false, outline: { width: 1, color: k.Color.fromHex(active ? "#fff8e0" : "#010101") },
            anchor: "topleft", opacity: active ? 0.6 : 0.2,
        });
        k.drawText({
            text: label,
            pos: k.vec2(rect.x + rect.w / 2, rect.y + rect.h / 2),
            size: 8,
            font: "PressStart2P",
            color: k.Color.fromHex(active ? "#fff8e0" : "#e0c8a0"),
            anchor: "center",
        });
    }

    // ─── Hint panel ─────────────────────────────────
    function drawHintPanel() {
        if (!state.hintOpen) return;
        const W = k.width();
        const H = k.height();
        const panelW = Math.min(300, W * 0.4);
        const panelH = 120;
        const px = W - panelW - 14;
        const py = H - panelH - 14;

        // Sticky note
        k.drawRect({ pos: k.vec2(px + 2, py + 2), width: panelW, height: panelH, color: k.Color.fromHex("#000000"), opacity: 0.1, anchor: "topleft", radius: 2 });
        k.drawRect({ pos: k.vec2(px, py), width: panelW, height: panelH, color: k.Color.fromHex("#fff9c4"), anchor: "topleft", radius: 1 });
        k.drawRect({ pos: k.vec2(px + panelW / 2 - 20, py - 5), width: 40, height: 12, color: k.Color.fromHex(C.tape), anchor: "topleft", opacity: 0.55 });

        k.drawText({ text: "HINT", pos: k.vec2(px + 10, py + 10), size: 10, font: "PressStart2P", color: k.Color.fromHex(C.markerBlue) });
        k.drawText({ text: lvlDef.hint, pos: k.vec2(px + 10, py + 30), size: 16, font: "PatrickHand", color: k.Color.fromHex(C.pencil), width: panelW - 20, lineSpacing: 4 });
    }

    // ─── AI panel (Socratic tutor — styled like the hint sticky note) ──
    function drawAiPanel() {
        // Reset click targets every frame — rebuilt below if panel is open
        state.aiOptionRects = [];
        state.aiNextRect = null;
        if (!state.aiPanelOpen) return;

        const panelW = Math.min(460, k.width() * 0.5);
        const padX = 18;
        const px = 10;
        const py = 110;

        // Compute panel height based on content
        const lesson = state.aiResult;
        const hasSteps = lesson && Array.isArray(lesson.steps);
        let panelH = 170;
        const optH = 52;
        if (hasSteps) {
            if (state.aiPhase === "question") {
                const step = lesson.steps[state.aiStepIdx];
                // header + question (~60) + options
                panelH = 140 + (optH + 8) * (step?.options?.length || 0);
            } else if (state.aiPhase === "feedback") {
                panelH = 250;
            } else if (state.aiPhase === "done") {
                panelH = 170;
            }
        } else if (state.aiResult?.error || state.aiResult?.explanation) {
            panelH = 170;
        }

        // Sticky-note background with tape strip (match the HINT panel)
        k.drawRect({ pos: k.vec2(px + 2, py + 2), width: panelW, height: panelH, color: k.Color.fromHex("#000000"), opacity: 0.1, anchor: "topleft", radius: 2 });
        k.drawRect({ pos: k.vec2(px, py), width: panelW, height: panelH, color: k.Color.fromHex("#fff9c4"), anchor: "topleft", radius: 1 });
        k.drawRect({ pos: k.vec2(px + panelW / 2 - 20, py - 5), width: 40, height: 12, color: k.Color.fromHex(C.tape), anchor: "topleft", opacity: 0.55 });

        k.drawText({ text: "AI TUTOR", pos: k.vec2(px + padX, py + 12), size: 10, font: "PressStart2P", color: k.Color.fromHex(C.markerBlue) });

        if (state.aiLoading) {
            k.drawText({ text: "Thinking...", pos: k.vec2(px + padX, py + 44), size: 18, font: "PatrickHand", color: k.Color.fromHex(C.pencil), opacity: 0.6 });
            return;
        }

        if (state.aiResult?.error) {
            k.drawText({ text: state.aiResult.error, pos: k.vec2(px + padX, py + 44), size: 16, font: "PatrickHand", color: k.Color.fromHex(C.danger), width: panelW - padX * 2, lineSpacing: 3 });
            return;
        }

        // Fallback: level-not-beaten tip
        if (!hasSteps && state.aiResult?.explanation) {
            if (state.aiResult.concept) {
                k.drawText({ text: `Concept: ${state.aiResult.concept}`, pos: k.vec2(px + padX, py + 38), size: 16, font: "PatrickHand", color: k.Color.fromHex(C.markerGreen) });
            }
            k.drawText({ text: state.aiResult.explanation, pos: k.vec2(px + padX, py + 62), size: 16, font: "PatrickHand", color: k.Color.fromHex(C.pencil), width: panelW - padX * 2, lineSpacing: 4 });
            return;
        }

        if (!hasSteps) {
            const beaten = getCompleted().includes(levelIdx);
            const tip = beaten
                ? "Click the AI button to start an\ninteractive lesson!"
                : "Beat this level first to unlock\nthe AI tutor!";
            k.drawText({ text: tip, pos: k.vec2(px + padX, py + 44), size: 16, font: "PatrickHand", color: k.Color.fromHex(C.pencil), width: panelW - padX * 2, lineSpacing: 4, opacity: 0.5 });
            return;
        }

        // ── Lesson UI ──
        const step = lesson.steps[state.aiStepIdx];
        const totalSteps = lesson.steps.length;

        if (lesson.concept) {
            k.drawText({ text: lesson.concept, pos: k.vec2(px + padX, py + 34), size: 16, font: "PatrickHand", color: k.Color.fromHex(C.markerGreen) });
        }
        k.drawText({
            text: `Step ${Math.min(state.aiStepIdx + 1, totalSteps)} / ${totalSteps}`,
            pos: k.vec2(px + panelW - padX, py + 34),
            size: 14, font: "PatrickHand", color: k.Color.fromHex(C.pencil), opacity: 0.6, anchor: "topright",
        });

        if (state.aiPhase === "question" && step) {
            k.drawText({ text: step.question, pos: k.vec2(px + padX, py + 58), size: 17, font: "PatrickHand", color: k.Color.fromHex(C.pencil), width: panelW - padX * 2, lineSpacing: 4 });

            const optsY = py + 110;
            for (let i = 0; i < step.options.length; i++) {
                const oy = optsY + i * (optH + 8);
                const rect = { x: px + padX, y: oy, w: panelW - padX * 2, h: optH };
                state.aiOptionRects.push(rect);
                k.drawRect({ pos: k.vec2(rect.x, rect.y), width: rect.w, height: rect.h, color: k.Color.fromHex("#fffdea"), anchor: "topleft", radius: 2 });
                k.drawRect({ pos: k.vec2(rect.x, rect.y), width: rect.w, height: rect.h, fill: false, outline: { width: 1.5, color: k.Color.fromHex(C.markerBlue) }, anchor: "topleft", radius: 2, opacity: 0.7 });
                k.drawText({ text: String.fromCharCode(65 + i), pos: k.vec2(rect.x + 12, rect.y + rect.h / 2), size: 14, font: "PressStart2P", color: k.Color.fromHex(C.markerBlue), anchor: "left" });
                k.drawText({ text: step.options[i], pos: k.vec2(rect.x + 40, rect.y + rect.h / 2), size: 16, font: "PatrickHand", color: k.Color.fromHex(C.pencil), width: rect.w - 50, anchor: "left", lineSpacing: 3 });
            }
            return;
        }

        if (state.aiPhase === "feedback" && step) {
            const correct = state.aiChoiceIdx === step.correct;
            const bannerColor = correct ? C.markerGreen : C.markerRed;
            k.drawText({ text: correct ? "RIGHT!" : "NOT QUITE", pos: k.vec2(px + padX, py + 60), size: 12, font: "PressStart2P", color: k.Color.fromHex(bannerColor) });

            const pickedLabel = `${String.fromCharCode(65 + state.aiChoiceIdx)}: ${step.options[state.aiChoiceIdx]}`;
            k.drawText({ text: pickedLabel, pos: k.vec2(px + padX, py + 84), size: 15, font: "PatrickHand", color: k.Color.fromHex(C.pencil), opacity: 0.7, width: panelW - padX * 2, lineSpacing: 3 });

            const explanation = correct ? (step.explainCorrect || "") : (step.explainWrong || "");
            k.drawText({ text: explanation, pos: k.vec2(px + padX, py + 118), size: 16, font: "PatrickHand", color: k.Color.fromHex(C.pencil), width: panelW - padX * 2, lineSpacing: 4 });

            const btnW = 160, btnH = 32;
            const btnX = px + panelW - btnW - padX;
            const btnY = py + panelH - btnH - 12;
            state.aiNextRect = { x: btnX, y: btnY, w: btnW, h: btnH };
            const isLast = state.aiStepIdx === lesson.steps.length - 1;
            k.drawRect({ pos: k.vec2(btnX, btnY), width: btnW, height: btnH, color: k.Color.fromHex(C.markerBlue), anchor: "topleft", radius: 3 });
            k.drawText({ text: isLast ? "Build & Finish!" : "Build & Next", pos: k.vec2(btnX + btnW / 2, btnY + btnH / 2), size: 11, font: "PressStart2P", color: k.Color.fromHex("#ffffff"), anchor: "center" });
            return;
        }

        if (state.aiPhase === "done") {
            k.drawText({ text: "LESSON COMPLETE!", pos: k.vec2(px + padX, py + 60), size: 12, font: "PressStart2P", color: k.Color.fromHex(C.markerGreen) });
            k.drawText({ text: lesson.summary || "Great work — hit PLAY to see the bridge in action.", pos: k.vec2(px + padX, py + 88), size: 16, font: "PatrickHand", color: k.Color.fromHex(C.pencil), width: panelW - padX * 2, lineSpacing: 4 });

            const btnW = 100, btnH = 30;
            const btnX = px + panelW - btnW - padX;
            const btnY = py + panelH - btnH - 12;
            state.aiNextRect = { x: btnX, y: btnY, w: btnW, h: btnH };
            k.drawRect({ pos: k.vec2(btnX, btnY), width: btnW, height: btnH, color: k.Color.fromHex(C.markerGreen), anchor: "topleft", radius: 3 });
            k.drawText({ text: "Close", pos: k.vec2(btnX + btnW / 2, btnY + btnH / 2), size: 11, font: "PressStart2P", color: k.Color.fromHex("#ffffff"), anchor: "center" });
        }
    }

    // ─── Modal (result screen) ──────────────────────
    // Modal button positions — kept here so the click handler can reuse them.
    // Y values are offsets from the modal center (my). Btn3's offset depends on
    // whether the AI button is present.
    // Modal layout constants. Button Y positions are computed relative to the
    // modal BOTTOM so they stay pinned to the notebook's bottom ruled lines
    // regardless of how tall the card grows (win vs fail, with/without AI).
    const MODAL_BTN_W = 220;
    const MODAL_BTN_H = 30;
    const MODAL_BTN_SPACING = 44;              // matches every-other ruled line (22 × 2)
    const MODAL_BTN_BOTTOM_MARGIN = 30;        // secondary button sits this far above the bottom

    // Single source of truth for modal layout — both drawModal and the click
    // handler pull positions from here so hit tests match visuals exactly.
    function getModalLayout() {
        if (!state.modal) return null;
        const W = k.width(), H = k.height();
        const beaten = getCompleted().includes(levelIdx);
        const hasGrade = state.modal.grade != null;
        const mh = 200 + (hasGrade ? 60 : 0) + (beaten ? 40 : 0);
        const hh = mh / 2;
        const secondary = hh - MODAL_BTN_BOTTOM_MARGIN;
        const ai = beaten ? secondary - MODAL_BTN_SPACING : null;
        const primary = beaten
            ? secondary - 2 * MODAL_BTN_SPACING
            : secondary - MODAL_BTN_SPACING;
        return {
            mx: W / 2, my: H / 2, mw: Math.min(420, W * 0.82), mh, hh,
            beaten, hasGrade,
            btnY: { primary, ai, secondary },
        };
    }

    function drawModal() {
        const m = state.modal;
        const W = k.width(), H = k.height();
        const cFn = (h) => k.Color.fromHex(h);

        // Dim backdrop
        k.drawRect({ pos: k.vec2(0, 0), width: W, height: H, color: cFn("#1a0e05"), anchor: "topleft", opacity: 0.55 });

        // Pull shared layout (mh, hh, button Y's) — same numbers click handler uses
        const L = getModalLayout();
        const { mx, my, mw, mh, hh, beaten } = L;
        const hw = mw / 2;

        // Soft layered drop shadow
        for (let s = 1; s <= 4; s++) {
            k.drawRect({
                pos: k.vec2(mx + s, my + s + 1),
                width: mw + s, height: mh + s,
                color: cFn("#000000"), anchor: "center", opacity: 0.07, radius: 4,
            });
        }

        // Paper card — cream background
        k.drawRect({ pos: k.vec2(mx, my), width: mw, height: mh, color: cFn(C.paper), anchor: "center", radius: 4 });
        // Subtle warm border
        k.drawRect({
            pos: k.vec2(mx, my), width: mw, height: mh,
            fill: false, outline: { width: 1.5, color: cFn("#c4a060") },
            anchor: "center", radius: 4, opacity: 0.55,
        });

        // Notebook margin (red vertical line on the left, like ruled paper)
        const marginX = mx - hw + 32;
        k.drawLine({
            p1: k.vec2(marginX, my - hh + 12), p2: k.vec2(marginX, my + hh - 12),
            width: 1.5, color: cFn(C.markerRed), opacity: 0.35,
        });

        // Horizontal ruled lines — anchored to the bottom-most button (secondary)
        // and marching upward every 22px so every ruled line passes through a
        // potential button baseline. Buttons spaced at every-other line (44) sit
        // exactly on a line, giving the "written on the page" look.
        const bottomLineY = my + L.btnY.secondary;
        for (let ly = bottomLineY; ly > my - hh + 50; ly -= 22) {
            k.drawLine({
                p1: k.vec2(mx - hw + 12, ly), p2: k.vec2(mx + hw - 12, ly),
                width: 1, color: cFn("#a8c0d8"), opacity: 0.28,
            });
        }

        // Two strips of masking tape pinning the page at the top corners
        function drawTape(cx, cy, tw, th, ang) {
            const cos = Math.cos(ang), sin = Math.sin(ang);
            const corner = (dx, dy) => k.vec2(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
            const tl = corner(-tw / 2, -th / 2), tr = corner(tw / 2, -th / 2);
            const br = corner(tw / 2, th / 2),    bl = corner(-tw / 2, th / 2);
            // Drop shadow
            const sh = (p) => k.vec2(p.x + 1.5, p.y + 2.5);
            k.drawTriangle({ p1: sh(tl), p2: sh(tr), p3: sh(br), color: cFn("#000000"), opacity: 0.18 });
            k.drawTriangle({ p1: sh(tl), p2: sh(br), p3: sh(bl), color: cFn("#000000"), opacity: 0.18 });
            // Tape body — semi-transparent so the page shows through
            k.drawTriangle({ p1: tl, p2: tr, p3: br, color: cFn(C.tape), opacity: 0.85 });
            k.drawTriangle({ p1: tl, p2: br, p3: bl, color: cFn(C.tape), opacity: 0.85 });
            // Subtle horizontal grain line
            const il = corner(-tw / 2 + 3, 0), ir = corner(tw / 2 - 3, 0);
            k.drawLine({ p1: il, p2: ir, width: 1, color: cFn("#bfae7a"), opacity: 0.45 });
        }
        drawTape(mx - hw + 42, my - hh - 2, 78, 22, -0.30);
        drawTape(mx + hw - 42, my - hh - 2, 78, 22,  0.28);

        // Title — pixel font with shadow + colored marker, plus underline stroke
        const titleColor = m.win ? C.markerGreen : C.markerRed;
        const titleY = my - hh + 50;
        const titleSz = 18;
        k.drawText({ text: m.title, pos: k.vec2(mx + 2, titleY + 2), size: titleSz, font: "PressStart2P", color: cFn("#1a0e05"), anchor: "center", opacity: 0.30 });
        k.drawText({ text: m.title, pos: k.vec2(mx, titleY), size: titleSz, font: "PressStart2P", color: cFn(titleColor), anchor: "center" });
        // Marker underline (slight wobble for hand-drawn feel)
        const underlineW = m.title.length * (titleSz * 0.75);
        k.drawLine({
            p1: k.vec2(mx - underlineW / 2, titleY + titleSz),
            p2: k.vec2(mx + underlineW / 2, titleY + titleSz + 1),
            width: 2.5, color: cFn(titleColor), opacity: 0.55,
        });

        // Description in handwritten font
        k.drawText({
            text: m.desc, pos: k.vec2(mx, titleY + 42),
            size: 22, font: "PatrickHand", color: cFn(C.pencil),
            anchor: "center", width: mw - 70, align: "center",
        });

        // ── Cost text + animated teacher-style GRADE (win only) ──
        // Laid out side-by-side on the same line so the grade reads as a
        // teacher's mark next to the student's work.
        const elapsed = m.openTime != null ? Math.max(0, k.time() - m.openTime) : 2;
        if (m.grade != null) {
            const lineY = titleY + 90;
            if (m.cost != null) {
                k.drawText({
                    text: `Cost: $${m.cost.toLocaleString()}`,
                    pos: k.vec2(mx - 40, lineY),
                    size: 20, font: "PatrickHand",
                    color: cFn(C.pencil),
                    anchor: "center",
                });
            }
            // Grade sits to the right of the cost text
            drawGrade(mx + 70, lineY, m.grade, elapsed);
        }

        // ── Teacher-grading animation ─────────────────────────────
        // Phase 1 (0 → 0.4s): letter strokes in (fade + scale with slight wobble).
        // Phase 2 (0.4 → 1.0s): red/gold marker circles around the letter.
        // Phase 3 (1.0s+):    idle — S shimmers and spawns orbiting sparkles.
        function drawGrade(cx, cy, letter, t) {
            const gradeColors = {
                S: "#d4a017",   // shiny gold
                A: "#16a34a",   // marker green
                B: "#2563eb",   // marker blue
                C: "#d4823c",   // marker orange
                F: "#dc2626",   // marker red
            };
            const color = gradeColors[letter] || "#dc2626";
            const writeDur = 0.9, circleDur = 1.1;
            const writeT  = Math.min(1, t / writeDur);
            const circleT = Math.max(0, Math.min(1, (t - writeDur) / circleDur));
            const idleT   = Math.max(0, t - writeDur - circleDur);

            // Ease-out cubic for letter scale / fade
            const eased = 1 - Math.pow(1 - writeT, 3);
            // Slight rotational wobble that decays as the letter is "written"
            const wobbleDeg = (1 - writeT) * Math.sin(t * 30) * 10;

            // Shimmer for S — lerps between deep gold and a brighter highlight
            let drawColor = color;
            if (letter === "S" && idleT > 0) {
                const phase = idleT * 1.6;
                const v = (Math.sin(phase) + 1) / 2;
                const lerp = (a, b) => Math.round(a + (b - a) * v);
                const r = lerp(0xd4, 0xff), g = lerp(0xa0, 0xe4), b = lerp(0x17, 0x5a);
                drawColor = "#" + [r, g, b].map(c => c.toString(16).padStart(2, "0")).join("");
            }

            // Letter (shadow + fill, rotated via transform stack) — drawn at
            // full size right away; the writing illusion comes from a
            // paper-colored mask that sweeps across the letter, revealing it
            // left-to-right, plus a tiny pen-tip dot at the current write edge.
            const letterSize = 32;
            k.pushTransform();
            k.pushTranslate(cx, cy);
            k.pushRotate(wobbleDeg);
            k.drawText({
                text: letter, pos: k.vec2(2, 2),
                size: letterSize, font: "PatrickHand",
                color: cFn("#1a0e05"), opacity: 0.3,
                anchor: "center",
            });
            k.drawText({
                text: letter, pos: k.vec2(0, 0),
                size: letterSize, font: "PatrickHand",
                color: cFn(drawColor), opacity: 1,
                anchor: "center",
            });
            k.popTransform();

            // Sweep-reveal mask: paper-colored rect covers the unwritten right
            // portion of the letter. Shrinks to zero as writeT hits 1.
            if (writeT < 1) {
                const letterBoxW = letterSize * 0.9;
                const maskLeft = cx - letterBoxW / 2 + letterBoxW * writeT;
                const maskW = letterBoxW * (1 - writeT) + 2;
                k.drawRect({
                    pos: k.vec2(maskLeft, cy - letterSize / 2 - 2),
                    width: maskW,
                    height: letterSize + 4,
                    color: cFn(C.paper),
                    anchor: "topleft",
                });

                // Pen-tip dot at the current write edge — the scribble
                // oscillation is tied to absolute time so it stays lively even
                // though the sweep itself is slower now.
                const scribble = Math.sin(t * 22) * letterSize * 0.3;
                const penX = maskLeft;
                const penY = cy + scribble;
                k.drawCircle({ pos: k.vec2(penX, penY), radius: 2.2, color: cFn("#1a0e05") });
                // Tiny trail of short ink strokes behind the pen
                for (let i = 1; i <= 3; i++) {
                    const trailT = writeT - i * 0.04;
                    if (trailT < 0) break;
                    const trailX = cx - letterBoxW / 2 + letterBoxW * trailT;
                    const trailY = cy + Math.sin((t - i * 0.04) * 22) * letterSize * 0.3;
                    k.drawCircle({ pos: k.vec2(trailX, trailY), radius: 1.2, color: cFn("#1a0e05"), opacity: 0.4 - i * 0.1 });
                }
            }

            // Marker circle — arc strokes in clockwise from the top
            if (circleT > 0) {
                const r = 22;
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
                    const dist = 30 + Math.sin(idleT * 1.8 + i) * 2;
                    const sx = cx + Math.cos(angle) * dist;
                    const sy = cy + Math.sin(angle) * dist;
                    const spk = 2.5 + Math.sin(idleT * 3 + i * 0.7) * 1;
                    k.drawCircle({ pos: k.vec2(sx, sy), radius: spk, color: cFn("#ffe17a"), opacity: 0.85 });
                    k.drawLine({ p1: k.vec2(sx - spk - 2, sy), p2: k.vec2(sx + spk + 2, sy), width: 1, color: cFn("#fff7c4"), opacity: 0.9 });
                    k.drawLine({ p1: k.vec2(sx, sy - spk - 2), p2: k.vec2(sx, sy + spk + 2), width: 1, color: cFn("#fff7c4"), opacity: 0.9 });
                }
            }
        }

        // ── Text-link buttons — pixel text on the page with an underline that
        //    animates in on hover. Matches the notebook aesthetic: the text just
        //    sits on the paper like a written-down option, and the underline is
        //    drawn under the word like you're marking a choice.
        // Hit test each button against current cursor
        const mpos = k.mousePos();
        const halfW = MODAL_BTN_W / 2, halfH = MODAL_BTN_H / 2;
        const hoverTarget = {
            primary:   Math.abs(mpos.x - mx) < halfW && Math.abs(mpos.y - (my + L.btnY.primary)) < halfH,
            ai:        beaten && Math.abs(mpos.x - mx) < halfW && Math.abs(mpos.y - (my + L.btnY.ai)) < halfH,
            secondary: Math.abs(mpos.x - mx) < halfW && Math.abs(mpos.y - (my + L.btnY.secondary)) < halfH,
        };

        // Ease hover progress toward target (fade in quick, fade out a touch quicker).
        // Branch on whether the button IS hovered — not on a `>` comparison against
        // the current value, which would flicker around the target when cur === tgt.
        const dt = k.dt() || 1 / 60;
        for (const key of ["primary", "ai", "secondary"]) {
            const cur = state.modalBtnHover[key];
            state.modalBtnHover[key] = hoverTarget[key]
                ? Math.min(1, cur + dt * 6)
                : Math.max(0, cur - dt * 8);
        }

        function linkBtn(cy, label, color, size, hoverKey, phase) {
            const t = state.modalBtnHover[hoverKey] || 0;
            // PatrickHand is variable-width; average glyph ≈ size * 0.5 wide
            const textW = label.length * size * 0.5;
            // Idle vertical bob — subtle breathing so the text doesn't feel
            // frozen. Different phase per button so they drift independently.
            const bob = Math.sin(k.time() * 1.3 + phase) * 0.8;
            const lineY = cy + bob;

            k.drawText({
                text: label,
                pos: k.vec2(mx, lineY),
                size, font: "PatrickHand",
                color: cFn(color),
                anchor: "center",
            });

            // Marker strike-through through the middle of the text, draws left
            // to right as hover progresses — like scribbling across the option
            if (t > 0.01) {
                const leftX = mx - textW / 2;
                k.drawLine({
                    p1: k.vec2(leftX, lineY),
                    p2: k.vec2(leftX + textW * t, lineY),
                    width: 2.5,
                    color: cFn(color),
                    opacity: 0.8,
                });
            }
        }

        // Primary — bold marker green (win) or bold marker red-orange (retry)
        linkBtn(my + L.btnY.primary,
                m.win ? "NEXT LEVEL" : "TRY AGAIN",
                m.win ? C.markerGreen : "#c4622a",
                26, "primary", 0);

        // AI — muted indigo highlighter, only offered when level has been beaten
        if (beaten) {
            linkBtn(my + L.btnY.ai, "TRY WITH AI", "#6b7db5", 22, "ai", 1.5);
        }

        // Secondary — plain pencil gray, smaller
        linkBtn(my + L.btnY.secondary, m.win ? "REPLAY" : "MENU", C.pencil, 22, "secondary", 3.0);
    }
}
