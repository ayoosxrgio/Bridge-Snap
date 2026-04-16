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
        curveMode: false,     // curve tool: click member, drag to bend
        curveTarget: null,    // { memberIdx, n1, n2, type } — member being curved
        mouseWorld: { x: 0, y: 0 },
        // Modal
        modal: null,         // { title, desc, score, win }
        // AI
        aiResult: null,      // { explanation, concept } or { error }
        aiLoading: false,
        aiPanelOpen: false,
        // Hint
        hintOpen: true,
        // Lesson panel
        lessonOpen: false,
        // Splash effects
        splashes: [],
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
                return { cfg, x: lX + mv.startXOffset, y: lY - base.h * 0.8, active: true, finished: false, vy: 0, vx: base.speed, angle: 0, angVel: 0, wheelAngle: 0, label: mv.label };
            });
        } else {
            const vcfg = VEHICLES[lvl.vType];
            state.vehicles = [{ cfg: vcfg, x: lX - 55, y: lY - vcfg.h * 0.8, active: true, finished: false, vy: 0, vx: vcfg.speed, angle: 0, angVel: 0, wheelAngle: 0, label: null }];
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
    // Curve icon (arc bending upward)
    const ICON_CURVE = [
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

    // Vehicle pixel art grids
    // 0=transparent, 1=body, 2=bodyDark, 3=window, 4=wheel, 5=hubcap, 6=headlight, 7=accent
    const VEHICLE_ART = {
        car: [
            [0,0,0,0,1,1,1,1,0,0,0,0],
            [0,0,1,1,3,3,1,1,1,1,0,0],
            [0,2,1,1,3,3,1,1,1,1,2,0],
            [2,1,1,1,1,1,1,1,1,1,1,2],
            [1,1,1,1,1,1,1,1,1,1,1,6],
            [0,0,4,4,0,0,0,0,0,4,4,0],
            [0,0,4,5,0,0,0,0,0,4,5,0],
        ],
        truck: [
            [0,0,0,0,0,0,0,0,0,0,0,1,1,1,0,0,0,0],
            [0,0,0,0,0,0,0,0,0,0,1,3,3,1,1,0,0,0],
            [0,0,0,0,0,0,0,0,0,2,1,3,3,1,1,2,0,0],
            [2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,0],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,6],
            [0,0,4,4,0,0,0,0,0,0,4,4,0,0,0,4,4,0],
            [0,0,4,5,0,0,0,0,0,0,4,5,0,0,0,4,5,0],
        ],
        train: [
            [7,7,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
            [7,7,1,1,3,3,1,1,3,3,1,1,3,3,1,1,3,3,1,1,1,1],
            [2,2,1,1,3,3,1,1,3,3,1,1,3,3,1,1,3,3,1,1,1,2],
            [2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,6],
            [0,4,4,0,0,4,4,0,0,4,4,0,0,4,4,0,0,4,4,0,0,0],
            [0,4,5,0,0,4,5,0,0,4,5,0,0,4,5,0,0,4,5,0,0,0],
        ],
    };

    function drawPixelVehicle(artKey, px, py, hw, hh, bodyColor) {
        const grid = VEHICLE_ART[artKey];
        if (!grid) return;
        const rows = grid.length, cols = grid[0].length;
        const pxW = (hw * 2) / cols;
        const pxH = (hh * 2) / rows;
        const ox = px - hw;
        const oy = py - hh;

        const bodyC = k.Color.fromHex(bodyColor);
        const darkR = Math.max(0, bodyC.r - 45);
        const darkG = Math.max(0, bodyC.g - 45);
        const darkB = Math.max(0, bodyC.b - 45);
        const darkHex = "#" + [darkR, darkG, darkB].map(v => v.toString(16).padStart(2, "0")).join("");

        const palette = [null, bodyColor, darkHex, "#a8cce0", "#1a1a1a", "#707070", "#fffde0", "#444444"];
        const outlineC = k.Color.fromHex("#010101");

        // Outline pass
        for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++)
                if (grid[r][c])
                    k.drawRect({ pos: k.vec2(ox + c * pxW - 1, oy + r * pxH - 1), width: pxW + 2, height: pxH + 2, color: outlineC, anchor: "topleft" });

        // Color pass
        for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++) {
                const v = grid[r][c];
                if (v) k.drawRect({ pos: k.vec2(ox + c * pxW, oy + r * pxH), width: pxW + 0.5, height: pxH + 0.5, color: k.Color.fromHex(palette[v]), anchor: "topleft" });
            }
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

    // Helper: get fixed anchor nodes for snap
    function getAnchors() {
        return state.nodes.filter(n => n.fixed);
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
                state.modal = { win: true, title: "MISSION COMPLETE!", desc: `${vName} crossed safely!`, score: `Cost: $${cost.toLocaleString()} · Grade: ${grade}` };
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
                state.modal = { win: false, title: "BRIDGE FAILED", desc: "Add triangular supports or reinforce stressed members.", score: null };
            }, 1000);
        }
    }

    // ═══════════════════════════════════════════════════
    //  INPUT
    // ═══════════════════════════════════════════════════
    k.onMousePress(() => {
        const pos = k.mousePos();
        // Modal button clicks
        if (state.modal) {
            const W = k.width(), H = k.height();
            const mx = W / 2, my = H / 2;
            // Primary button
            if (Math.abs(pos.x - mx) < 90 && Math.abs(pos.y - (my + 30)) < 20) {
                if (state.modal.win) {
                    const nx = levelIdx + 1;
                    if (nx < LEVELS.length) k.go("game", { levelIdx: nx });
                    else k.go("menu", { view: "levelSelect" });
                } else {
                    resetToBuild();
                }
                return;
            }
            // Secondary button
            if (Math.abs(pos.x - mx) < 90 && Math.abs(pos.y - (my + 65)) < 16) {
                if (state.modal.win) resetToBuild();
                else k.go("menu", { view: "levelSelect" });
                return;
            }
            return;
        }

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
                [m.n1, m.n2].forEach(n => {
                    if (!n.fixed && !state.members.some(mb => mb.n1 === n || mb.n2 === n))
                        state.nodes = state.nodes.filter(nd => nd !== n);
                });
            }
            return;
        }

        // Curve mode — click member to select, click again to apply curve
        if (state.curveMode) {
            if (state.curveTarget) {
                // Second click — apply the curve
                applyCurve();
            } else {
                // First click — select a member to curve
                const sc = getScale();
                const hi = state.members.findIndex(m => !m.builtin && distToSegment(wp, m.n1, m.n2) < 16 / sc);
                if (hi !== -1) {
                    const m = state.members[hi];
                    state.curveTarget = { member: m, x1: m.n1.x, y1: m.n1.y, x2: m.n2.x, y2: m.n2.y, type: m.type };
                }
            }
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
    });

    k.onMouseRelease(() => {
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
                    if (!exists) state.members.push(new Member(n1, n2, state.selectedMat));
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
                if (!exists) state.members.push(new Member(st, en, state.selectedMat));
            }
        }
        state.dragging = false;
    });

    // Keyboard shortcuts
    const availMats = lvlDef.materials || Object.keys(MATERIALS);
    for (let mi = 0; mi < availMats.length && mi < 9; mi++) {
        const matKey = availMats[mi];
        k.onKeyPress(String(mi + 1), () => { state.selectedMat = matKey; });
    }
    k.onKeyPress("d", () => { state.delMode = !state.delMode; state.lineMode = false; state.curveMode = false; state.curveTarget = null; });
    k.onKeyPress("f", () => { state.lineMode = !state.lineMode; state.delMode = false; state.curveMode = false; state.curveTarget = null; });
    k.onKeyPress("c", () => { state.curveMode = !state.curveMode; state.delMode = false; state.lineMode = false; state.curveTarget = null; });
    k.onKeyPress("z", () => { undoLast(); });
    k.onKeyPress("space", () => { toggleSim(); });
    k.onKeyPress("escape", () => { k.go("menu", { view: "levelSelect" }); });

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

    // ─── Curve: compute arc points from member + mouse offset ──
    function getCurvePoints(x1, y1, x2, y2, mouseX, mouseY) {
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len < 5) return null;
        // Project mouse onto the perpendicular of the member to get bulge amount
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        const nx = -dy / len, ny = dx / len; // normal (perpendicular)
        const bulgeH = (mouseX - mx) * nx + (mouseY - my) * ny; // signed perpendicular distance
        if (Math.abs(bulgeH) < GRID) return null; // too small to matter
        const segments = Math.max(2, Math.min(5, Math.round(len / (GRID * 3))));
        const pts = [];
        pts.push({ x: x1, y: y1 });
        for (let i = 1; i < segments; i++) {
            const t = i / segments;
            const bulge = 4 * t * (1 - t) * bulgeH; // parabolic
            pts.push({
                x: Math.round((x1 + dx * t + nx * bulge) / GRID) * GRID,
                y: Math.round((y1 + dy * t + ny * bulge) / GRID) * GRID,
            });
        }
        pts.push({ x: x2, y: y2 });
        return pts;
    }

    function applyCurve() {
        const ct = state.curveTarget;
        if (!ct) return;
        const pts = getCurvePoints(ct.x1, ct.y1, ct.x2, ct.y2, state.mouseWorld.x, state.mouseWorld.y);
        if (!pts) { state.curveTarget = null; return; }
        // Remove original member
        const idx = state.members.findIndex(m => m === ct.member);
        if (idx !== -1) state.members.splice(idx, 1);
        // Add curved segments
        for (let i = 0; i < pts.length - 1; i++) {
            const n1 = findOrCreate(pts[i].x, pts[i].y);
            const n2 = findOrCreate(pts[i + 1].x, pts[i + 1].y);
            if (n1 === n2) continue;
            const exists = state.members.some(mb =>
                (mb.n1 === n1 && mb.n2 === n2) || (mb.n2 === n1 && mb.n1 === n2));
            if (!exists) state.members.push(new Member(n1, n2, ct.type));
        }
        state.curveTarget = null;
    }

    function undoLast() {
        let idx = state.members.length - 1;
        while (idx >= 0 && state.members[idx].builtin) idx--;
        if (idx < 0) return;
        const last = state.members.splice(idx, 1)[0];
        [last.n1, last.n2].forEach(n => {
            if (!n.fixed && !n.builtin && !state.members.some(m => m.n1 === n || m.n2 === n))
                state.nodes = state.nodes.filter(nd => nd !== n);
        });
    }

    function toggleSim() {
        state.finishCalled = false;
        if (state.mode === "build") {
            const cost = calcCost(state.members);
            if (cost > lvl.budget) {
                state.modal = { win: false, title: "OVER BUDGET", desc: `$${cost.toLocaleString()} exceeds the $${lvl.budget.toLocaleString()} budget. Remove some members.`, score: null };
                return;
            }
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
            curveBtn: { x: matStartX + matKeys.length * (matBtnW + 4) + 120, y: pad + 8, w: 50, h: 32 },
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
            state.curveMode = false;
            state.delMode = false;
            return true;
        }

        // Curve button
        const cb = tb.curveBtn;
        if (pos.x >= cb.x && pos.x <= cb.x + cb.w && y >= cb.y && y <= cb.y + cb.h) {
            state.curveMode = !state.curveMode;
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

    // ─── AI Helper ──────────────────────────────────
    async function handleAiClick() {
        // Toggle panel off if already open
        if (state.aiPanelOpen && !state.aiLoading) {
            state.aiPanelOpen = false;
            return;
        }

        // Blueprint mode: AI can only build if the level has been beaten
        const completed = getCompleted();
        const levelBeaten = completed.includes(levelIdx);

        if (!levelBeaten) {
            // Level not yet beaten — just show a teaching tip, no auto-build
            state.aiPanelOpen = true;
            state.aiResult = {
                explanation: `Beat this level first to unlock the AI blueprint!\n\nTip: ${lvlDef.hint}`,
                concept: lvlDef.concept,
            };
            onRecapRequest();
            return;
        }

        // Level is beaten — allow AI to build the optimal bridge
        if (!getApiKey()) {
            const key = prompt("Enter your Anthropic API key:");
            if (key) setApiKey(key.trim());
            else return;
        }

        if (state.aiLoading) return;
        state.aiLoading = true;
        state.aiPanelOpen = true;
        state.aiResult = null;
        onRecapRequest();

        const result = await solveBridge(lvl, lvlDef);
        state.aiLoading = false;

        if (result.error) {
            state.aiResult = { error: result.error };
            return;
        }

        // Auto-build the AI's solution
        // First clear existing non-builtin members
        state.members = state.members.filter(m => m.builtin);
        state.nodes = state.nodes.filter(n => n.fixed || n.builtin);

        for (const mb of result.members) {
            const x1 = Math.round(mb.x1 / GRID) * GRID;
            const y1 = Math.round(mb.y1 / GRID) * GRID;
            const x2 = Math.round(mb.x2 / GRID) * GRID;
            const y2 = Math.round(mb.y2 / GRID) * GRID;
            const type = mb.type in MATERIALS ? mb.type : "wood_beam";

            const n1 = findOrCreate(x1, y1);
            const n2 = findOrCreate(x2, y2);
            const exists = state.members.some(m => (m.n1 === n1 && m.n2 === n2) || (m.n2 === n1 && m.n1 === n2));
            if (!exists) state.members.push(new Member(n1, n2, type));
        }

        state.aiResult = { explanation: result.explanation, concept: result.concept };
    }

    // ═══════════════════════════════════════════════════
    //  UPDATE (physics)
    // ═══════════════════════════════════════════════════
    k.onUpdate(() => {
        if (state.mode !== "sim" && state.mode !== "end") return;

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

            if (state.shakeMag > 0.05) state.shakeMag *= 0.80;
            else state.shakeMag = 0;

            state.flagWave += 0.05;
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
            drawMembers(sc);      // members behind water — fallen pieces look submerged
            drawGhostBeam(sc);
            drawCurvePreview(sc);
            drawNodes(sc);
            drawWater(W, H, sc);
            drawTerrain(sc);
            drawFlags(sc);        // flags behind vehicles
            drawVehicles(sc);
            drawSplashes(sc);
            drawParticles(sc);

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

        // ─── Build mode: fine grid with major/minor lines ───
        k.drawRect({ width: W, height: H, pos: k.vec2(0, 0), color: k.Color.fromHex("#d9c9a8"), anchor: "topleft" });

        const wLeft = toWorld(0, 0);
        const wRight = toWorld(W, H);

        const step = GRID;       // minor grid (12px)
        const major = GRID * 3;  // major grid (36px — old grid size)
        const originX = lX;
        const originY = lY;

        // Vertical lines
        const startX = originX - Math.ceil((originX - wLeft.x) / step) * step;
        for (let wx = startX; wx < wRight.x; wx += step) {
            const p1 = toScreen(wx, wLeft.y - 200);
            const p2 = toScreen(wx, wRight.y + 200);
            const isMajor = Math.abs(Math.round(wx / major) * major - wx) < 1;
            k.drawLine({ p1, p2, width: isMajor ? 1 : 0.5, color: k.Color.fromHex("#8a7350"), opacity: isMajor ? 0.35 : 0.15 });
        }
        // Horizontal lines
        const startY = originY - Math.ceil((originY - wLeft.y) / step) * step;
        for (let wy = startY; wy < wRight.y + GRID * 10; wy += step) {
            const p1 = toScreen(wLeft.x - 200, wy);
            const p2 = toScreen(wRight.x + 200, wy);
            const isMajor = Math.abs(Math.round(wy / major) * major - wy) < 1;
            k.drawLine({ p1, p2, width: isMajor ? 1 : 0.5, color: k.Color.fromHex("#8a7350"), opacity: isMajor ? 0.35 : 0.15 });
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
    function drawMembers(sc) {
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

        // Draw joint fills for road segments (skip broken)
        for (const m of state.members) {
            if (!MATERIALS[m.type].isRoad || m.broken) continue;
            const mat = MATERIALS[m.type];
            const r = mat.width * sc * 0.5;
            const col = k.Color.fromHex(getMemberColor(m));
            for (const n of [m.n1, m.n2]) {
                const p = toScreen(n.x, n.y);
                if (n.fixed) {
                    k.drawRect({ pos: k.vec2(p.x - r, p.y - r), width: r * 2, height: r * 2, color: col, anchor: "topleft" });
                } else {
                    k.drawCircle({ pos: p, radius: r, color: col });
                }
            }
        }

        for (const m of state.members) {
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

        // ── Draw joint dots at free nodes ──
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

    // ─── Curve preview ─────────────────────────────
    function drawCurvePreview(sc) {
        if (!state.curveMode || !state.curveTarget) return;
        const ct = state.curveTarget;
        const pts = getCurvePoints(ct.x1, ct.y1, ct.x2, ct.y2, state.mouseWorld.x, state.mouseWorld.y);

        // Highlight the original member
        const op1 = toScreen(ct.x1, ct.y1);
        const op2 = toScreen(ct.x2, ct.y2);
        k.drawLine({ p1: op1, p2: op2, width: 4, color: k.Color.fromHex(C.accent), opacity: 0.3 });

        if (pts) {
            // Draw the curved preview
            const previewCol = k.Color.fromHex(C.accent);
            for (let i = 0; i < pts.length - 1; i++) {
                const pp1 = toScreen(pts[i].x, pts[i].y);
                const pp2 = toScreen(pts[i + 1].x, pts[i + 1].y);
                k.drawLine({ p1: pp1, p2: pp2, width: MATERIALS[ct.type].width * sc * 0.6, color: previewCol, opacity: 0.6 });
            }
            // Dots at curve nodes
            for (let i = 1; i < pts.length - 1; i++) {
                const pp = toScreen(pts[i].x, pts[i].y);
                k.drawCircle({ pos: pp, radius: 5, color: previewCol, opacity: 0.7 });
            }
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

            // Use sprite if available, fall back to pixel art grid
            const spriteKey = v.cfg.sprite;
            let drewSprite = false;
            const vAngle = v.angle || 0;
            if (spriteKey) {
                try {
                    const sprW = hw * 4;
                    const sprH = sprW;
                    k.drawSprite({
                        sprite: spriteKey,
                        pos: k.vec2(px, py - hh * 0.3),
                        width: sprW,
                        height: sprH,
                        anchor: "center",
                        flipX: true,
                        angle: k.rad2deg(vAngle),
                    });
                    drewSprite = true;
                } catch(e) {}
            }
            if (!drewSprite) {
                // TODO: pixel art doesn't support rotation easily
                const artKey = v.cfg.w <= 40 ? "car" : v.cfg.w <= 80 ? "truck" : "train";
                drawPixelVehicle(artKey, px, py, hw, hh, v.cfg.color);
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
        const flagH = sc * 50;
        const flagW = flagH;

        // Animated flag sprite — positioned at road level
        const frame = Math.floor(state.flagWave * 3) % 5;
        try {
            k.drawSprite({
                sprite: "flag",
                frame: frame,
                pos: k.vec2(p.x, p.y + flagH * 0.05),
                width: flagW,
                height: flagH,
                anchor: "botleft",
            });
        } catch(e) {
            // Fallback rectangle flag
            const poleH = sc * 52;
            k.drawLine({ p1: k.vec2(p.x, p.y), p2: k.vec2(p.x, p.y - poleH), width: 2, color: k.Color.fromHex("#94a3b8") });
            k.drawRect({ pos: k.vec2(p.x + sc * 13, p.y - poleH + sc * 8), width: sc * 26, height: sc * 17, color: k.Color.fromHex(color), anchor: "center" });
        }

        // FINISH label
        k.drawText({
            text: label ? `CAR ${label}` : "FINISH",
            pos: k.vec2(p.x + flagW * 0.3, p.y + 8 * sc),
            size: Math.max(5, 5 * sc),
            font: "PressStart2P",
            color: k.Color.fromHex(triggered ? "#4ade80" : "#ffffff"),
            anchor: "center",
            opacity: 0.6,
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
        drawIconBtn(tb.curveBtn, ICON_CURVE, state.curveMode ? "#60d0ff" : "#fff8e0", state.curveMode ? "#1a5080" : null, iPx);
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

    // ─── AI panel ───────────────────────────────────
    function drawAiPanel() {
        if (!state.aiPanelOpen) return;
        const panelW = Math.min(300, k.width() * 0.4);
        const px = 10;
        const py = 110;

        // Notebook page
        k.drawRect({ pos: k.vec2(px + 2, py + 2), width: panelW, height: 160, color: k.Color.fromHex("#000000"), opacity: 0.1, anchor: "topleft", radius: 3 });
        k.drawRect({ pos: k.vec2(px, py), width: panelW, height: 160, color: k.Color.fromHex("#f8f5ee"), anchor: "topleft", radius: 2 });
        k.drawRect({ pos: k.vec2(px, py), width: panelW, height: 160, fill: false, outline: { width: 1, color: k.Color.fromHex("#c0b8a0") }, anchor: "topleft", radius: 2 });

        k.drawText({ text: "AI TUTOR", pos: k.vec2(px + 10, py + 10), size: 8, font: "PressStart2P", color: k.Color.fromHex(C.markerBlue) });

        if (state.aiLoading) {
            k.drawText({ text: "Thinking...", pos: k.vec2(px + 10, py + 35), size: 14, font: "PatrickHand", color: k.Color.fromHex(C.pencil), opacity: 0.6 });
        } else if (state.aiResult?.error) {
            k.drawText({ text: state.aiResult.error, pos: k.vec2(px + 10, py + 35), size: 12, font: "PatrickHand", color: k.Color.fromHex(C.danger), width: panelW - 20, lineSpacing: 2 });
        } else if (state.aiResult) {
            if (state.aiResult.concept) {
                k.drawText({ text: `Concept: ${state.aiResult.concept}`, pos: k.vec2(px + 10, py + 32), size: 13, font: "PatrickHand", color: k.Color.fromHex(C.markerGreen) });
            }
            k.drawText({ text: state.aiResult.explanation || "", pos: k.vec2(px + 10, py + 50), size: 11, font: "PatrickHand", color: k.Color.fromHex(C.pencil), width: panelW - 20, lineSpacing: 3 });
        } else {
            const beaten = getCompleted().includes(levelIdx);
            const tip = beaten
                ? "Click to auto-build an optimal bridge\nand learn why it works!"
                : "Beat this level first to unlock\nthe AI blueprint builder!";
            k.drawText({ text: tip, pos: k.vec2(px + 10, py + 35), size: 13, font: "PatrickHand", color: k.Color.fromHex(C.pencil), width: panelW - 20, lineSpacing: 3, opacity: 0.5 });
        }
    }

    // ─── Modal (result screen) ──────────────────────
    function drawModal() {
        const m = state.modal;
        const W = k.width(), H = k.height();

        k.drawRect({ pos: k.vec2(0, 0), width: W, height: H, color: k.Color.fromHex("#000000"), anchor: "topleft", opacity: 0.4 });

        const mw = Math.min(320, W * 0.7);
        const mh = 200;
        const mx = W / 2, my = H / 2;

        // Index card style
        k.drawRect({ pos: k.vec2(mx + 3, my + 3), width: mw, height: mh, color: k.Color.fromHex("#000000"), anchor: "center", opacity: 0.15, radius: 6 });
        k.drawRect({ pos: k.vec2(mx, my), width: mw, height: mh, color: k.Color.fromHex("#fffefa"), anchor: "center", radius: 5 });
        k.drawRect({ pos: k.vec2(mx, my), width: mw, height: mh, fill: false, outline: { width: 2, color: k.Color.fromHex(m.win ? C.markerGreen : C.markerRed) }, anchor: "center", radius: 5 });

        for (let ly = my - mh / 2 + 40; ly < my + mh / 2 - 10; ly += 18) {
            k.drawLine({ p1: k.vec2(mx - mw / 2 + 20, ly), p2: k.vec2(mx + mw / 2 - 20, ly), width: 0.5, color: k.Color.fromHex("#c0d8e8"), opacity: 0.3 });
        }

        k.drawText({ text: m.title, pos: k.vec2(mx, my - 60), size: 12, font: "PressStart2P", color: k.Color.fromHex(m.win ? C.markerGreen : C.markerRed), anchor: "center" });
        k.drawText({ text: m.desc, pos: k.vec2(mx, my - 25), size: 12, font: "PatrickHand", color: k.Color.fromHex(C.pencil), anchor: "center", width: mw - 40 });

        if (m.score) {
            k.drawText({ text: m.score, pos: k.vec2(mx, my + 5), size: 10, font: "PressStart2P", color: k.Color.fromHex(C.gold), anchor: "center" });
        }

        // Primary button
        k.drawRect({ pos: k.vec2(mx, my + 30), width: 180, height: 32, color: k.Color.fromHex(m.win ? C.markerGreen : C.accent), anchor: "center" });
        k.drawText({ text: m.win ? "NEXT LEVEL" : "TRY AGAIN", pos: k.vec2(mx, my + 30), size: 8, font: "PressStart2P", color: k.Color.fromHex("#ffffff"), anchor: "center" });

        // Secondary button
        k.drawRect({ pos: k.vec2(mx, my + 65), width: 180, height: 28, fill: false, outline: { width: 1, color: k.Color.fromHex("#c0b8a0") }, anchor: "center" });
        k.drawText({ text: m.win ? "REPLAY" : "MENU", pos: k.vec2(mx, my + 65), size: 8, font: "PressStart2P", color: k.Color.fromHex(C.pencil), anchor: "center" });
    }
}
