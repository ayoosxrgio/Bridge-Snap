import { C } from "../constants.js";
import { LEVELS } from "../levels.js";
import { isUnlocked, getGrade, resetProgress } from "../progression.js";
import { getLeaderboard } from "../leaderboard.js";
// Settings persistence
const SETTINGS_KEY_INIT = "bridgesnap_settings";
const SETTINGS_DEFAULTS = { masterVol: 0.8, musicVol: 0.7, sfxVol: 0.9, showGrid: true, showStress: true, fpsCap: 60 };
// FPS cap options — 0 means uncapped (physics matches display refresh rate)
const FPS_OPTIONS = [30, 60, 0];
const FPS_LABELS = ["30", "60", "∞"];
function loadSettings() {
    try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY_INIT)) }; }
    catch { return { ...SETTINGS_DEFAULTS }; }
}

export function menuScene(k, params = {}) {
    const startAtLevelSelect = params.view === "levelSelect";
    let hoverPlay = false;
    let hoverSettings = false;
    let hoverCredits = false;
    let time = 0;

    const col = (hex) => k.Color.fromHex(hex);

    // ─── Floating confetti particles ─────────────────
    const confettiColors = ["#e05080","#50a0e0","#e0c030","#50c060","#e07030","#a060d0"];
    const confetti = [];
    for (let i = 0; i < 28; i++) {
        confetti.push({
            x: 0.3 + Math.random() * 0.4,   // cluster around center
            y: 0.48 + Math.random() * 0.42,  // around button area
            w: 6 + Math.random() * 10,
            h: 6 + Math.random() * 10,
            rot: Math.random() * Math.PI * 2,
            rotSpd: (Math.random() - 0.5) * 1.2,
            driftX: (Math.random() - 0.5) * 0.008,
            driftY: -0.002 - Math.random() * 0.005,
            phase: Math.random() * Math.PI * 2,
            col: confettiColors[Math.floor(Math.random() * confettiColors.length)],
            opacity: 0.35 + Math.random() * 0.35,
        });
    }

    // ─── Random doodle system ────────────────────────
    const DOODLE_TYPES = ["warren", "suspension", "arch", "triangle", "pratt", "howe", "cablestayed"];
    const doodles = [];
    let doodleSpawnTimer = 0;
    let lastTypeIdx = -1;

    function doodleTooClose(fx, fy) {
        const minDist = 0.22; // fraction of screen — prevents overlap
        for (const d of doodles) {
            const dx = d.fx - fx, dy = d.fy - fy;
            if (Math.sqrt(dx * dx + dy * dy) < minDist) return true;
        }
        return false;
    }

    function spawnDoodle() {
        // Pick a type we haven't just shown
        let idx;
        do { idx = Math.floor(Math.random() * DOODLE_TYPES.length); } while (idx === lastTypeIdx);
        lastTypeIdx = idx;

        // Try to find a non-overlapping position (up to 10 attempts)
        let fx, fy, attempts = 0;
        do {
            fx = 0.05 + Math.random() * 0.90;
            fy = 0.08 + Math.random() * 0.84;
            attempts++;
        } while (doodleTooClose(fx, fy) && attempts < 10);
        if (attempts >= 10 && doodleTooClose(fx, fy)) return; // skip if can't find space

        doodles.push({
            type: DOODLE_TYPES[idx],
            fx, fy,
            // Slow drift direction
            driftX: (Math.random() - 0.5) * 0.025,
            driftY: (Math.random() - 0.5) * 0.015,
            scale: 0.7 + Math.random() * 0.7,
            opacity: 0,
            state: "fadein",
            timer: 0,
            visibleDuration: 5 + Math.random() * 5,
        });
    }

    // Seed a few doodles at start (staggered)
    for (let i = 0; i < 4; i++) {
        spawnDoodle();
        const d = doodles[doodles.length - 1];
        d.state = "visible";
        d.opacity = 1;
        d.timer = Math.random() * 3;
    }

    function updateDoodles(dt) {
        doodleSpawnTimer -= dt;
        if (doodleSpawnTimer <= 0 && doodles.length < 6) {
            spawnDoodle();
            doodleSpawnTimer = 2 + Math.random() * 3;
        }

        for (let i = doodles.length - 1; i >= 0; i--) {
            const d = doodles[i];
            d.timer += dt;

            // Drift
            d.fx += d.driftX * dt;
            d.fy += d.driftY * dt;
            // Wrap around
            if (d.fx < -0.15) d.fx = 1.15;
            if (d.fx > 1.15) d.fx = -0.15;
            if (d.fy < -0.10) d.fy = 1.10;
            if (d.fy > 1.10) d.fy = -0.10;

            if (d.state === "fadein") {
                d.opacity = Math.min(1, d.timer / 1.5);
                if (d.opacity >= 1) { d.state = "visible"; d.timer = 0; }
            } else if (d.state === "visible") {
                if (d.timer > d.visibleDuration) { d.state = "fadeout"; d.timer = 0; }
            } else if (d.state === "fadeout") {
                d.opacity = Math.max(0, 1 - d.timer / 1.2);
                if (d.opacity <= 0) { doodles.splice(i, 1); }
            }
        }
    }

    function drawDoodle(d, W, H) {
        const ox = d.fx * W;
        const oy = d.fy * H;
        const sc = d.scale;
        const op = d.opacity * 0.38;
        const dc = "#5a4010";

        function dline(x1, y1, x2, y2, w = 1.5) {
            k.drawLine({ p1: k.vec2(x1, y1), p2: k.vec2(x2, y2), width: w * sc, color: col(dc), opacity: op });
        }

        if (d.type === "warren") {
            // Warren: zigzag diags, no internal verticals
            const panels = 5, pw = 50 * sc, ph = 30 * sc, tw = pw * panels;
            dline(ox-tw/2, oy, ox+tw/2, oy, 2);
            dline(ox-tw/2, oy-ph, ox+tw/2, oy-ph, 2);
            dline(ox-tw/2, oy, ox-tw/2, oy-ph);
            dline(ox+tw/2, oy, ox+tw/2, oy-ph);
            for (let i = 0; i < panels; i++) {
                if (i%2===0) dline(ox-tw/2+i*pw, oy, ox-tw/2+(i+1)*pw, oy-ph);
                else         dline(ox-tw/2+i*pw, oy-ph, ox-tw/2+(i+1)*pw, oy);
            }
        } else if (d.type === "pratt") {
            // Pratt: verticals + diags toward center
            const panels = 6, pw = 40 * sc, ph = 28 * sc, tw = pw * panels;
            dline(ox-tw/2, oy, ox+tw/2, oy, 2);
            dline(ox-tw/2, oy-ph, ox+tw/2, oy-ph, 2);
            for (let i = 0; i <= panels; i++) dline(ox-tw/2+i*pw, oy, ox-tw/2+i*pw, oy-ph);
            for (let i = 0; i < panels; i++) {
                const mid = panels/2;
                if (i < mid) dline(ox-tw/2+i*pw, oy, ox-tw/2+(i+1)*pw, oy-ph);
                else         dline(ox-tw/2+(i+1)*pw, oy, ox-tw/2+i*pw, oy-ph);
            }
        } else if (d.type === "howe") {
            // Howe: verticals + diags away from center (opposite of Pratt)
            const panels = 6, pw = 40 * sc, ph = 28 * sc, tw = pw * panels;
            dline(ox-tw/2, oy, ox+tw/2, oy, 2);
            dline(ox-tw/2, oy-ph, ox+tw/2, oy-ph, 2);
            for (let i = 0; i <= panels; i++) dline(ox-tw/2+i*pw, oy, ox-tw/2+i*pw, oy-ph);
            for (let i = 0; i < panels; i++) {
                const mid = panels/2;
                if (i < mid) dline(ox-tw/2+i*pw, oy-ph, ox-tw/2+(i+1)*pw, oy);
                else         dline(ox-tw/2+(i+1)*pw, oy-ph, ox-tw/2+i*pw, oy);
            }
        } else if (d.type === "suspension") {
            // Suspension: towers + catenary cable + hangers
            const span = 200 * sc, tH = 55 * sc, sagY = 20 * sc;
            dline(ox-span/2, oy, ox+span/2, oy, 2);
            dline(ox-span*0.25, oy, ox-span*0.25, oy-tH, 2);
            dline(ox+span*0.25, oy, ox+span*0.25, oy-tH, 2);
            const segs = 14;
            function cableY(f) {
                return f<=0.25 ? oy-tH*(f/0.25) : f>=0.75 ? oy-tH*((1-f)/0.25) : oy-tH+sagY*4*(f-0.25)*(0.75-f)/0.25;
            }
            for (let i = 0; i < segs; i++) {
                const f1 = i/segs, f2 = (i+1)/segs;
                dline(ox-span/2+f1*span, cableY(f1), ox-span/2+f2*span, cableY(f2));
            }
            for (let i = 1; i < 8; i++) {
                const f = i/8;
                const hx = ox-span/2+f*span;
                dline(hx, cableY(f), hx, oy, 1);
            }
        } else if (d.type === "cablestayed") {
            // Cable-stayed: one or two towers with fan cables
            const span = 180 * sc, tH = 60 * sc;
            dline(ox-span/2, oy, ox+span/2, oy, 2);
            // Single tower at center
            dline(ox, oy, ox, oy-tH, 2);
            // Fan cables from tower top to deck
            for (let i = 1; i <= 5; i++) {
                const dx = i * span * 0.09;
                dline(ox, oy-tH, ox-dx, oy);
                dline(ox, oy-tH, ox+dx, oy);
            }
        } else if (d.type === "arch") {
            // Tied arch: arch above deck + hangers
            const span = 140 * sc, rise = 50 * sc;
            dline(ox-span/2, oy, ox+span/2, oy, 2);
            const segs = 12;
            for (let i = 0; i < segs; i++) {
                const t1 = i/segs, t2 = (i+1)/segs;
                dline(ox-span/2+t1*span, oy-Math.sin(Math.PI*t1)*rise, ox-span/2+t2*span, oy-Math.sin(Math.PI*t2)*rise);
            }
            for (let i = 1; i < 6; i++) {
                const t = i/6;
                dline(ox-span/2+t*span, oy-Math.sin(Math.PI*t)*rise, ox-span/2+t*span, oy, 1);
            }
        } else if (d.type === "triangle") {
            // Triangle with force arrow
            const s = 55 * sc;
            dline(ox-s, oy, ox+s, oy, 2);
            dline(ox-s, oy, ox, oy-s*0.85, 2);
            dline(ox+s, oy, ox, oy-s*0.85, 2);
            // Arrow
            dline(ox, oy-s*0.85-16*sc, ox, oy-s*0.85-2*sc, 1.5);
            dline(ox-5*sc, oy-s*0.85-8*sc, ox, oy-s*0.85-2*sc, 1.5);
            dline(ox+5*sc, oy-s*0.85-8*sc, ox, oy-s*0.85-2*sc, 1.5);
            k.drawText({ text: "F", pos: k.vec2(ox, oy-s*0.85-22*sc), size: 10*sc, font: "PatrickHand", color: col(dc), opacity: op*0.8, anchor: "center" });
        }

    }

    // ─── Button crack animation ────────────────────
    // When a button is clicked, it snaps in half before transitioning
    let crackAnim = null;
    let scrollY = 0;       // 0 = menu, positive = level select (up), negative = settings (down)
    let scrollTarget = 0;
    let currentView = startAtLevelSelect ? "levelSelect" : "menu";
    let needsInitScroll = startAtLevelSelect;
    let lsSelectedIdx = -1;
    let scrollDist = 0;
    // Card-cascade animation: re-armed every time the player arrives at the
    // level-select screen. -1 means "not animating". Set when scrollY first
    // crosses fully into level-select; cleared when leaving.
    let lsAnimStart = -1;
    let lsWasIn = false;
    // Leaderboard slide-in panel state
    let lbOpen = false;
    let lbAnimT = 0;             // 0 = closed, 1 = fully slid in (eased toward lbOpen)
    let lbLevel = 0;
    let lbData = null;
    let lbLoadingFor = -1;       // level idx currently being fetched (debounce)

    // ─── Settings state ──────────────────────────────
    const SETTINGS_KEY = "bridgesnap_settings";
    let settingsData = loadSettings();
    let settingsDragging = null;
    let settingsMessage = null;
    let settingsMsgTimer = 0;
    function saveSettingsData() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsData)); } catch {}
    }

    // ─── Sticky note rip animation ─────────────────
    let noteRip = null; // { idx, cx, cy, w, h, noteCol, t, vy, rot, rotSpd, pieces }

    function loadLeaderboard(levelIdx) {
        const lvl = LEVELS[levelIdx];
        if (!lvl) return;
        lbLoadingFor = levelIdx;
        lbData = null;
        getLeaderboard(lvl.id, { budget: lvl.budget }).then(res => {
            // Drop stale results if the user has tabbed to a different level
            if (lbLoadingFor === levelIdx) lbData = res;
        }).catch(() => { if (lbLoadingFor === levelIdx) lbData = { error: true }; });
    }

    function startCrack(btnIdx, cx, cy, w, h, target) {
        const angle = plankAngles[btnIdx] || 0;
        const sparks = [];
        for (let i = 0; i < 16; i++) {
            const a = Math.random() * Math.PI * 2;
            const spd = 80 + Math.random() * 200;
            sparks.push({
                x: cx, y: cy,
                vx: Math.cos(a) * spd,
                vy: Math.sin(a) * spd - 60,
                life: 0.3 + Math.random() * 0.4,
                maxLife: 0.5,
                r: 2 + Math.random() * 4,
                col: ["#e0a030","#c07020","#ffe080","#ffffff"][Math.floor(Math.random()*4)],
            });
        }
        crackAnim = {
            btnIdx, t: 0, target, cx, cy, w, h, angle, sparks,
            // Left half flies left+down, right half flies right+down
            leftVx: -120 - Math.random() * 80,
            leftVy: 30 + Math.random() * 40,
            leftRot: -2 - Math.random() * 3,
            rightVx: 120 + Math.random() * 80,
            rightVy: 20 + Math.random() * 50,
            rightRot: 2 + Math.random() * 3,
        };
    }

    function updateCrack(dt) {
        if (!crackAnim) return;
        crackAnim.t += dt;

        // Update sparks
        for (const s of crackAnim.sparks) {
            s.life -= dt;
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            s.vy += 300 * dt;
        }
        crackAnim.sparks = crackAnim.sparks.filter(s => s.life > 0);

        // After crack animation completes, go to target scene
        if (crackAnim.t > 0.6) {
            const target = crackAnim.target;
            crackAnim = null;
            k.go(target);
        }
    }

    function drawCrack(W, H) {
        if (!crackAnim) return;
        const c = crackAnim;
        const t = c.t;
        const angle = c.angle;

        // Each half: offset from center, rotating away
        function drawHalf(side) {
            const sign = side === "left" ? -1 : 1;
            const vx = side === "left" ? c.leftVx : c.rightVx;
            const vy = side === "left" ? c.leftVy : c.rightVy;
            const rotSpd = side === "left" ? c.leftRot : c.rightRot;

            const offX = vx * t;
            const offY = vy * t + 150 * t * t; // gravity
            const extraRot = rotSpd * t;
            const totalAngle = angle + extraRot;
            const opacity = 1;

            const hcx = c.cx + sign * c.w * 0.25 + offX;
            const hcy = c.cy + offY;
            const hw = c.w * 0.5, hh = c.h / 2;

            function rot(x, y) {
                const dx = x - hcx, dy = y - hcy;
                const cos = Math.cos(totalAngle), sin = Math.sin(totalAngle);
                return k.vec2(hcx + dx*cos - dy*sin, hcy + dx*sin + dy*cos);
            }

            const tl = rot(hcx - hw/2, hcy - hh);
            const tr = rot(hcx + hw/2, hcy - hh);
            const br = rot(hcx + hw/2, hcy + hh);
            const bl = rot(hcx - hw/2, hcy + hh);

            // Border
            k.drawTriangle({ p1: tl, p2: tr, p3: br, color: col("#8e4924"), opacity: opacity * 0.9 });
            k.drawTriangle({ p1: tl, p2: br, p3: bl, color: col("#8e4924"), opacity: opacity * 0.9 });
            // Fill (inset)
            const ftl = rot(hcx - hw/2 + 2, hcy - hh + 2);
            const ftr = rot(hcx + hw/2 - 2, hcy - hh + 2);
            const fbr = rot(hcx + hw/2 - 2, hcy + hh - 2);
            const fbl = rot(hcx - hw/2 + 2, hcy + hh - 2);
            k.drawTriangle({ p1: ftl, p2: ftr, p3: fbr, color: col("#d37e3d"), opacity: opacity });
            k.drawTriangle({ p1: ftl, p2: fbr, p3: fbl, color: col("#d37e3d"), opacity: opacity });

            // Jagged crack edge
            const edgeX = side === "left" ? hw/2 : -hw/2;
            for (let j = -hh; j < hh; j += 8) {
                const jag = (Math.random() - 0.5) * 6;
                const p1 = rot(hcx + edgeX + jag, hcy + j);
                const p2 = rot(hcx + edgeX + (Math.random()-0.5)*6, hcy + j + 8);
                k.drawLine({ p1, p2, width: 2, color: col("#3a1e05"), opacity: opacity * 0.5 });
            }
        }

        drawHalf("left");
        drawHalf("right");

        // Sparks
        for (const s of c.sparks) {
            const alpha = Math.max(0, s.life / s.maxLife);
            k.drawCircle({ pos: k.vec2(s.x, s.y), radius: s.r * alpha, color: col(s.col), opacity: alpha * 0.9 });
        }
    }

    // ─── Plank button angles (fixed per session, slight tilt) ──
    const plankAngles = [
        -0.03 + Math.random() * 0.02,
         0.02 + Math.random() * 0.02,
        -0.01 - Math.random() * 0.02,
    ];

    // ─── Draw bridge halves in corners ─────────────
    function drawBridgeDecor(W, H, oy) {
        const FW = 38;

        const leftData = k.getSprite("bridgeLeft");
        if (leftData) {
            const aspect = leftData.data.height / leftData.data.width;
            const drawH = H * 1.6;
            const drawW = drawH / aspect;
            const sway = Math.sin(time * 0.8) * 2;
            const bob  = Math.sin(time * 1.1 + 0.5) * 1.5;
            k.drawSprite({
                sprite: "bridgeLeft",
                pos: k.vec2(FW - drawW * 0.24 + sway, H - FW + drawH * 0.42 + bob + oy),
                width: drawW, height: drawH, anchor: "botleft",
            });
        }

        const rightData = k.getSprite("bridgeRight");
        if (rightData) {
            const aspect = rightData.data.height / rightData.data.width;
            const drawH = H * 1.6;
            const drawW = drawH / aspect;
            const sway = Math.sin(time * 0.8 + Math.PI) * 2;
            const bob  = Math.sin(time * 1.1 + 2.0) * 1.5;
            k.drawSprite({
                sprite: "bridgeRight",
                pos: k.vec2(W - FW + drawW * 0.05 + sway, H - FW + drawH * 0.42 + bob + oy),
                width: drawW, height: drawH, anchor: "botright",
            });
        }
    }

    // ─── Draw floating confetti ──────────────────────
    function drawConfetti(W, H, dt, oy) {
        for (const c of confetti) {
            c.rot += c.rotSpd * dt;
            c.x += c.driftX * dt;
            c.y += c.driftY * dt;

            // Wrap around if out of bounds
            if (c.y < 0.40) { c.y = 0.92; c.x = 0.3 + Math.random() * 0.4; }
            if (c.x < 0.15) c.x = 0.85;
            if (c.x > 0.85) c.x = 0.15;

            const wobble = Math.sin(time * 2 + c.phase) * 0.3;
            const px = c.x * W;
            const py = c.y * H + (oy || 0);

            // Each confetti piece: a small colored rectangle
            // (Can't rotate rects easily, so draw as a diamond via two triangles)
            const s = c.w * 0.5;
            const angle = c.rot + wobble;
            const cos = Math.cos(angle), sin = Math.sin(angle);

            // Four corners of rotated rect
            const hw = c.w * 0.5, hh = c.h * 0.5;
            const pts = [
                k.vec2(px + (-hw * cos - (-hh) * sin), py + (-hw * sin + (-hh) * cos)),
                k.vec2(px + ( hw * cos - (-hh) * sin), py + ( hw * sin + (-hh) * cos)),
                k.vec2(px + ( hw * cos - ( hh) * sin), py + ( hw * sin + ( hh) * cos)),
                k.vec2(px + (-hw * cos - ( hh) * sin), py + (-hw * sin + ( hh) * cos)),
            ];

            k.drawTriangle({
                p1: pts[0], p2: pts[1], p3: pts[2],
                color: col(c.col), opacity: c.opacity,
            });
            k.drawTriangle({
                p1: pts[0], p2: pts[2], p3: pts[3],
                color: col(c.col), opacity: c.opacity,
            });
        }
    }

    // ─── Fallen plank button ─────────────────────────
    // Styled like a broken bridge plank that fell
    function drawPlankButton(cx, cy, w, h, label, hovered, angleIdx) {
        const angle = plankAngles[angleIdx] || 0;

        // Helper to rotate a point around (cx, cy)
        function rot(x, y) {
            const dx = x - cx, dy = y - cy;
            const cos = Math.cos(angle), sin = Math.sin(angle);
            return k.vec2(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
        }

        const hw = w / 2, hh = h / 2;

        // Four corners of the tilted plank
        const tl = rot(cx - hw, cy - hh);
        const tr = rot(cx + hw, cy - hh);
        const br = rot(cx + hw, cy + hh);
        const bl = rot(cx - hw, cy + hh);

        // Shadow (offset)
        const stl = rot(cx - hw + 3, cy - hh + 4);
        const str = rot(cx + hw + 3, cy - hh + 4);
        const sbr = rot(cx + hw + 3, cy + hh + 4);
        const sbl = rot(cx - hw + 3, cy + hh + 4);
        k.drawTriangle({ p1: stl, p2: str, p3: sbr, color: col("#1a0e05"), opacity: 0.25 });
        k.drawTriangle({ p1: stl, p2: sbr, p3: sbl, color: col("#1a0e05"), opacity: 0.25 });

        // Dark border plank
        const btl = rot(cx - hw - 2, cy - hh - 2);
        const btr = rot(cx + hw + 2, cy - hh - 2);
        const bbr = rot(cx + hw + 2, cy + hh + 2);
        const bbl = rot(cx - hw - 2, cy + hh + 2);
        k.drawTriangle({ p1: btl, p2: btr, p3: bbr, color: col("#8e4924"), opacity: 0.9 });
        k.drawTriangle({ p1: btl, p2: bbr, p3: bbl, color: col("#8e4924"), opacity: 0.9 });

        // Main plank fill
        const plankCol = hovered ? "#e08e4d" : "#d37e3d";
        k.drawTriangle({ p1: tl, p2: tr, p3: br, color: col(plankCol) });
        k.drawTriangle({ p1: tl, p2: br, p3: bl, color: col(plankCol) });

        // Highlight strip along top edge
        const htl = rot(cx - hw + 4, cy - hh + 1);
        const htr = rot(cx + hw - 4, cy - hh + 1);
        const hbl = rot(cx - hw + 4, cy - hh + 4);
        const hbr = rot(cx + hw - 4, cy - hh + 4);
        k.drawTriangle({ p1: htl, p2: htr, p3: hbr, color: col("#e0b860"), opacity: 0.35 });
        k.drawTriangle({ p1: htl, p2: hbr, p3: hbl, color: col("#e0b860"), opacity: 0.35 });

        // Grain lines (straight, drawn unrotated is ok — subtle enough)
        for (let gx = cx - hw + 14; gx < cx + hw - 8; gx += 16) {
            const gt = rot(gx, cy - hh + 3);
            const gb = rot(gx + 3, cy + hh - 3);
            k.drawLine({ p1: gt, p2: gb, width: 0.8, color: col("#8a5520"), opacity: 0.14 });
        }

        // Crack/break line on one end (random but consistent via angle)
        const crackSide = angleIdx % 2 === 0 ? -1 : 1;
        const cx1 = rot(cx + crackSide * (hw - 6), cy - hh + 4);
        const cx2 = rot(cx + crackSide * (hw - 2), cy - 2);
        const cx3 = rot(cx + crackSide * (hw - 8), cy + 6);
        k.drawLine({ p1: cx1, p2: cx2, width: 1.5, color: col("#3a1e05"), opacity: 0.3 });
        k.drawLine({ p1: cx2, p2: cx3, width: 1.5, color: col("#3a1e05"), opacity: 0.25 });

        // Label text (centered, not rotated — stays readable)
        k.drawText({ text: label, pos: k.vec2(cx + 1, cy + 2), size: 14, font: "PressStart2P", color: col("#1a0e05"), anchor: "center", opacity: 0.3 });
        k.drawText({ text: label, pos: k.vec2(cx, cy), size: 14, font: "PressStart2P", color: col("#010101"), anchor: "center" });
    }

    // ─── Logo ────────────────────────────────────────
    function drawLogo(W, H) {
        const logoData = k.getSprite("logo");
        if (!logoData) return;

        const targetW = Math.floor(W * 0.45);
        const aspect  = logoData.data.height / logoData.data.width;
        const targetH = Math.floor(targetW * aspect);

        const bob   = Math.sin(time * 1.4) * 2.5;
        const drift = Math.sin(time * 0.7 + 1.2) * 1.5;
        const lx = Math.floor(W / 2 + drift);
        const ly = Math.floor(H * 0.42 + bob + scrollY);

        // Shadow
        k.drawSprite({
            sprite: "logo", pos: k.vec2(lx + 4, ly + 4),
            width: targetW, height: targetH, anchor: "center",
            opacity: 0.15, color: col("#1a0e05"),
        });
        // Logo
        k.drawSprite({
            sprite: "logo", pos: k.vec2(lx, ly),
            width: targetW, height: targetH, anchor: "center",
        });
    }

    // ─── Wooden frame ────────────────────────────────
    function drawFrame(W, H) {
        const FW = 38;
        const cornerSz = FW + 8;
        k.drawRect({ pos: k.vec2(W/2, FW/2),     width: W, height: FW, color: col("#6b3d10"), anchor: "center" });
        k.drawRect({ pos: k.vec2(W/2, H-FW/2),   width: W, height: FW, color: col("#6b3d10"), anchor: "center" });
        k.drawRect({ pos: k.vec2(FW/2, H/2),      width: FW, height: H, color: col("#5a3010"), anchor: "center" });
        k.drawRect({ pos: k.vec2(W-FW/2, H/2),    width: FW, height: H, color: col("#5a3010"), anchor: "center" });
        for (let gx = FW; gx < W-FW; gx += 22) {
            k.drawLine({ p1: k.vec2(gx, 2), p2: k.vec2(gx+6, FW-2), width: 1, color: col("#8a5020"), opacity: 0.15 });
            k.drawLine({ p1: k.vec2(gx, H-2), p2: k.vec2(gx+6, H-FW+2), width: 1, color: col("#8a5020"), opacity: 0.15 });
        }
        for (let gy = FW; gy < H-FW; gy += 22) {
            k.drawLine({ p1: k.vec2(2, gy), p2: k.vec2(FW-2, gy+6), width: 1, color: col("#8a5020"), opacity: 0.15 });
            k.drawLine({ p1: k.vec2(W-2, gy), p2: k.vec2(W-FW+2, gy+6), width: 1, color: col("#8a5020"), opacity: 0.15 });
        }
        k.drawRect({ pos: k.vec2(W/2, H/2), width: W-FW*2, height: H-FW*2, fill: false, outline: { width: 4, color: col("#1a0e05") }, anchor: "center", opacity: 0.5 });
        k.drawRect({ pos: k.vec2(W/2, H/2), width: W, height: H, fill: false, outline: { width: 3, color: col("#c4843c") }, anchor: "center" });
        const corners = [[cornerSz/2,cornerSz/2],[W-cornerSz/2,cornerSz/2],[cornerSz/2,H-cornerSz/2],[W-cornerSz/2,H-cornerSz/2]];
        for (const [cx, cy] of corners) {
            k.drawRect({ pos: k.vec2(cx, cy), width: cornerSz, height: cornerSz, color: col("#8a5020"), anchor: "center", radius: 3 });
            k.drawRect({ pos: k.vec2(cx, cy), width: cornerSz, height: cornerSz, fill: false, outline: { width: 2, color: col("#4a2808") }, anchor: "center", radius: 3 });
            k.drawCircle({ pos: k.vec2(cx, cy), radius: 8, color: col("#5a3010") });
            k.drawCircle({ pos: k.vec2(cx, cy), radius: 8, fill: false, outline: { width: 1.5, color: col("#3a1e05") } });
            k.drawCircle({ pos: k.vec2(cx-2, cy-2), radius: 3, color: col("#c4843c"), opacity: 0.4 });
        }
    }

    // ─── Main draw loop ──────────────────────────────
    k.onDraw(() => {
        const dt = k.dt();
        time += dt;
        updateCrack(dt);

        // Slider drag — once per frame, not per mouse event
        if (settingsDragging && k.isMouseDown()) {
            const mp = k.mousePos();
            const _W = k.width();
            const _pad = 14;
            const _usW = _W - 38 * 2 - _pad * 2;
            const _secW = Math.min(580, _usW * 0.85);
            const _slW = _secW - 40;
            const _lx = _W / 2 - _slW / 2;
            settingsData[settingsDragging] = Math.max(0, Math.min(1, (mp.x - _lx) / _slW));
        }

        const W = k.width();
        const H = k.height();
        const FW = 38;
        const contentH = H - FW * 2;

        // Scroll distance — extra padding so the animation feels longer
        scrollDist = contentH + H * 0.4;

        // If returning from game, start already at level select
        if (needsInitScroll) {
            needsInitScroll = false;
            scrollY = scrollDist;
            scrollTarget = scrollDist;
        }

        // Smooth scroll towards target
        if (Math.abs(scrollY - scrollTarget) > 0.5) {
            scrollY += (scrollTarget - scrollY) * Math.min(1, dt * 4);
        } else {
            scrollY = scrollTarget;
        }
        // Update current view state
        if (scrollY > scrollDist * 0.5) currentView = "levelSelect";
        else if (scrollY < -scrollDist * 0.5) currentView = "settings";
        else currentView = "menu";

        // Arm the level-select cascade once the pan-up is mostly there so the
        // cards start animating just before the scroll fully lands — feels
        // snappy instead of a hold-then-pop. `lsWasIn` doubles as the
        // "revealed" flag: cards stay hidden until it flips true.
        const lsSettled = currentView === "levelSelect"
            && scrollTarget === scrollDist
            && scrollY >= scrollDist * 0.92;
        if (lsSettled && !lsWasIn) {
            lsAnimStart = k.time();
            lsWasIn = true;
        }
        // Re-arm whenever we leave the level-select target so the next visit
        // replays the animation.
        if (currentView !== "levelSelect" && scrollTarget !== scrollDist) {
            lsWasIn = false;
            lsAnimStart = -1;
        }

        // Smooth toward open/closed for the leaderboard slide animation
        const lbTarget = lbOpen ? 1 : 0;
        lbAnimT += (lbTarget - lbAnimT) * Math.min(1, dt * 4.5);
        if (Math.abs(lbAnimT - lbTarget) < 0.005) lbAnimT = lbTarget;
        // If the player leaves level-select with the panel open, snap shut so
        // re-entering doesn't show a half-open panel
        if (currentView !== "levelSelect" && lbOpen) { lbOpen = false; lbAnimT = 0; }

        // Settings message timer
        if (settingsMsgTimer > 0) { settingsMsgTimer -= dt; if (settingsMsgTimer <= 0) settingsMessage = null; }

        const sy = scrollY;

        // Background — warm paper (full screen, doesn't slide)
        k.drawRect({ width: W, height: H, pos: k.vec2(0, 0), color: col("#d4b878"), anchor: "topleft" });

        // Moving graph paper grid (covers both menu + level select areas)
        const gridSpd = 18;
        const gOff = (time * gridSpd) % 20;
        const gOffMaj = (time * gridSpd) % 100;
        const gridTop = -scrollDist;  // level select area starts above

        for (let gx = -20 + (gOff % 20); gx < W + 20; gx += 20)
            k.drawLine({ p1: k.vec2(gx, gridTop), p2: k.vec2(gx, H), width: 0.5, color: col("#b8a060"), opacity: 0.2 });
        for (let gy = gridTop - 20 + (gOff % 20); gy < H + 20; gy += 20)
            k.drawLine({ p1: k.vec2(0, gy), p2: k.vec2(W, gy), width: 0.5, color: col("#b8a060"), opacity: 0.2 });
        for (let gx = -100 + (gOffMaj % 100); gx < W + 100; gx += 100)
            k.drawLine({ p1: k.vec2(gx, gridTop), p2: k.vec2(gx, H), width: 1, color: col("#a89050"), opacity: 0.18 });
        for (let gy = gridTop - 100 + (gOffMaj % 100); gy < H + 100; gy += 100)
            k.drawLine({ p1: k.vec2(0, gy), p2: k.vec2(W, gy), width: 1, color: col("#a89050"), opacity: 0.18 });

        // Engineering doodles (spread across both views)
        updateDoodles(dt);
        for (const d of doodles) {
            // Draw doodles in both the menu area and level select area
            const origFy = d.fy;
            // Menu-area instance (offset by sy)
            d.fy = (d.fy * H + sy) / H;
            drawDoodle(d, W, H);
            // Level-select-area instance (offset by sy - contentH)
            d.fy = (origFy * H + sy - scrollDist) / H;
            drawDoodle(d, W, H);
            d.fy = origFy;
        }

        // Masking tape (slides)
        function drawTape(x, y, w, h, angle) {
            const cos = Math.cos(angle), sin = Math.sin(angle);
            const hw = w/2, hh = h/2;
            const pts = [
                k.vec2(x + (-hw*cos - -hh*sin), y + (-hw*sin + -hh*cos)),
                k.vec2(x + ( hw*cos - -hh*sin), y + ( hw*sin + -hh*cos)),
                k.vec2(x + ( hw*cos -  hh*sin), y + ( hw*sin +  hh*cos)),
                k.vec2(x + (-hw*cos -  hh*sin), y + (-hw*sin +  hh*cos)),
            ];
            k.drawTriangle({ p1: pts[0], p2: pts[1], p3: pts[2], color: col("#e8dca0"), opacity: 0.55 });
            k.drawTriangle({ p1: pts[0], p2: pts[2], p3: pts[3], color: col("#e8dca0"), opacity: 0.55 });
            k.drawLine({ p1: pts[0], p2: pts[1], width: 1.5, color: col("#c8b870"), opacity: 0.4 });
            k.drawLine({ p1: pts[3], p2: pts[2], width: 1.5, color: col("#c8b870"), opacity: 0.4 });
            for (let i = 1; i < 5; i++) {
                const t = i / 5;
                const gp1 = k.vec2(pts[0].x + (pts[1].x-pts[0].x)*t, pts[0].y + (pts[1].y-pts[0].y)*t);
                const gp2 = k.vec2(pts[3].x + (pts[2].x-pts[3].x)*t, pts[3].y + (pts[2].y-pts[3].y)*t);
                k.drawLine({ p1: gp1, p2: gp2, width: 0.5, color: col("#b8a860"), opacity: 0.2 });
            }
        }
        drawTape(W*0.25, FW*0.6 + sy,  90, 16,  0.18);
        drawTape(W*0.75, FW*0.6 + sy,  90, 16, -0.18);
        drawTape(W*0.25, H-FW*0.6 + sy, 90, 16, -0.12);
        drawTape(W*0.75, H-FW*0.6 + sy, 90, 16,  0.12);

        // Vignette (doesn't slide — ambient)
        const vEdge = 120;
        for (let i = 0; i < 8; i++) { const t = i/8; k.drawRect({ pos: k.vec2(0, 0), width: W, height: vEdge*(1-t), color: col("#1a0e05"), anchor: "topleft", opacity: 0.012 }); }
        for (let i = 0; i < 8; i++) { const t = i/8; k.drawRect({ pos: k.vec2(0, H), width: W, height: vEdge*(1-t), color: col("#1a0e05"), anchor: "botleft", opacity: 0.012 }); }
        for (let i = 0; i < 6; i++) { const t = i/6; k.drawRect({ pos: k.vec2(0, 0), width: vEdge*(1-t), height: H, color: col("#1a0e05"), anchor: "topleft", opacity: 0.010 }); }
        for (let i = 0; i < 6; i++) { const t = i/6; k.drawRect({ pos: k.vec2(W, 0), width: vEdge*(1-t), height: H, color: col("#1a0e05"), anchor: "topright", opacity: 0.010 }); }

        // Bridge decor — always slides down out of frame when leaving menu
        drawBridgeDecor(W, H, Math.abs(sy));

        // Confetti (slides)
        drawConfetti(W, H, dt, sy);

        // Buttons — fallen planks (slide with content)
        const btnW = Math.min(240, W * 0.34);
        const btnH = 40;
        const btnGap = 14;
        const btnX = W / 2;
        const btnStartY = H * 0.60 + sy;

        if (!crackAnim || crackAnim.btnIdx !== 0)
            drawPlankButton(btnX, btnStartY,                      btnW, btnH, "Start Game", hoverPlay, 0);
        if (!crackAnim || crackAnim.btnIdx !== 1)
            drawPlankButton(btnX, btnStartY + btnH + btnGap,      btnW, btnH, "Settings",   hoverSettings, 1);
        if (!crackAnim || crackAnim.btnIdx !== 2)
            drawPlankButton(btnX, btnStartY + (btnH + btnGap) * 2, btnW, btnH, "Credits",    hoverCredits, 2);

        // Crack animation
        drawCrack(W, H);

        // ── Level select content (wooden card grid) ──
        {
            const lsY = -scrollDist + sy;
            const lsFW = 38;
            const pad = 14;
            const topPad = 30;   // extra space from frame to title
            const usableW = W - lsFW * 2 - pad * 2;
            const usableH = contentH - pad * 2 - topPad;

            // Title — pixel art style
            const titleY = lsFW + pad + topPad + lsY;
            const titleSz = Math.min(28, W * 0.028);
            k.drawText({ text: "SELECT LEVEL", pos: k.vec2(W/2 + 2, titleY + 2), size: titleSz, font: "PressStart2P", color: col("#1a0e05"), anchor: "top", opacity: 0.25 });
            k.drawText({ text: "SELECT LEVEL", pos: k.vec2(W/2, titleY), size: titleSz, font: "PressStart2P", color: col("#4a2808"), anchor: "top" });

            // Wooden card grid — 4 cols × 2 rows = 8 cards.
            const SHOWN_LEVELS = 8;
            const cols = 4;
            const rows = 2;
            const topArea = titleSz + 28;
            const bottomArea = 60;
            const noteGap = 18;
            const noteW = Math.floor((usableW * 0.86 - (cols - 1) * noteGap) / cols);
            const noteH = Math.floor(((usableH - topArea - bottomArea) * 0.92 - (rows - 1) * noteGap) / rows);
            const gridW = cols * noteW + (cols - 1) * noteGap;
            const gridStartX = W / 2 - gridW / 2;
            const gridStartY = titleY + topArea;

            // Wood-stamped grade plaque colors — matches the win modal medallion.
            const gradeColors = { S: "#fbbf24", A: "#22c55e", B: "#60a5fa", C: "#f97316", F: "#ef4444" };

            // Compute grid layout once (reused by click handler).
            function noteLayout(i) {
                const r = Math.floor(i / cols);
                const c2 = i % cols;
                const cx = gridStartX + c2 * (noteW + noteGap) + noteW / 2;
                const cy = gridStartY + r * (noteH + noteGap) + noteH / 2;
                return { cx, cy, tilt: 0 };
            }

            // Wooden coin medallion — same look as the win-modal grade plaque.
            // `animT` is seconds since the stamp started; pass Infinity for
            // "already settled, just keep drawing the idle state".
            function drawCoin(cx, cy, r, letter, animT) {
                const t = k.time();
                const gradeCol = letter ? (gradeColors[letter] || "#ef4444") : null;
                if (animT == null) animT = Infinity;

                // Stamp phases — write (letter pops in) → circle (marker
                // strokes around) → idle (sparkles, shimmer).
                const writeDur = 0.45, circleDur = 0.6;
                const writeT  = Math.max(0, Math.min(1, animT / writeDur));
                const circleT = Math.max(0, Math.min(1, (animT - writeDur) / circleDur));
                const idleT   = Math.max(0, animT - writeDur - circleDur);

                const easeOutBack = (x) => {
                    if (x <= 0) return 0;
                    if (x >= 1) return 1;
                    const c1 = 1.70158, c3 = c1 + 1;
                    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
                };

                // S grade — soft gold halo behind the coin (kept subtle so it
                // doesn't wash out the bottom row).
                if (letter === "S" && idleT > 0) {
                    const haloR = r * 1.50 + Math.sin(t * 2) * 1.5;
                    k.drawCircle({
                        pos: k.vec2(cx, cy), radius: haloR,
                        color: col("#ffe17a"),
                        opacity: 0.12 + 0.06 * Math.sin(t * 3),
                    });
                }

                // Coin body + outline (always shown — the disc IS the badge,
                // even before the letter stamps in).
                k.drawCircle({ pos: k.vec2(cx, cy + 1.5), radius: r, color: col("#1a0e05"), opacity: 0.35 });
                k.drawCircle({ pos: k.vec2(cx, cy), radius: r, color: col(letter ? "#a35e22" : "#7a4416") });
                k.drawCircle({
                    pos: k.vec2(cx, cy - 1), radius: r - 1.5,
                    fill: false, outline: { width: 1, color: col(letter ? "#e89c4a" : "#9c6230") },
                    opacity: 0.5,
                });
                k.drawCircle({
                    pos: k.vec2(cx, cy), radius: r,
                    fill: false, outline: { width: 1.5, color: col("#3a2110") },
                    opacity: 0.7,
                });

                if (letter && animT > 0) {
                    // Letter — pops in with overshoot during the write phase,
                    // then settles with a tiny breathe.
                    const letterScale = writeT < 1 ? Math.max(0, easeOutBack(writeT)) : 1 + Math.sin(idleT * 2.4) * 0.025;
                    const sz = r * 1.05;
                    let drawColor = gradeCol;
                    if (letter === "S" && idleT > 0) {
                        // Shimmer between deep gold and bright highlight
                        const v = (Math.sin(t * 1.6) + 1) / 2;
                        const lerp = (a, b) => Math.round(a + (b - a) * v);
                        const rr = lerp(0xfb, 0xff), gg = lerp(0xbf, 0xe4), bb = lerp(0x24, 0x5a);
                        drawColor = "#" + [rr, gg, bb].map(c => c.toString(16).padStart(2, "0")).join("");
                    }

                    // PressStart2P glyphs are left-aligned in their cell with
                    // a baseline that's not at the cell's vertical center, so
                    // anchor:"center" centers the cell instead of the visible
                    // letter. Nudge into optical center.
                    const lxOff = sz * 0.06;
                    const lyOff = sz * 0.06;
                    k.pushTransform();
                    k.pushTranslate(cx + lxOff, cy + lyOff);
                    k.pushScale(letterScale, letterScale);
                    k.drawText({ text: letter, pos: k.vec2(1.4, 1.6), size: sz, font: "PressStart2P", color: col("#1a0e05"), opacity: 0.45, anchor: "center" });
                    k.drawText({ text: letter, pos: k.vec2(0, 0),     size: sz, font: "PressStart2P", color: col(drawColor), anchor: "center" });
                    k.popTransform();

                    // Marker circle — strokes around the coin clockwise during
                    // the circle phase, full ring once it finishes.
                    if (circleT > 0) {
                        const markerR = r + 4;
                        const segs = 40;
                        const maxA = -Math.PI / 2 + circleT * Math.PI * 2;
                        for (let si = 0; si < segs; si++) {
                            const a0 = -Math.PI / 2 + (si / segs) * Math.PI * 2;
                            if (a0 >= maxA) break;
                            const a1 = Math.min(-Math.PI / 2 + ((si + 1) / segs) * Math.PI * 2, maxA);
                            k.drawLine({
                                p1: k.vec2(cx + Math.cos(a0) * markerR, cy + Math.sin(a0) * markerR),
                                p2: k.vec2(cx + Math.cos(a1) * markerR, cy + Math.sin(a1) * markerR),
                                width: 2.2, color: col(gradeCol),
                            });
                        }
                    }

                    // S grade — orbiting sparkles (bigger, brighter — user
                    // wanted them more prominent).
                    if (letter === "S" && idleT > 0) {
                        for (let i = 0; i < 4; i++) {
                            const angle = idleT * 0.8 + i * (Math.PI / 2);
                            const dist = r * 1.32 + Math.sin(idleT * 1.8 + i) * 2;
                            const sx = cx + Math.cos(angle) * dist;
                            const sy = cy + Math.sin(angle) * dist;
                            const spk = 4.2 + Math.sin(idleT * 3 + i * 0.7) * 1.6;
                            k.drawCircle({ pos: k.vec2(sx, sy), radius: spk, color: col("#ffe17a"), opacity: 0.95 });
                            k.drawLine({ p1: k.vec2(sx - spk - 4, sy), p2: k.vec2(sx + spk + 4, sy), width: 1.6, color: col("#fff7c4"), opacity: 0.95 });
                            k.drawLine({ p1: k.vec2(sx, sy - spk - 4), p2: k.vec2(sx, sy + spk + 4), width: 1.6, color: col("#fff7c4"), opacity: 0.95 });
                        }
                    }
                }
            }

            function drawGimmickIcon(gimmick, cx, cy, sz, op) {
                const ic = "#4a2808";
                if (gimmick === "road") {
                    // Simple flat road
                    k.drawLine({ p1: k.vec2(cx - sz, cy), p2: k.vec2(cx + sz, cy), width: 2.5, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx - sz*0.6, cy + 2), p2: k.vec2(cx + sz*0.6, cy + 2), width: 1, color: col(ic), opacity: op * 0.5 });
                } else if (gimmick === "triangle") {
                    // Triangle shape
                    k.drawLine({ p1: k.vec2(cx - sz, cy + sz*0.6), p2: k.vec2(cx + sz, cy + sz*0.6), width: 2, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx - sz, cy + sz*0.6), p2: k.vec2(cx, cy - sz*0.6), width: 2, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx + sz, cy + sz*0.6), p2: k.vec2(cx, cy - sz*0.6), width: 2, color: col(ic), opacity: op });
                } else if (gimmick === "wide") {
                    // Long span arrows
                    k.drawLine({ p1: k.vec2(cx - sz*1.2, cy), p2: k.vec2(cx + sz*1.2, cy), width: 1.5, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx - sz*1.2, cy), p2: k.vec2(cx - sz*0.7, cy - 3), width: 1.5, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx - sz*1.2, cy), p2: k.vec2(cx - sz*0.7, cy + 3), width: 1.5, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx + sz*1.2, cy), p2: k.vec2(cx + sz*0.7, cy - 3), width: 1.5, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx + sz*1.2, cy), p2: k.vec2(cx + sz*0.7, cy + 3), width: 1.5, color: col(ic), opacity: op });
                } else if (gimmick === "slope") {
                    // Sloped line
                    k.drawLine({ p1: k.vec2(cx - sz, cy - sz*0.4), p2: k.vec2(cx + sz, cy + sz*0.4), width: 2, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx - sz, cy - sz*0.4), p2: k.vec2(cx - sz, cy + sz*0.5), width: 1.5, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx + sz, cy + sz*0.4), p2: k.vec2(cx + sz, cy + sz*0.5), width: 1.5, color: col(ic), opacity: op });
                } else if (gimmick === "steel") {
                    // Steel I-beam cross section
                    k.drawLine({ p1: k.vec2(cx - sz*0.6, cy - sz*0.5), p2: k.vec2(cx + sz*0.6, cy - sz*0.5), width: 2.5, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx - sz*0.6, cy + sz*0.5), p2: k.vec2(cx + sz*0.6, cy + sz*0.5), width: 2.5, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx, cy - sz*0.5), p2: k.vec2(cx, cy + sz*0.5), width: 2, color: col(ic), opacity: op });
                } else if (gimmick === "cable") {
                    // Cable drooping from two high points
                    const segs = 6;
                    for (let s = 0; s < segs; s++) {
                        const t1 = s / segs, t2 = (s + 1) / segs;
                        const x1 = cx - sz + t1 * sz * 2, x2 = cx - sz + t2 * sz * 2;
                        const sag1 = Math.sin(t1 * Math.PI) * sz * 0.5;
                        const sag2 = Math.sin(t2 * Math.PI) * sz * 0.5;
                        k.drawLine({ p1: k.vec2(x1, cy - sz*0.4 + sag1), p2: k.vec2(x2, cy - sz*0.4 + sag2), width: 1.5, color: col(ic), opacity: op });
                    }
                    // Towers
                    k.drawLine({ p1: k.vec2(cx - sz, cy + sz*0.4), p2: k.vec2(cx - sz, cy - sz*0.4), width: 2, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx + sz, cy + sz*0.4), p2: k.vec2(cx + sz, cy - sz*0.4), width: 2, color: col(ic), opacity: op });
                } else if (gimmick === "pier") {
                    // Vertical piers from below
                    k.drawLine({ p1: k.vec2(cx - sz, cy - sz*0.3), p2: k.vec2(cx + sz, cy - sz*0.3), width: 2, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx - sz*0.4, cy - sz*0.3), p2: k.vec2(cx - sz*0.4, cy + sz*0.6), width: 2, color: col(ic), opacity: op });
                    k.drawLine({ p1: k.vec2(cx + sz*0.4, cy - sz*0.3), p2: k.vec2(cx + sz*0.4, cy + sz*0.6), width: 2, color: col(ic), opacity: op });
                } else if (gimmick === "heavy") {
                    // Heavy weight symbol
                    k.drawRect({ width: sz*1.2, height: sz*0.8, pos: k.vec2(cx, cy), color: col(ic), anchor: "center", opacity: op });
                    k.drawText({ text: "KG", pos: k.vec2(cx, cy), size: sz*0.4, font: "PressStart2P", color: col("#fff8ee"), anchor: "center", opacity: op });
                } else if (gimmick === "multi") {
                    // Multiple small cars
                    for (let v = 0; v < 2; v++) {
                        const vx = cx - sz*0.5 + v * sz;
                        k.drawRect({ width: sz*0.7, height: sz*0.35, pos: k.vec2(vx, cy), color: col(ic), anchor: "center", opacity: op, radius: 2 });
                        k.drawCircle({ pos: k.vec2(vx - sz*0.2, cy + sz*0.22), radius: sz*0.12, color: col(ic), opacity: op });
                        k.drawCircle({ pos: k.vec2(vx + sz*0.2, cy + sz*0.22), radius: sz*0.12, color: col(ic), opacity: op });
                    }
                } else if (gimmick === "budget") {
                    // Dollar sign
                    k.drawText({ text: "$", pos: k.vec2(cx, cy), size: sz*1.2, font: "PressStart2P", color: col(ic), anchor: "center", opacity: op });
                }
            }

            const totalToShow = Math.min(SHOWN_LEVELS, LEVELS.length);
            const mp = k.mousePos();
            const tNow = k.time();
            // easeOutBack — card pops in with a tiny overshoot
            const easeOutBack = (x) => {
                if (x <= 0) return 0;
                if (x >= 1) return 1;
                const c1 = 1.70158, c3 = c1 + 1;
                return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
            };
            for (let i = 0; i < totalToShow; i++) {
                const { cx, cy } = noteLayout(i);
                const unlocked = isUnlocked(i);
                const grade = getGrade(i);
                const lvl = LEVELS[i];

                // Cascade-in animation — staggered by index, eases out with a
                // small overshoot. After settling, an idle bob keeps the cards
                // breathing slightly.
                const cascadeDur = 0.45;
                const stagger = 0.07;
                // While the screen pans up (lsWasIn=false), keep cards fully
                // invisible. Once revealed, run the staggered cascade. After
                // the cascade plays out, introT just sits at 1.
                const localT = !lsWasIn ? -1 : (tNow - lsAnimStart - i * stagger) / cascadeDur;
                const introT = Math.max(0, Math.min(1, localT));
                const introScale = easeOutBack(introT);
                const introOp = Math.min(1, Math.max(0, localT));
                const introDrop = (1 - introT) * 24;       // px, comes in from above

                const hovered = unlocked && introT >= 1
                    && Math.abs(mp.x - cx) < noteW / 2
                    && Math.abs(mp.y - cy) < noteH / 2;

                // Idle bob — every card breathes lightly out of phase
                const idle = introT >= 1
                    ? Math.sin(tNow * 1.4 + i * 0.7) * 0.7
                    : 0;
                const lift = (hovered ? 4 : 0) + idle;
                const hoverScale = hovered ? 1.04 : 1;
                const scale = introScale * hoverScale;

                k.pushTransform();
                k.pushTranslate(cx, cy - lift - introDrop);
                k.pushScale(scale, scale);

                // Drop shadow
                k.drawRect({
                    width: noteW + 4, height: noteH + 4,
                    pos: k.vec2(3, 5),
                    color: col("#1a0e05"),
                    anchor: "center", opacity: 0.30 * introOp, radius: 4,
                });

                if (unlocked) {
                    // Wooden border — slightly larger plate behind the body
                    k.drawRect({
                        width: noteW + 4, height: noteH + 4,
                        pos: k.vec2(0, 0),
                        color: col("#5a3210"),
                        anchor: "center", opacity: introOp, radius: 5,
                    });
                    // Main wooden body
                    k.drawRect({
                        width: noteW, height: noteH,
                        pos: k.vec2(0, 0),
                        color: col(hovered ? "#e08e4d" : "#d37e3d"),
                        anchor: "center", opacity: introOp, radius: 4,
                    });
                    // Top highlight stripe
                    k.drawRect({
                        width: noteW - 8, height: 4,
                        pos: k.vec2(0, -noteH/2 + 5),
                        color: col("#e0b860"),
                        anchor: "center", opacity: 0.45 * introOp, radius: 2,
                    });
                    // Wood grain — a few horizontal hairlines
                    for (let g = 0; g < 3; g++) {
                        const gy = -noteH/2 + noteH * (0.28 + g * 0.22);
                        k.drawLine({
                            p1: k.vec2(-noteW/2 + 8, gy),
                            p2: k.vec2( noteW/2 - 8, gy),
                            width: 1, color: col("#7a4416"), opacity: 0.16 * introOp,
                        });
                    }

                    // Random scars + nail holes — seeded per level index so
                    // each card has consistent, unique roughness across
                    // sessions. Same approach as the win/fail modal planks.
                    {
                        let s = ((i + 1) * 0x9E3779B1) >>> 0 || 1;
                        const rand = () => {
                            s = (s * 1664525 + 1013904223) >>> 0;
                            return s / 0xFFFFFFFF;
                        };
                        // Knot — about half the cards get one
                        if (rand() > 0.4) {
                            const kx = -noteW * 0.5 + noteW * (0.15 + rand() * 0.7);
                            const ky = -noteH * 0.5 + noteH * (0.15 + rand() * 0.7);
                            // Skip if it would land on the centered coin
                            if (Math.hypot(kx, ky + noteH * 0.10) > noteW * 0.22) {
                                k.drawCircle({ pos: k.vec2(kx, ky), radius: 5, color: col("#7d4519"), opacity: 0.5 * introOp });
                                k.drawCircle({ pos: k.vec2(kx, ky), radius: 3, color: col("#5e351a"), opacity: 0.55 * introOp });
                                k.drawCircle({ pos: k.vec2(kx, ky), radius: 5, fill: false, outline: { width: 0.8, color: col("#3a2110") }, opacity: 0.45 * introOp });
                            }
                        }
                        // Scars — 2 to 4 per card, varying length and tilt
                        const scarCount = 2 + Math.floor(rand() * 3);
                        for (let sc = 0; sc < scarCount; sc++) {
                            const sx = -noteW/2 + noteW * (0.05 + rand() * 0.85);
                            const sy = -noteH/2 + noteH * (0.12 + rand() * 0.78);
                            // Avoid the coin region (within ~0.22 of center horizontally
                            // and the upper half of the card vertically)
                            if (Math.abs(sx) < noteW * 0.20 && Math.abs(sy + noteH * 0.10) < noteH * 0.22) continue;
                            const slen = 14 + rand() * 32;
                            const tilt = (rand() - 0.5) * 1.5;
                            k.drawLine({
                                p1: k.vec2(sx, sy),
                                p2: k.vec2(sx + slen, sy + tilt),
                                width: 1.1, color: col("#3a2110"), opacity: (0.55 + rand() * 0.2) * introOp,
                            });
                            k.drawLine({
                                p1: k.vec2(sx, sy + 1.2),
                                p2: k.vec2(sx + slen * (0.4 + rand() * 0.5), sy + 1.2 + tilt * 0.7),
                                width: 0.6, color: col("#5e351a"), opacity: 0.4 * introOp,
                            });
                        }
                        // Nail holes — 1 to 3 small dark dots
                        const nailCount = 1 + Math.floor(rand() * 3);
                        for (let n = 0; n < nailCount; n++) {
                            const nx = -noteW/2 + noteW * (0.05 + rand() * 0.9);
                            const ny = -noteH/2 + noteH * (0.12 + rand() * 0.78);
                            if (Math.abs(nx) < noteW * 0.20 && Math.abs(ny + noteH * 0.10) < noteH * 0.22) continue;
                            const nr = 1.4 + rand() * 0.9;
                            k.drawCircle({ pos: k.vec2(nx, ny), radius: nr + 0.5, color: col("#7d4519"), opacity: 0.5 * introOp });
                            k.drawCircle({ pos: k.vec2(nx, ny), radius: nr,       color: col("#1a0e05"), opacity: 0.75 * introOp });
                            k.drawCircle({ pos: k.vec2(nx - nr * 0.4, ny - nr * 0.4), radius: 0.5, color: col("#e0b860"), opacity: 0.4 * introOp });
                        }
                    }

                    // Inner outline
                    k.drawRect({
                        width: noteW, height: noteH,
                        pos: k.vec2(0, 0),
                        fill: false, outline: { width: 1.5, color: col("#3a1f08") },
                        anchor: "center", opacity: 0.55 * introOp, radius: 4,
                    });

                    // Level number — top-left, larger stamped pixel font with
                    // a tiny vertical bob so it feels alive.
                    const numSz = Math.min(20, noteW * 0.14);
                    const numBob = introT >= 1 ? Math.sin(tNow * 2.1 + i) * 0.8 : 0;
                    k.drawText({
                        text: (i + 1) + "",
                        pos: k.vec2(-noteW/2 + 12, -noteH/2 + 12 + numBob + 2),
                        size: numSz, font: "PressStart2P",
                        color: col("#1a0e05"), opacity: 0.45 * introOp, anchor: "topleft",
                    });
                    k.drawText({
                        text: (i + 1) + "",
                        pos: k.vec2(-noteW/2 + 11, -noteH/2 + 11 + numBob),
                        size: numSz, font: "PressStart2P",
                        color: col("#fff1a0"), opacity: introOp, anchor: "topleft",
                    });

                    // Center wooden coin — pulses in size on hover. The grade
                    // is "stamped" in after the card cascade settles, with a
                    // small extra delay so the cards land before the marker
                    // strokes around them.
                    const coinBaseR = Math.min(noteW, noteH) * 0.21;
                    const coinR = coinBaseR * (hovered ? 1.06 + 0.02 * Math.sin(tNow * 4) : 1);
                    const stampDelay = cascadeDur + 0.15;
                    const stampLocalT = !lsWasIn
                        ? -1
                        : (tNow - lsAnimStart - i * stagger - stampDelay);
                    drawCoin(0, -noteH * 0.10, coinR, grade || null, stampLocalT);

                    // Level name — bottom-center, hand-drawn font (no width
                    // wrap so anchor:center actually centers the string).
                    const nameSz = Math.min(20, noteW * 0.12);
                    k.drawText({
                        text: lvl.name,
                        pos: k.vec2(1, noteH * 0.36 + 2),
                        size: nameSz, font: "PatrickHand",
                        color: col("#1a0e05"), opacity: 0.4 * introOp, anchor: "center",
                    });
                    k.drawText({
                        text: lvl.name,
                        pos: k.vec2(0, noteH * 0.36),
                        size: nameSz, font: "PatrickHand",
                        color: col("#fff1a0"), opacity: introOp, anchor: "center",
                    });
                } else {
                    // LOCKED — dimmer, weathered wood (still inside the
                    // pushTransform, so all coords are relative to the card)
                    k.drawRect({
                        width: noteW + 4, height: noteH + 4,
                        pos: k.vec2(0, 0),
                        color: col("#3a2810"),
                        anchor: "center", radius: 5, opacity: 0.85 * introOp,
                    });
                    k.drawRect({
                        width: noteW, height: noteH,
                        pos: k.vec2(0, 0),
                        color: col("#7a5a3a"),
                        anchor: "center", radius: 4, opacity: 0.75 * introOp,
                    });
                    k.drawRect({
                        width: noteW, height: noteH,
                        pos: k.vec2(0, 0),
                        fill: false, outline: { width: 1.5, color: col("#3a2110") },
                        anchor: "center", opacity: 0.5 * introOp, radius: 4,
                    });

                    // Pixel lock icon (centered)
                    k.drawRect({ width: 18, height: 14, pos: k.vec2(0,  4), color: col("#3a2110"), anchor: "center", opacity: 0.7 * introOp });
                    k.drawRect({ width: 14, height:  4, pos: k.vec2(0, -6), color: col("#3a2110"), anchor: "center", opacity: 0.7 * introOp });
                    k.drawRect({ width:  4, height:  9, pos: k.vec2(-5, -2), color: col("#3a2110"), anchor: "center", opacity: 0.7 * introOp });
                    k.drawRect({ width:  4, height:  9, pos: k.vec2( 5, -2), color: col("#3a2110"), anchor: "center", opacity: 0.7 * introOp });
                    k.drawRect({ width:  4, height:  4, pos: k.vec2(0,  4), color: col("#5a3a1a"), anchor: "center", opacity: 0.8 * introOp });

                    // Level number — top-left, larger
                    k.drawText({
                        text: (i + 1) + "",
                        pos: k.vec2(-noteW/2 + 11, -noteH/2 + 11),
                        size: Math.min(20, noteW * 0.14), font: "PressStart2P",
                        color: col("#3a2110"), opacity: 0.5 * introOp, anchor: "topleft",
                    });
                }

                k.popTransform();
            }

            // Footer buttons — HOME (left) and LEADERBOARD (right). Both stay
            // pinned in place; the panel itself is what slides in.
            const homeY = gridStartY + rows * (noteH + noteGap) + 36;
            const homeBtnX = W / 2 - 100;
            const lbBtnX   = W / 2 + 100;
            // easeInOutCubic so the slide feels weighty
            const easeInOutCubic = (x) => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
            const slideE = easeInOutCubic(lbAnimT);
            const mp2 = k.mousePos();
            const homeHover = Math.abs(mp2.x - homeBtnX) < 70 && Math.abs(mp2.y - homeY) < 18;
            const lbHover   = lbAnimT < 0.05
                && Math.abs(mp2.x - lbBtnX) < 90 && Math.abs(mp2.y - homeY) < 18;
            drawPlankButton(homeBtnX, homeY, 130, 30, "< HOME",      homeHover, 0);
            drawPlankButton(lbBtnX,   homeY, 170, 30, "LEADERBOARD", lbHover,   1);

            // ─── Leaderboard slide-in panel ───────────────────────
            if (lbAnimT > 0.005) {
                // Build the list of unlocked levels (locked ones are hidden).
                const unlockedLevels = [];
                const totalAvail = Math.min(8, LEVELS.length);
                for (let i = 0; i < totalAvail; i++) {
                    if (isUnlocked(i)) unlockedLevels.push(i);
                }

                // Panel sized large — covers most of the screen, slides in from
                // the right. Width matches the grid area so it feels grounded.
                const panelW = Math.min(W * 0.72, 880);
                const panelH = Math.min(H * 0.78, 600);
                const panelTargetX = W / 2 - panelW / 2;
                const panelY       = H / 2 - panelH / 2;
                const panelStartX  = W + 60;
                const panelX = panelStartX + (panelTargetX - panelStartX) * slideE;

                // Backdrop dim — fades up with the slide
                k.drawRect({ width: W, height: H, pos: k.vec2(0, 0), color: col("#1a0e05"), opacity: 0.55 * lbAnimT, anchor: "topleft" });

                // Wood backing
                k.drawRect({ width: panelW + 10, height: panelH + 10, pos: k.vec2(panelX + 4, panelY + 6), color: col("#1a0e05"), opacity: 0.5, anchor: "topleft", radius: 6 });
                k.drawRect({ width: panelW + 6,  height: panelH + 6,  pos: k.vec2(panelX - 3, panelY - 3), color: col("#5a3210"), anchor: "topleft", radius: 6 });
                k.drawRect({ width: panelW,      height: panelH,      pos: k.vec2(panelX,     panelY),     color: col("#d37e3d"), anchor: "topleft", radius: 5 });
                // Top highlight
                k.drawRect({ width: panelW - 16, height: 4, pos: k.vec2(panelX + 8, panelY + 6), color: col("#e0b860"), opacity: 0.45, anchor: "topleft", radius: 2 });
                // Wood grain hairlines
                for (let g = 0; g < 10; g++) {
                    const gy = panelY + 28 + g * (panelH - 56) / 10;
                    k.drawLine({ p1: k.vec2(panelX + 14, gy), p2: k.vec2(panelX + panelW - 14, gy), width: 1, color: col("#7a4416"), opacity: 0.14 });
                }
                // Seeded scars/nail-holes for that worn-wood feel (matches cards)
                {
                    let s = 0xA17F00B5 >>> 0;
                    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xFFFFFFFF; };
                    for (let n = 0; n < 6; n++) {
                        const sx = panelX + 20 + rnd() * (panelW - 40);
                        const sy = panelY + 16 + rnd() * (panelH - 32);
                        const slen = 16 + rnd() * 36;
                        const tilt = (rnd() - 0.5) * 1.3;
                        k.drawLine({ p1: k.vec2(sx, sy), p2: k.vec2(sx + slen, sy + tilt), width: 1.1, color: col("#3a2110"), opacity: 0.55 });
                    }
                    for (let n = 0; n < 5; n++) {
                        const nx = panelX + 30 + rnd() * (panelW - 60);
                        const ny = panelY + 24 + rnd() * (panelH - 48);
                        const nr = 1.6 + rnd() * 1.0;
                        k.drawCircle({ pos: k.vec2(nx, ny), radius: nr + 0.5, color: col("#7d4519"), opacity: 0.5 });
                        k.drawCircle({ pos: k.vec2(nx, ny), radius: nr, color: col("#1a0e05"), opacity: 0.7 });
                    }
                }
                // Inner outline
                k.drawRect({ width: panelW, height: panelH, pos: k.vec2(panelX, panelY), fill: false, outline: { width: 1.5, color: col("#3a1f08") }, opacity: 0.55, anchor: "topleft", radius: 5 });

                const cxP = panelX + panelW / 2;

                // Title
                const titleSz2 = 28;
                k.drawText({ text: "LEADERBOARDS", pos: k.vec2(cxP + 1.5, panelY + 22 + 1.5), size: titleSz2, font: "PressStart2P", color: col("#1a0e05"), opacity: 0.45, anchor: "top" });
                k.drawText({ text: "LEADERBOARDS", pos: k.vec2(cxP,       panelY + 22),       size: titleSz2, font: "PressStart2P", color: col("#fff1a0"), anchor: "top" });

                // Level tabs — only unlocked levels
                const tabRowY = panelY + 76;
                const tabSz = 36;
                const tabGap = 8;
                const tabRowW = unlockedLevels.length * tabSz + Math.max(0, unlockedLevels.length - 1) * tabGap;
                const tabStartX = cxP - tabRowW / 2;
                for (let k2 = 0; k2 < unlockedLevels.length; k2++) {
                    const lvIdx = unlockedLevels[k2];
                    const tx = tabStartX + k2 * (tabSz + tabGap) + tabSz / 2;
                    const ty = tabRowY + tabSz / 2;
                    const active = lvIdx === lbLevel;
                    const tabHover = !active
                        && lbAnimT > 0.95
                        && Math.abs(mp2.x - tx) < tabSz / 2
                        && Math.abs(mp2.y - ty) < tabSz / 2;
                    const tabCol = active ? "#fff1a0" : tabHover ? "#e0b860" : "#a35e22";
                    k.drawRect({ width: tabSz, height: tabSz, pos: k.vec2(tx, ty + 2), color: col("#1a0e05"), opacity: 0.4, anchor: "center", radius: 4 });
                    k.drawRect({ width: tabSz, height: tabSz, pos: k.vec2(tx, ty), color: col(tabCol), anchor: "center", radius: 4 });
                    k.drawRect({ width: tabSz, height: tabSz, pos: k.vec2(tx, ty), fill: false, outline: { width: 1.5, color: col("#3a1f08") }, anchor: "center", opacity: 0.6, radius: 4 });
                    k.drawText({
                        text: (lvIdx + 1) + "",
                        pos: k.vec2(tx, ty),
                        size: 16, font: "PressStart2P",
                        color: col(active ? "#3a1f08" : "#fff1a0"),
                        anchor: "center",
                    });
                }

                // Selected level name
                const lvl = LEVELS[lbLevel];
                const subY = tabRowY + tabSz + 28;
                if (lvl) {
                    k.drawText({ text: lvl.name, pos: k.vec2(cxP, subY), size: 22, font: "PatrickHand", color: col("#fff1a0"), anchor: "top" });
                }

                // Body — table on the left, percentile callout on the right
                const bodyY = subY + 40;
                const tableX = panelX + 60;
                const tableW = panelW * 0.62;
                const sideX  = panelX + 60 + tableW + 20;
                const sideW  = panelW - tableW - 80 - 60 + 20;

                const completed = !!getGrade(lbLevel);
                const ready = lbData != null && lbLoadingFor === lbLevel && !lbData.error;

                if (lbData == null || lbLoadingFor !== lbLevel) {
                    k.drawText({ text: "Loading…", pos: k.vec2(cxP, bodyY + 80), size: 20, font: "PatrickHand", color: col("#fff1a0"), opacity: 0.7, anchor: "center" });
                } else if (lbData.error) {
                    k.drawText({ text: "Couldn't load leaderboard.", pos: k.vec2(cxP, bodyY + 80), size: 18, font: "PatrickHand", color: col("#fff1a0"), opacity: 0.7, anchor: "center" });
                } else {
                    // Table headers
                    k.drawText({ text: "RANK",   pos: k.vec2(tableX,           bodyY), size: 12, font: "PressStart2P", color: col("#fff1a0"), opacity: 0.7, anchor: "topleft" });
                    k.drawText({ text: "NAME",   pos: k.vec2(tableX + 80,      bodyY), size: 12, font: "PressStart2P", color: col("#fff1a0"), opacity: 0.7, anchor: "topleft" });
                    k.drawText({ text: "BUDGET", pos: k.vec2(tableX + tableW,  bodyY), size: 12, font: "PressStart2P", color: col("#fff1a0"), opacity: 0.7, anchor: "topright" });
                    k.drawLine({ p1: k.vec2(tableX, bodyY + 22), p2: k.vec2(tableX + tableW, bodyY + 22), width: 1, color: col("#3a1f08"), opacity: 0.45 });

                    // Top 10 entries (now with more vertical room)
                    const rowH = 26;
                    const showCount = Math.min(10, lbData.top ? lbData.top.length : 0);
                    // The leaderboard module returns top 5 — re-derive top 10
                    // by rebuilding from the synthetic+user pool. Module
                    // already sorted; we just slice deeper.
                    const allEntries = lbData._all || lbData.top.slice();
                    const slice = allEntries.slice(0, 10).length ? allEntries.slice(0, 10) : lbData.top.slice(0, 5);
                    const tNow2 = k.time();
                    for (let r = 0; r < slice.length; r++) {
                        const e = slice[r];
                        const ry = bodyY + 32 + r * rowH;
                        if (e.isYou) {
                            k.drawRect({ width: tableW + 12, height: rowH - 2, pos: k.vec2(tableX - 6, ry - 4), color: col("#fbbf24"), opacity: 0.22, anchor: "topleft", radius: 3 });
                        }

                        // ── Top 3: medal badge + glow + shadow on the rank ──
                        if (r < 3) {
                            const medalCol  = r === 0 ? "#fbbf24" : r === 1 ? "#e4e4ef" : "#e89455";
                            const medalRim  = r === 0 ? "#a36a08" : r === 1 ? "#7a7a85" : "#7a3a10";
                            const haloCol   = r === 0 ? "#ffe17a" : r === 1 ? "#f4f4ff" : "#ffb878";
                            // 1st pulses brightest, 2nd softer, 3rd subtler
                            const pulseRate = r === 0 ? 2.4 : r === 1 ? 1.8 : 1.4;
                            const pulse = (Math.sin(tNow2 * pulseRate + r) + 1) / 2;
                            const haloOp = (r === 0 ? 0.45 : r === 1 ? 0.30 : 0.25) * (0.7 + 0.3 * pulse);
                            const haloR  = (r === 0 ? 16 : r === 1 ? 14 : 13) + pulse * 1.5;

                            // Center the medal where the "#N" text would sit
                            // for the lower ranks so the column lines up.
                            const medalCx = tableX + 7;
                            const medalCy = ry + 9;

                            // Glow halo behind the medal
                            k.drawCircle({ pos: k.vec2(medalCx, medalCy), radius: haloR, color: col(haloCol), opacity: haloOp });
                            // Medal disc — drop shadow + body + rim + inner highlight
                            k.drawCircle({ pos: k.vec2(medalCx + 1, medalCy + 1.5), radius: 11, color: col("#1a0e05"), opacity: 0.4 });
                            k.drawCircle({ pos: k.vec2(medalCx, medalCy), radius: 11, color: col(medalCol) });
                            k.drawCircle({ pos: k.vec2(medalCx, medalCy), radius: 11, fill: false, outline: { width: 1.5, color: col(medalRim) }, opacity: 0.85 });
                            // Tiny shimmer highlight on the disc
                            k.drawCircle({ pos: k.vec2(medalCx - 3, medalCy - 3), radius: 2, color: col("#ffffff"), opacity: 0.5 + 0.3 * pulse });

                            // Rank number — cream PatrickHand with a dark
                            // shadow + thin outline. The outline keeps the
                            // "2" readable against the light silver medal.
                            const numStr = (r + 1) + "";
                            // Drop shadow
                            k.drawText({ text: numStr, pos: k.vec2(medalCx + 1, medalCy + 2), size: 20, font: "PatrickHand", color: col("#1a0e05"), opacity: 0.55, anchor: "center" });
                            // Outline — 4 dark offsets
                            for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                                k.drawText({ text: numStr, pos: k.vec2(medalCx + ox, medalCy + 0.5 + oy), size: 20, font: "PatrickHand", color: col("#1a0e05"), opacity: 0.85, anchor: "center" });
                            }
                            // Cream fill on top
                            k.drawText({ text: numStr, pos: k.vec2(medalCx, medalCy + 0.5), size: 20, font: "PatrickHand", color: col("#fff8d8"), anchor: "center" });

                            // Sparkles only on #1 — orbits the medal in the
                            // same vocabulary as the S grade on a card.
                            if (r === 0) {
                                for (let s = 0; s < 3; s++) {
                                    const a = tNow2 * 1.4 + s * (Math.PI * 2 / 3);
                                    const sx = medalCx + Math.cos(a) * 16;
                                    const sy = medalCy + Math.sin(a) * 16;
                                    const sz = 1.4 + Math.sin(tNow2 * 4 + s) * 0.5;
                                    k.drawCircle({ pos: k.vec2(sx, sy), radius: sz, color: col("#fff7c4"), opacity: 0.85 });
                                }
                            }
                        } else {
                            k.drawText({ text: "#" + (r + 1), pos: k.vec2(tableX, ry), size: 16, font: "PatrickHand", color: col("#fff1a0"), anchor: "topleft" });
                        }

                        k.drawText({ text: e.playerName,       pos: k.vec2(tableX + 80,     ry), size: 16, font: "PatrickHand", color: col("#fff1a0"), anchor: "topleft" });
                        k.drawText({ text: "$" + e.budgetUsed, pos: k.vec2(tableX + tableW, ry), size: 16, font: "PatrickHand", color: col("#fff1a0"), anchor: "topright" });
                    }

                    // Player below the table if outside the displayed slice
                    if (lbData.userEntry && lbData.userRank && lbData.userRank > slice.length) {
                        const pry = bodyY + 32 + slice.length * rowH + 12;
                        k.drawLine({ p1: k.vec2(tableX, pry - 6), p2: k.vec2(tableX + tableW, pry - 6), width: 1, color: col("#3a1f08"), opacity: 0.4 });
                        k.drawRect({ width: tableW + 12, height: rowH - 2, pos: k.vec2(tableX - 6, pry - 2), color: col("#fbbf24"), opacity: 0.22, anchor: "topleft", radius: 3 });
                        k.drawText({ text: "#" + lbData.userRank,             pos: k.vec2(tableX,          pry + 2), size: 16, font: "PatrickHand", color: col("#fbbf24"), anchor: "topleft" });
                        k.drawText({ text: lbData.userEntry.playerName,       pos: k.vec2(tableX + 80,     pry + 2), size: 16, font: "PatrickHand", color: col("#fff1a0"), anchor: "topleft" });
                        k.drawText({ text: "$" + lbData.userEntry.budgetUsed, pos: k.vec2(tableX + tableW, pry + 2), size: 16, font: "PatrickHand", color: col("#fff1a0"), anchor: "topright" });
                    }

                    // ─── Right side panel — percentile / status callout ─
                    const sideCx = sideX + sideW / 2;
                    const sideTopY = bodyY;
                    // Plate behind the stat
                    k.drawRect({ width: sideW + 4, height: 220, pos: k.vec2(sideX - 2, sideTopY - 2), color: col("#5a3210"), anchor: "topleft", radius: 5 });
                    k.drawRect({ width: sideW,     height: 216, pos: k.vec2(sideX,     sideTopY),     color: col("#a35e22"), anchor: "topleft", radius: 4 });
                    k.drawRect({ width: sideW,     height: 216, pos: k.vec2(sideX,     sideTopY),     fill: false, outline: { width: 1.5, color: col("#3a1f08") }, opacity: 0.5, anchor: "topleft", radius: 4 });

                    if (!completed || !lbData.userEntry) {
                        // No personal best yet — completed flag tracks grade existence
                        k.drawText({ text: "YOUR RANK", pos: k.vec2(sideCx, sideTopY + 22), size: 12, font: "PressStart2P", color: col("#fff1a0"), opacity: 0.75, anchor: "top" });
                        k.drawText({ text: "—", pos: k.vec2(sideCx, sideTopY + 70), size: 56, font: "PressStart2P", color: col("#fff1a0"), opacity: 0.85, anchor: "top" });
                        const note = completed
                            ? "no run recorded"
                            : "complete the level to enter the field";
                        k.drawText({ text: note, pos: k.vec2(sideCx, sideTopY + 160), size: 14, font: "PatrickHand", color: col("#fff1a0"), opacity: 0.75, anchor: "top", width: sideW - 18 });
                    } else {
                        // Player has a run — big percentile + rank
                        const pct = lbData.userPercentile;
                        k.drawText({ text: "YOUR RANK", pos: k.vec2(sideCx, sideTopY + 18), size: 12, font: "PressStart2P", color: col("#fff1a0"), opacity: 0.8, anchor: "top" });
                        k.drawText({ text: "#" + lbData.userRank, pos: k.vec2(sideCx, sideTopY + 42), size: 26, font: "PressStart2P", color: col("#fff1a0"), anchor: "top" });
                        k.drawText({ text: "TOP", pos: k.vec2(sideCx, sideTopY + 92), size: 11, font: "PressStart2P", color: col("#fff1a0"), opacity: 0.75, anchor: "top" });
                        k.drawText({ text: (100 - pct + 1) + "%", pos: k.vec2(sideCx + 1.5, sideTopY + 110 + 1.5), size: 44, font: "PressStart2P", color: col("#1a0e05"), opacity: 0.4, anchor: "top" });
                        k.drawText({ text: (100 - pct + 1) + "%", pos: k.vec2(sideCx,       sideTopY + 110),       size: 44, font: "PressStart2P", color: col("#fbbf24"), anchor: "top" });
                        k.drawText({ text: "of " + lbData.totalPlayers + " players", pos: k.vec2(sideCx, sideTopY + 168), size: 14, font: "PatrickHand", color: col("#fff1a0"), opacity: 0.75, anchor: "top" });
                        k.drawText({ text: "$" + lbData.userEntry.budgetUsed + " budget", pos: k.vec2(sideCx, sideTopY + 188), size: 13, font: "PatrickHand", color: col("#fff1a0"), opacity: 0.7, anchor: "top" });
                    }
                }

                // Close button
                const closeY = panelY + panelH - 30;
                const closeHover = lbAnimT > 0.95
                    && Math.abs(mp2.x - cxP) < 60
                    && Math.abs(mp2.y - closeY) < 18;
                drawPlankButton(cxP, closeY, 120, 30, "CLOSE", closeHover, 2);
            }
        }

        // ── Settings content (below menu, scrolls into view going down) ──
        if (scrollY < -10) {
            const stY = scrollDist + sy; // positioned below menu
            const stFW = 38;
            const pad = 14;
            const stUsableW = W - stFW * 2 - pad * 2;
            const sectionW = Math.min(580, stUsableW * 0.85);
            const sliderW = sectionW - 40;
            const stCx = W / 2;
            const leftX = stCx - sliderW / 2;

            // Title
            const stTitleY = stFW + pad + 30 + stY;  // same topPad as level select
            const stTitleSz = Math.min(28, W * 0.028);
            k.drawText({ text: "SETTINGS", pos: k.vec2(stCx + 2, stTitleY + 2), size: stTitleSz, font: "PressStart2P", color: col("#1a0e05"), anchor: "top", opacity: 0.25 });
            k.drawText({ text: "SETTINGS", pos: k.vec2(stCx, stTitleY), size: stTitleSz, font: "PressStart2P", color: col("#4a2808"), anchor: "top" });

            // ── Audio section ────────────
            const audioY = stTitleY + stTitleSz + 20;
            k.drawText({ text: "Audio", pos: k.vec2(leftX, audioY), size: 14, font: "PressStart2P", color: col("#5a3510"), opacity: 0.6 });
            k.drawLine({ p1: k.vec2(leftX, audioY + 20), p2: k.vec2(leftX + sliderW, audioY + 20), width: 1.5, color: col("#5a3510"), opacity: 0.2 });

            const stSliders = [
                { key: "masterVol", label: "Master Volume" },
                { key: "musicVol", label: "Music" },
                { key: "sfxVol", label: "Sound Effects" },
            ];

            const sliderSpacing = 62;
            for (let i = 0; i < stSliders.length; i++) {
                const s = stSliders[i];
                const slY = audioY + 60 + i * sliderSpacing;
                const val = settingsData[s.key];
                const knobX = leftX + val * sliderW;
                const ropeCol = "#8B6914";
                const ropeDk = "#5a4010";

                // Label + percentage — drawn above the rope with enough clearance
                // so descenders don't kiss the rope line
                k.drawText({ text: s.label, pos: k.vec2(leftX, slY - 32), size: 22, font: "PatrickHand", color: col("#4a2808") });
                k.drawText({ text: Math.round(val * 100) + "%", pos: k.vec2(leftX + sliderW, slY - 32), size: 20, font: "PatrickHand", color: col("#4a2808"), anchor: "topright", opacity: 0.6 });

                // Rope — coiled section (left of knob)
                if (knobX - 14 > leftX) {
                    // Dark outline rope
                    k.drawLine({ p1: k.vec2(leftX, slY), p2: k.vec2(knobX - 14, slY), width: 7, color: col(ropeDk) });
                    // Light rope on top
                    k.drawLine({ p1: k.vec2(leftX, slY - 1), p2: k.vec2(knobX - 14, slY - 1), width: 4, color: col(ropeCol) });
                    // Coil marks (just a few hash marks, not per-pixel segments)
                    const coilCount = Math.min(12, Math.floor((knobX - 14 - leftX) / 16));
                    for (let ci = 0; ci < coilCount; ci++) {
                        const cx2 = leftX + (ci + 0.5) * ((knobX - 14 - leftX) / coilCount);
                        k.drawLine({ p1: k.vec2(cx2, slY - 5), p2: k.vec2(cx2 + 2, slY + 5), width: 2, color: col(ropeDk), opacity: 0.4 });
                    }
                }
                // Rope — taut section (right of knob): straight
                if (knobX + 14 < leftX + sliderW) {
                    k.drawLine({ p1: k.vec2(knobX + 14, slY), p2: k.vec2(leftX + sliderW, slY), width: 7, color: col(ropeDk) });
                    k.drawLine({ p1: k.vec2(knobX + 14, slY - 1), p2: k.vec2(leftX + sliderW, slY - 1), width: 4, color: col(ropeCol) });
                }
                // End pegs (wooden posts)
                for (const px of [leftX, leftX + sliderW]) {
                    k.drawRect({ pos: k.vec2(px, slY), width: 10, height: 22, color: col("#5a3510"), anchor: "center" });
                    k.drawRect({ pos: k.vec2(px, slY), width: 7, height: 18, color: col("#8a5020"), anchor: "center" });
                    k.drawRect({ pos: k.vec2(px - 1, slY - 6), width: 3, height: 4, color: col("#c4843c"), anchor: "center", opacity: 0.4 });
                }
                // Knob — big wooden peg
                const active = settingsDragging === s.key;
                const knobR = active ? 15 : 12;
                k.drawCircle({ pos: k.vec2(knobX + 1, slY + 2), radius: knobR, color: col("#1a0e05"), opacity: 0.25 });
                k.drawCircle({ pos: k.vec2(knobX, slY), radius: knobR, color: col(active ? "#c8853a" : "#b07030") });
                k.drawCircle({ pos: k.vec2(knobX, slY), radius: knobR, fill: false, outline: { width: 2.5, color: col("#5a3510") } });
                k.drawCircle({ pos: k.vec2(knobX - 3, slY - 3), radius: 4, color: col("#d4a060"), opacity: 0.4 });
                k.drawCircle({ pos: k.vec2(knobX, slY), radius: 3.5, color: col("#4a2808") });
            }

            // ── Gameplay section ──────────
            // N-1 gaps between N sliders + a modest padding below the last slider
            const gameY = audioY + 60 + (stSliders.length - 1) * sliderSpacing + 48;
            k.drawText({ text: "Gameplay", pos: k.vec2(leftX, gameY), size: 14, font: "PressStart2P", color: col("#5a3510"), opacity: 0.6 });
            k.drawLine({ p1: k.vec2(leftX, gameY + 20), p2: k.vec2(leftX + sliderW, gameY + 20), width: 1.5, color: col("#5a3510"), opacity: 0.2 });

            // (Show Grid + Stress Colors toggles moved out of settings — they
            // belong in an in-game options sheet, not the global settings.)

            // ── FPS Cap segmented control ──
            const fpsRowY = gameY + 46;
            k.drawText({ text: "FPS Cap", pos: k.vec2(leftX, fpsRowY), size: 22, font: "PatrickHand", color: col("#4a2808") });
            const segW = 56, segH = 28, segGap = 4;
            const segTotalW = FPS_OPTIONS.length * segW + (FPS_OPTIONS.length - 1) * segGap;
            const segStartX = leftX + sliderW - segTotalW;
            for (let si = 0; si < FPS_OPTIONS.length; si++) {
                const sx = segStartX + si * (segW + segGap) + segW / 2;
                const sy2 = fpsRowY + 10;
                const active = settingsData.fpsCap === FPS_OPTIONS[si];
                k.drawRect({ pos: k.vec2(sx, sy2), width: segW, height: segH, color: col(active ? "#6a9a50" : "#8a7060"), anchor: "center", radius: 4 });
                k.drawRect({ pos: k.vec2(sx, sy2), width: segW, height: segH, fill: false, outline: { width: 2, color: col("#3a2010") }, anchor: "center", radius: 4, opacity: 0.3 });
                k.drawText({ text: FPS_LABELS[si], pos: k.vec2(sx, sy2), size: 18, font: "PatrickHand", color: col(active ? "#ffffff" : "#3a2010"), anchor: "center" });
            }

            // ── Data section ─────────────
            const dataY = gameY + 46 + 44 + 24;
            k.drawText({ text: "Data", pos: k.vec2(leftX, dataY), size: 14, font: "PressStart2P", color: col("#5a3510"), opacity: 0.6 });
            k.drawLine({ p1: k.vec2(leftX, dataY + 20), p2: k.vec2(leftX + sliderW, dataY + 20), width: 1.5, color: col("#5a3510"), opacity: 0.2 });
            drawPlankButton(stCx, dataY + 56, 240, 40, "Reset Progress", false, 0);

            // Feedback message
            if (settingsMessage) {
                k.drawText({ text: settingsMessage, pos: k.vec2(stCx, dataY + 90), size: 20, font: "PatrickHand", color: col("#3a7a2a"), anchor: "top", opacity: Math.min(1, settingsMsgTimer) });
            }

            // HOME button
            drawPlankButton(stCx, dataY + 130, 160, 36, "< HOME", false, 0);
        }

        // Logo (slides with content — drawn BEFORE frame so frame covers it)
        drawLogo(W, H);

        // Frame border on top (FIXED — doesn't slide, acts as mask)
        drawFrame(W, H);
    });

    k.onMouseMove((pos) => {
        if (currentView !== "menu") { hoverPlay = false; hoverSettings = false; hoverCredits = false; return; }
        const W = k.width();
        const H = k.height();
        const btnW = Math.min(240, W * 0.34);
        const btnH = 40;
        const btnGap = 14;
        const btnX = W / 2;
        const btnStartY = H * 0.60 + scrollY;
        hoverPlay     = Math.abs(pos.x - btnX) < btnW / 2 && Math.abs(pos.y - btnStartY) < btnH / 2;
        hoverSettings = Math.abs(pos.x - btnX) < btnW / 2 && Math.abs(pos.y - (btnStartY + btnH + btnGap)) < btnH / 2;
        hoverCredits  = Math.abs(pos.x - btnX) < btnW / 2 && Math.abs(pos.y - (btnStartY + (btnH + btnGap) * 2)) < btnH / 2;
    });

    k.onMousePress(() => {
        const pos = k.mousePos();
        const W = k.width();
        const H = k.height();
        const FW = 38;
        const contentH = H - FW * 2;
        const btnW = Math.min(240, W * 0.34);
        const btnH = 40;
        const btnGap = 14;
        const btnX = W / 2;
        const btnStartY = H * 0.60;

        if (crackAnim) return;

        // ─── Leaderboard panel clicks (highest priority when fully open) ───
        if (lbOpen && lbAnimT > 0.95) {
            // Mirror the draw geometry so hit-testing matches what's on-screen.
            const panelW = Math.min(W * 0.72, 880);
            const panelH = Math.min(H * 0.78, 600);
            const panelX = W / 2 - panelW / 2;
            const panelY = H / 2 - panelH / 2;
            const cxP = panelX + panelW / 2;

            // Close button
            const closeY = panelY + panelH - 30;
            if (Math.abs(pos.x - cxP) < 60 && Math.abs(pos.y - closeY) < 18) {
                lbOpen = false;
                return;
            }

            // Level tabs — only the unlocked ones are interactive
            const unlockedLevels = [];
            for (let i = 0; i < Math.min(8, LEVELS.length); i++) {
                if (isUnlocked(i)) unlockedLevels.push(i);
            }
            const tabRowY = panelY + 76;
            const tabSz = 36;
            const tabGap = 8;
            const tabRowW = unlockedLevels.length * tabSz + Math.max(0, unlockedLevels.length - 1) * tabGap;
            const tabStartX = cxP - tabRowW / 2;
            for (let k2 = 0; k2 < unlockedLevels.length; k2++) {
                const lvIdx = unlockedLevels[k2];
                const tx = tabStartX + k2 * (tabSz + tabGap) + tabSz / 2;
                const ty = tabRowY + tabSz / 2;
                if (Math.abs(pos.x - tx) < tabSz / 2 && Math.abs(pos.y - ty) < tabSz / 2) {
                    if (lbLevel !== lvIdx) {
                        lbLevel = lvIdx;
                        loadLeaderboard(lvIdx);
                    }
                    return;
                }
            }

            // Click outside the panel closes it
            if (pos.x < panelX || pos.x > panelX + panelW || pos.y < panelY || pos.y > panelY + panelH) {
                lbOpen = false;
            }
            return;
        }
        // While the slide animation is running, swallow clicks so the player
        // can't accidentally trigger the underlying screen.
        if (lbOpen || lbAnimT > 0.05) return;

        // ─── MENU VIEW clicks ───────────────────────
        if (currentView === "menu" && scrollTarget === 0) {
            if (Math.abs(pos.x - btnX) < btnW / 2 && Math.abs(pos.y - btnStartY) < btnH / 2) {
                scrollTarget = scrollDist; // scroll up to level select
                return;
            }
            if (Math.abs(pos.x - btnX) < btnW / 2 && Math.abs(pos.y - (btnStartY + btnH + btnGap)) < btnH / 2) {
                scrollTarget = -scrollDist; // scroll down to settings
                return;
            }
        }

        // ─── LEVEL SELECT VIEW clicks ───────────────
        if (currentView === "levelSelect") {
            const sy = scrollY;
            const lsY = -scrollDist + sy;
            const lsCw = W - FW * 2;
            const pad = 14;
            const topPad = 30;
            const usableW = lsCw - pad * 2;
            const usableH = contentH - pad * 2 - topPad;
            const titleSz = Math.min(28, W * 0.028);
            const titleY = FW + pad + topPad + lsY;
            const SHOWN_LEVELS = 8;
            const cols = 4;
            const rows = 2;
            const topArea = titleSz + 28;
            const bottomArea = 60;
            const noteGap = 18;
            const noteW = Math.floor((usableW * 0.86 - (cols - 1) * noteGap) / cols);
            const noteH = Math.floor(((usableH - topArea - bottomArea) * 0.92 - (rows - 1) * noteGap) / rows);
            const gridW = cols * noteW + (cols - 1) * noteGap;
            const gridStartX = W / 2 - gridW / 2;
            const gridStartY = titleY + topArea;

            // HOME (left) + LEADERBOARD (right) buttons
            const homeY = gridStartY + rows * (noteH + noteGap) + 36;
            const homeBtnX = W / 2 - 100;
            const lbBtnX   = W / 2 + 100;
            if (Math.abs(pos.x - homeBtnX) < 70 && Math.abs(pos.y - homeY) < 18) {
                scrollTarget = 0;
                lsSelectedIdx = -1;
                return;
            }
            if (Math.abs(pos.x - lbBtnX) < 90 && Math.abs(pos.y - homeY) < 18) {
                // Open leaderboard modal — default to first unlocked level
                lbOpen = true;
                let firstUnlocked = 0;
                for (let i = 0; i < Math.min(8, LEVELS.length); i++) {
                    if (isUnlocked(i)) { firstUnlocked = i; break; }
                }
                lbLevel = firstUnlocked;
                loadLeaderboard(firstUnlocked);
                return;
            }

            // Wooden cards — click to enter level immediately
            const totalToShow = Math.min(SHOWN_LEVELS, LEVELS.length);
            for (let i = 0; i < totalToShow; i++) {
                const r = Math.floor(i / cols);
                const c2 = i % cols;
                const cx = gridStartX + c2 * (noteW + noteGap) + noteW / 2;
                const cy = gridStartY + r * (noteH + noteGap) + noteH / 2;
                if (Math.abs(pos.x - cx) < noteW / 2 && Math.abs(pos.y - cy) < noteH / 2) {
                    if (isUnlocked(i)) k.go("game", { levelIdx: i });
                    return;
                }
            }
        }

        // ─── SETTINGS VIEW clicks ───────────────────
        if (currentView === "settings") {
            const stY = scrollDist + scrollY;
            const pad = 14;
            const stUsableW = W - FW * 2 - pad * 2;
            const sectionW = Math.min(580, stUsableW * 0.85);
            const sliderW = sectionW - 40;
            const stCx = W / 2;
            const leftX = stCx - sliderW / 2;
            const stTitleSz = Math.min(28, W * 0.028);
            const stTitleY = FW + pad + 30 + stY;
            const audioY = stTitleY + stTitleSz + 20;
            const sliderSpacing = 62;

            const stSliders = [
                { key: "masterVol" },
                { key: "musicVol" },
                { key: "sfxVol" },
            ];

            // Sliders
            for (let i = 0; i < stSliders.length; i++) {
                const s = stSliders[i];
                const slY = audioY + 60 + i * sliderSpacing;
                if (pos.y > slY - 18 && pos.y < slY + 18 && pos.x > leftX - 16 && pos.x < leftX + sliderW + 16) {
                    settingsDragging = s.key;
                    settingsData[s.key] = Math.max(0, Math.min(1, (pos.x - leftX) / sliderW));
                    return;
                }
            }

            // (Toggles removed — Show Grid + Stress Colors live in-game now.)
            const gameY = audioY + 60 + (stSliders.length - 1) * sliderSpacing + 48;

            // FPS Cap segments
            const fpsRowY = gameY + 46;
            const segW = 56, segH = 28, segGap = 4;
            const segTotalW = FPS_OPTIONS.length * segW + (FPS_OPTIONS.length - 1) * segGap;
            const segStartX = leftX + sliderW - segTotalW;
            for (let si = 0; si < FPS_OPTIONS.length; si++) {
                const sx = segStartX + si * (segW + segGap) + segW / 2;
                const sy2 = fpsRowY + 10;
                if (Math.abs(pos.x - sx) < segW / 2 && Math.abs(pos.y - sy2) < segH / 2) {
                    settingsData.fpsCap = FPS_OPTIONS[si];
                    saveSettingsData();
                    return;
                }
            }

            // Reset Progress
            const dataY = gameY + 46 + 44 + 24;
            if (Math.abs(pos.x - stCx) < 120 && Math.abs(pos.y - (dataY + 56)) < 20) {
                if (confirm("Reset all progress? This cannot be undone.")) {
                    resetProgress();
                    settingsMessage = "Progress reset!";
                    settingsMsgTimer = 2;
                }
                return;
            }

            // HOME button
            if (Math.abs(pos.x - stCx) < 80 && Math.abs(pos.y - (dataY + 130)) < 18) {
                scrollTarget = 0;
                return;
            }
        }
    });

    k.onMouseRelease(() => {
        if (settingsDragging) saveSettingsData();
        settingsDragging = null;
    });
}
