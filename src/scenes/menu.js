import { C } from "../constants.js";
import { LEVELS } from "../levels.js";
import { isUnlocked, getGrade, resetProgress } from "../progression.js";
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
        const btnW = Math.min(280, W * 0.40);
        const btnH = 44;
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

        // ── Level select content (sticky notes on corkboard) ──
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

            // Sticky note grid — 5 cols × 3 rows, fills available space
            const cols = 5;
            const rows = 3;
            const topArea = titleSz + 24;
            const bottomArea = 50;
            const noteGap = 10;
            const noteW = Math.floor((usableW * 0.88 - (cols - 1) * noteGap) / cols);
            const noteH = Math.floor(((usableH - topArea - bottomArea) * 0.88 - (rows - 1) * noteGap) / rows);
            const gridW = cols * noteW + (cols - 1) * noteGap;
            const gridStartX = W / 2 - gridW / 2;
            const gridStartY = titleY + topArea;

            const NOTE_COLS = ["#ffe97a","#ffb07a","#ff8fa0","#a0d4ff","#a0ffb8","#e0a0ff","#ffcf7a","#7ae8d0","#f0a0c0","#b8e87a","#ffa07a","#a0c8ff","#ffe07a","#c0ff90","#ffb8d0"];
            const gradeColors = { S: "#ffd700", A: "#50c878", B: "#5090d0", C: "#b08050" };

            // Compute grid layout once (reused by click handler)
            // Each note gets a slight random tilt (seeded by index)
            function noteLayout(i) {
                const r = Math.floor(i / cols);
                const c2 = i % cols;
                const cx = gridStartX + c2 * (noteW + noteGap) + noteW / 2;
                const cy = gridStartY + r * (noteH + noteGap) + noteH / 2;
                // Deterministic tilt per note
                const tilt = (Math.sin(i * 7.3 + 2.1) * 0.04);
                return { cx, cy, tilt };
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

            for (let i = 0; i < LEVELS.length; i++) {
                // Skip the ripping note
                if (noteRip && noteRip.idx === i) continue;

                const { cx, cy, tilt } = noteLayout(i);
                const unlocked = isUnlocked(i);
                const grade = getGrade(i);
                const lvl = LEVELS[i];
                const noteCol = NOTE_COLS[i % NOTE_COLS.length];

                if (unlocked) {
                    // Shadow (pixelated — no rounding)
                    k.drawRect({ width: noteW, height: noteH, pos: k.vec2(cx + 3, cy + 3), color: col("#1a0e05"), anchor: "center", opacity: 0.18 });
                    // Sticky note body
                    k.drawRect({ width: noteW, height: noteH, pos: k.vec2(cx, cy), color: col(noteCol), anchor: "center" });
                    // Dark border (pixel art style)
                    k.drawRect({ width: noteW, height: noteH, pos: k.vec2(cx, cy), fill: false, outline: { width: 2, color: col("#2a1505") }, anchor: "center", opacity: 0.25 });
                    // Fold line at bottom
                    k.drawLine({ p1: k.vec2(cx - noteW/2 + 2, cy + noteH/2 - 4), p2: k.vec2(cx + noteW/2 - 2, cy + noteH/2 - 4), width: 1, color: col("#000000"), opacity: 0.08 });

                    // Level number — top left, pixel font
                    k.drawText({ text: (i + 1) + "", pos: k.vec2(cx - noteW/2 + 8, cy - noteH/2 + 8), size: Math.min(14, noteW * 0.08), font: "PressStart2P", color: col("#2a1505"), anchor: "topleft", opacity: 0.5 });

                    // Gimmick icon — center area
                    const iconSz = Math.min(noteW, noteH) * 0.2;
                    drawGimmickIcon(lvl.gimmick, cx, cy - noteH * 0.08, iconSz, 0.4);

                    // Level name — hand-drawn readable font
                    k.drawText({ text: lvl.name, pos: k.vec2(cx, cy + noteH * 0.22), size: Math.min(22, noteW * 0.11), font: "PatrickHand", color: col("#2a1505"), anchor: "center", width: noteW - 12 });

                    // Concept tag
                    k.drawText({ text: lvl.concept, pos: k.vec2(cx, cy + noteH * 0.38), size: Math.min(16, noteW * 0.08), font: "PatrickHand", color: col("#5a4020"), anchor: "center", opacity: 0.5 });

                    // Grade stamp — big pixel art badge, top right
                    if (grade) {
                        const gx = cx + noteW/2 - 14;
                        const gy = cy - noteH/2 + 14;
                        // Square badge (pixel art)
                        k.drawRect({ width: 22, height: 22, pos: k.vec2(gx, gy), color: col(gradeColors[grade] || "#888888"), anchor: "center" });
                        k.drawRect({ width: 22, height: 22, pos: k.vec2(gx, gy), fill: false, outline: { width: 2, color: col("#2a1505") }, anchor: "center", opacity: 0.4 });
                        k.drawText({ text: grade, pos: k.vec2(gx, gy), size: 12, font: "PressStart2P", color: col("#ffffff"), anchor: "center" });
                    }

                    // Pushpin — square pixel tack
                    k.drawRect({ width: 8, height: 8, pos: k.vec2(cx, cy - noteH/2 - 2), color: col("#d04040"), anchor: "center" });
                    k.drawRect({ width: 4, height: 4, pos: k.vec2(cx - 1, cy - noteH/2 - 3), color: col("#ff8080"), anchor: "center", opacity: 0.6 });
                } else {
                    // LOCKED — gray sticky note
                    k.drawRect({ width: noteW, height: noteH, pos: k.vec2(cx + 3, cy + 3), color: col("#1a0e05"), anchor: "center", opacity: 0.08 });
                    k.drawRect({ width: noteW, height: noteH, pos: k.vec2(cx, cy), color: col("#c0b8a8"), anchor: "center" });
                    k.drawRect({ width: noteW, height: noteH, pos: k.vec2(cx, cy), fill: false, outline: { width: 2, color: col("#8a8070") }, anchor: "center", opacity: 0.2 });

                    // Pixel lock icon
                    const lx = cx, ly = cy - 2;
                    // Body (rectangle)
                    k.drawRect({ width: 16, height: 12, pos: k.vec2(lx, ly + 6), color: col("#8a8070"), anchor: "center" });
                    // Shackle (blocky U shape)
                    k.drawRect({ width: 12, height: 3, pos: k.vec2(lx, ly - 5), color: col("#8a8070"), anchor: "center" });
                    k.drawRect({ width: 3, height: 8, pos: k.vec2(lx - 5, ly - 1), color: col("#8a8070"), anchor: "center" });
                    k.drawRect({ width: 3, height: 8, pos: k.vec2(lx + 5, ly - 1), color: col("#8a8070"), anchor: "center" });
                    // Keyhole
                    k.drawRect({ width: 4, height: 4, pos: k.vec2(lx, ly + 5), color: col("#6a6050"), anchor: "center" });

                    // Level number
                    k.drawText({ text: (i + 1) + "", pos: k.vec2(cx, cy + noteH * 0.30), size: 8, font: "PressStart2P", color: col("#8a8070"), anchor: "center", opacity: 0.4 });

                    // Gray pin
                    k.drawRect({ width: 8, height: 8, pos: k.vec2(cx, cy - noteH/2 - 2), color: col("#a09888"), anchor: "center" });
                }
            }

            // ─── Note rip animation ─────────────────────
            if (noteRip) {
                noteRip.t += dt;
                const nr = noteRip;
                const noteCol = NOTE_COLS[nr.idx % NOTE_COLS.length];

                // Main note falling/rotating
                const fallY = nr.vy * nr.t + 400 * nr.t * nr.t;
                const rot = nr.rot + nr.rotSpd * nr.t;
                const opacity = Math.max(0, 1 - nr.t * 1.5);
                const ncx = nr.cx + nr.driftX * nr.t;
                const ncy = nr.cy + fallY;

                // Draw rotated sticky note
                const hw = nr.w / 2, hh = nr.h / 2;
                const cos = Math.cos(rot), sin = Math.sin(rot);
                function rotPt(rx, ry) {
                    return k.vec2(ncx + rx * cos - ry * sin, ncy + rx * sin + ry * cos);
                }
                const tl = rotPt(-hw, -hh), tr = rotPt(hw, -hh), br = rotPt(hw, hh), bl = rotPt(-hw, hh);
                k.drawTriangle({ p1: tl, p2: tr, p3: br, color: col(noteCol), opacity });
                k.drawTriangle({ p1: tl, p2: br, p3: bl, color: col(noteCol), opacity });

                // Torn edge at top — jagged line
                for (let j = 0; j < 6; j++) {
                    const t1 = j / 6, t2 = (j + 1) / 6;
                    const jag1 = (Math.sin(j * 13.7) * 0.5 + 0.5) * 4;
                    const jag2 = (Math.sin((j+1) * 13.7) * 0.5 + 0.5) * 4;
                    const p1 = rotPt(-hw + t1 * nr.w, -hh + jag1);
                    const p2 = rotPt(-hw + t2 * nr.w, -hh + jag2);
                    k.drawLine({ p1, p2, width: 1.5, color: col("#fff8ee"), opacity: opacity * 0.7 });
                }

                // Tiny paper scraps
                for (const p of nr.pieces) {
                    p.x += p.vx * dt;
                    p.y += p.vy * dt;
                    p.vy += 200 * dt;
                    p.life -= dt;
                    if (p.life > 0) {
                        k.drawRect({ width: p.sz, height: p.sz * 0.6, pos: k.vec2(p.x, p.y), color: col(noteCol), anchor: "center", opacity: Math.max(0, p.life * 2) });
                    }
                }

                // Transition after animation
                if (nr.t > 0.5) {
                    noteRip = null;
                    k.go("game", { levelIdx: nr.idx });
                }
            }

            // HOME button — centered at bottom
            const homeY = gridStartY + rows * (noteH + noteGap) + 36;
            drawPlankButton(W / 2, homeY, 130, 30, "< HOME", false, 0);
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

            const stToggles = [
                { key: "showGrid", label: "Show Grid" },
                { key: "showStress", label: "Stress Colors" },
            ];

            for (let i = 0; i < stToggles.length; i++) {
                const t = stToggles[i];
                const tY = gameY + 46 + i * 44;
                const val = settingsData[t.key];
                k.drawText({ text: t.label, pos: k.vec2(leftX, tY), size: 22, font: "PatrickHand", color: col("#4a2808") });
                const tx = leftX + 240, tw = 50, th = 26;
                k.drawRect({ pos: k.vec2(tx, tY + 10), width: tw, height: th, color: col(val ? "#6a9a50" : "#8a7060"), anchor: "center", radius: 13 });
                k.drawRect({ pos: k.vec2(tx, tY + 10), width: tw, height: th, fill: false, outline: { width: 2, color: col("#3a2010") }, anchor: "center", radius: 13, opacity: 0.3 });
                const pegX = val ? tx + tw / 2 - th / 2 : tx - tw / 2 + th / 2;
                k.drawCircle({ pos: k.vec2(pegX, tY + 10), radius: th / 2 - 2, color: col("#d4b060") });
                k.drawCircle({ pos: k.vec2(pegX, tY + 10), radius: th / 2 - 2, fill: false, outline: { width: 2, color: col("#5a3510") } });
            }

            // ── FPS Cap segmented control ──
            const fpsRowY = gameY + 46 + stToggles.length * 44;
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
            const dataY = gameY + 46 + stToggles.length * 44 + 44 + 24;
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
        const btnW = Math.min(280, W * 0.40);
        const btnH = 44;
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
        const btnW = Math.min(280, W * 0.40);
        const btnH = 44;
        const btnGap = 14;
        const btnX = W / 2;
        const btnStartY = H * 0.60;

        if (crackAnim) return;

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
            if (noteRip) return; // rip animation playing

            const sy = scrollY;
            const lsY = -scrollDist + sy;
            const lsCw = W - FW * 2;
            const pad = 14;
            const topPad = 30;
            const usableW = lsCw - pad * 2;
            const usableH = contentH - pad * 2 - topPad;
            const titleSz = Math.min(28, W * 0.028);
            const titleY = FW + pad + topPad + lsY;
            const cols = 5;
            const rows = 3;
            const topArea = titleSz + 24;
            const bottomArea = 50;
            const noteGap = 10;
            const noteW = Math.floor((usableW * 0.88 - (cols - 1) * noteGap) / cols);
            const noteH = Math.floor(((usableH - topArea - bottomArea) * 0.88 - (rows - 1) * noteGap) / rows);
            const gridW = cols * noteW + (cols - 1) * noteGap;
            const gridStartX = W / 2 - gridW / 2;
            const gridStartY = titleY + topArea;

            // HOME button (centered at bottom)
            const homeY = gridStartY + rows * (noteH + noteGap) + 36;
            const hbX = W / 2;
            if (Math.abs(pos.x - hbX) < 80 && Math.abs(pos.y - homeY) < 20) {
                scrollTarget = 0;
                lsSelectedIdx = -1;
                return;
            }

            // Sticky notes — click to rip and enter level
            for (let i = 0; i < LEVELS.length; i++) {
                const r = Math.floor(i / cols);
                const c2 = i % cols;
                const cx = gridStartX + c2 * (noteW + noteGap) + noteW / 2;
                const cy = gridStartY + r * (noteH + noteGap) + noteH / 2;
                if (Math.abs(pos.x - cx) < noteW / 2 && Math.abs(pos.y - cy) < noteH / 2) {
                    if (isUnlocked(i)) {
                        // Start rip animation
                        const pieces = [];
                        for (let p = 0; p < 8; p++) {
                            pieces.push({
                                x: cx + (Math.random() - 0.5) * noteW * 0.6,
                                y: cy - noteH / 2 + Math.random() * 6,
                                vx: (Math.random() - 0.5) * 120,
                                vy: -40 - Math.random() * 80,
                                sz: 3 + Math.random() * 5,
                                life: 0.3 + Math.random() * 0.3,
                            });
                        }
                        noteRip = {
                            idx: i, cx, cy, w: noteW, h: noteH, t: 0,
                            vy: 30 + Math.random() * 20,
                            driftX: (Math.random() - 0.5) * 60,
                            rot: 0,
                            rotSpd: (Math.random() - 0.5) * 4,
                            pieces,
                        };
                    }
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

            // Toggles
            const gameY = audioY + 60 + (stSliders.length - 1) * sliderSpacing + 48;
            const stToggles = [{ key: "showGrid" }, { key: "showStress" }];
            for (let i = 0; i < stToggles.length; i++) {
                const t = stToggles[i];
                const tY = gameY + 46 + i * 44;
                const tx = leftX + 240;
                if (Math.abs(pos.x - tx) < 30 && Math.abs(pos.y - (tY + 10)) < 16) {
                    settingsData[t.key] = !settingsData[t.key];
                    saveSettingsData(); // single click, fine to save immediately
                    return;
                }
            }

            // FPS Cap segments
            const fpsRowY = gameY + 46 + stToggles.length * 44;
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
            const dataY = gameY + 46 + stToggles.length * 44 + 44 + 24;
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
