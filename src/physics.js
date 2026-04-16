import { MATERIALS, GRID } from "./constants.js";

// ═══════════════════════════════════════════════════════
//  XPBD BRIDGE PHYSICS
//
//  Extended Position-Based Dynamics (XPBD) constraint solver.
//  Each member is a distance constraint enforced directly —
//  no springs, no oscillation. Stress is derived from the
//  Lagrange multiplier (constraint force).
// ═══════════════════════════════════════════════════════

const GRAVITY       = 0.4;    // px / frame²
const DAMPING       = 0.98;   // velocity retained per frame
const SUBSTEPS      = 8;      // simulation substeps per frame
const SUB_DT        = 1 / SUBSTEPS;
const SOLVER_ITERS  = 8;      // stiff constraints — no stretching. Breaking is handled by fatigue, not solver weakness.
const VEHICLE_G     = 0.8;    // vehicle weight for fatigue calculation

// ─── Node ────────────────────────────────────────────
export class Node {
    constructor(x, y, fixed = false) {
        this.x  = x;   this.y  = y;    // current position
        this.rx = x;   this.ry = y;    // rest/build position (for reset)
        this.ox = x;   this.oy = y;    // old position (start of substep)
        this.px = x;   this.py = y;    // predicted position (PBD working copy)
        this.vx = 0;   this.vy = 0;    // velocity
        this.fx = 0;   this.fy = 0;    // external force accumulator (vehicle weight)
        this.fixed   = fixed;
        this.builtin = false;
        this.invMass = fixed ? 0 : 1;  // 0 = infinite mass (anchors don't move)
    }
    reset() {
        this.x  = this.rx;  this.y  = this.ry;
        this.px = this.rx;  this.py = this.ry;
        this.ox = this.rx;  this.oy = this.ry;
        this.vx = 0;  this.vy = 0;
        this.fx = 0;  this.fy = 0;
    }
}

// ─── Member (distance constraint) ────────────────────
export class Member {
    constructor(n1, n2, type) {
        this.n1   = n1;
        this.n2   = n2;
        this.type = type;
        this.rest = Math.hypot(n1.x - n2.x, n1.y - n2.y);
        this.restAngle   = Math.atan2(n2.y - n1.y, n2.x - n1.x); // angle at build time
        this.compliance  = MATERIALS[type].compliance;  // XPBD compliance
        this.broken      = false;
        this.stress      = 0;       // smoothed display stress (0-1)
        this._breakStress = 0;      // fast-response stress for breaking
        this.lambda      = 0;       // XPBD accumulated Lagrange multiplier
        this.sparkDone   = false;
        this.builtin     = false;
    }
}

// ─── Spark (break particle) ──────────────────────────
export class Spark {
    constructor(x, y, color) {
        this.x = x;  this.y = y;
        this.vx = (Math.random() - 0.5) * 6;
        this.vy = -Math.random() * 5 - 1;
        this.life = 1;
        this.decay = 0.025 + Math.random() * 0.025;
        this.r = 2 + Math.random() * 3;
        this.color = color;
    }
    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.vy += 0.16;
        this.vx *= 0.97;
        this.life -= this.decay;
    }
}

// ─── Snap to grid ─────────────────────────────────────
export function snapToGrid(wx, wy, anchorNodes) {
    if (anchorNodes) {
        for (const a of anchorNodes) {
            if (Math.abs(wx - a.x) < GRID * 0.8 && Math.abs(wy - a.y) < GRID * 0.8)
                return { x: a.x, y: a.y };
        }
    }
    return { x: Math.round(wx / GRID) * GRID, y: Math.round(wy / GRID) * GRID };
}

// ─── Point-to-segment distance ────────────────────────
export function distToSegment(p, v, w) {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
}

// ─── BFS: is node connected to an anchor? ─────────────
export function isConnectedToAnchor(nodes, members, x, y) {
    const visited = new Set();
    const queue = nodes.filter(n => n.fixed);
    queue.forEach(n => visited.add(n));
    while (queue.length) {
        const cur = queue.shift();
        for (const m of members) {
            if (m.broken) continue;
            const other = m.n1 === cur ? m.n2 : m.n2 === cur ? m.n1 : null;
            if (other && !visited.has(other)) { visited.add(other); queue.push(other); }
        }
    }
    const node = nodes.find(n => n.x === x && n.y === y);
    return node && visited.has(node);
}

// ─── Build cost ───────────────────────────────────────
export function calcCost(members) {
    return members.reduce((s, m) =>
        m.builtin ? s : s + Math.round((m.rest * MATERIALS[m.type].price) / 10), 0);
}

// ─── Mark which road segments are driveable ───────────
// Per-segment check: a road is "supported" only if BOTH its nodes
// connect directly to a structural (non-road) member or are fixed anchors.
// No flood-fill — support doesn't propagate through road segments.
// This means every section of road needs its OWN beams underneath.
function updateRoadSupport(state) {
    // Collect all nodes that directly touch a non-road structural member
    const beamNodes = new Set();
    for (const m of state.members) {
        if (m.broken || MATERIALS[m.type].isRoad) continue;
        beamNodes.add(m.n1);
        beamNodes.add(m.n2);
    }

    for (const m of state.members) {
        if (!MATERIALS[m.type].isRoad) continue;
        const n1ok = m.n1.fixed || beamNodes.has(m.n1);
        const n2ok = m.n2.fixed || beamNodes.has(m.n2);
        m._driveable = n1ok && n2ok;
    }
}

// ═══════════════════════════════════════════════════════
//  WORLD INIT / DESTROY
// ═══════════════════════════════════════════════════════

export function initPhysicsWorld(state, lvl) {
    state._lvl = lvl;
    state._active = true;
    for (const n of state.nodes) {
        n.vx = 0; n.vy = 0; n.fx = 0; n.fy = 0;
        n.px = n.x; n.py = n.y;
        n.ox = n.x; n.oy = n.y;
        n.invMass = n.fixed ? 0 : 1;
    }
    for (const m of state.members) {
        m.lambda = 0;
        m._breakStress = 0;
        m._fatigue = 0;
    }
    updateRoadSupport(state);
}

export function destroyPhysicsWorld(state) {
    state._active = false;
    state._lvl = null;
    for (const n of state.nodes) {
        n.vx = 0; n.vy = 0; n.fx = 0; n.fy = 0;
    }
}

// ═══════════════════════════════════════════════════════
//  PHYSICS TICK  — XPBD constraint solver
// ═══════════════════════════════════════════════════════
export function physicsTick(state) {
    if (!state._active) return;

    // Capture external forces from vehicleTick (applied last frame)
    for (const n of state.nodes) {
        n._extFY = n.fy;
        n.fy = 0;
        n.fx = 0;
    }

    // ── Substep loop ─────────────────────────────────
    for (let s = 0; s < SUBSTEPS; s++) {

        // 1. Apply forces → update velocities
        for (const n of state.nodes) {
            if (n.invMass === 0) continue;
            n.vy += (GRAVITY + n._extFY) * SUB_DT;
            n.vx *= DAMPING;
            n.vy *= DAMPING;
        }

        // 2. Save old positions, predict new positions
        for (const n of state.nodes) {
            n.ox = n.x;
            n.oy = n.y;
            if (n.invMass > 0) {
                n.px = n.x + n.vx * SUB_DT;
                n.py = n.y + n.vy * SUB_DT;
            } else {
                n.px = n.x;
                n.py = n.y;
            }
        }

        // 3. Reset Lagrange multipliers
        for (const m of state.members) {
            if (!m.broken) m.lambda = 0;
        }

        // 4. Solve distance constraints (multiple iterations)
        for (let iter = 0; iter < SOLVER_ITERS; iter++) {
            for (const m of state.members) {
                if (m.broken) continue;

                const dx = m.n2.px - m.n1.px;
                const dy = m.n2.py - m.n1.py;
                const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
                const C = dist - m.rest;  // constraint violation

                const mat = MATERIALS[m.type];

                // Tension-only: skip if slack (compressed)
                if (mat.tensionOnly && C < 0) continue;

                // XPBD compliance (material stiffness, no hacks)
                const alpha = m.compliance / (SUB_DT * SUB_DT);
                const w1 = m.n1.invMass;
                const w2 = m.n2.invMass;
                const denom = w1 + w2 + alpha;
                if (denom === 0) continue;

                const dlambda = -(C + alpha * m.lambda) / denom;
                m.lambda += dlambda;

                // Position corrections
                const cx = dlambda * (dx / dist);
                const cy = dlambda * (dy / dist);

                m.n1.px -= w1 * cx;
                m.n1.py -= w1 * cy;
                m.n2.px += w2 * cx;
                m.n2.py += w2 * cy;
            }
        }

        // 5. Terrain collision on predicted positions
        if (state._terrainColliders) {
            for (const n of state.nodes) {
                if (n.invMass === 0) continue;
                for (const c of state._terrainColliders) {
                    if (n.px > c.x1 && n.px < c.x2 && n.py > c.y1 && n.py < c.y2) {
                        const dLeft  = n.px - c.x1;
                        const dRight = c.x2 - n.px;
                        const dTop   = n.py - c.y1;
                        const dBot   = c.y2 - n.py;
                        const minD = Math.min(dLeft, dRight, dTop, dBot);
                        if (minD === dTop)        n.py = c.y1;
                        else if (minD === dBot)   n.py = c.y2;
                        else if (minD === dLeft)  n.px = c.x1;
                        else                      n.px = c.x2;
                    }
                }
            }
        }

        // 6. Derive velocities and update positions
        for (const n of state.nodes) {
            if (n.invMass === 0) continue;
            n.vx = (n.px - n.ox) / SUB_DT;
            n.vy = (n.py - n.oy) / SUB_DT;
            n.x = n.px;
            n.y = n.py;
        }
    }

    // ── Stress measurement & breaking ────────────────
    // Two stress sources:
    //   1. Fatigue — unsupported roads accumulate stress over time under vehicle load.
    //      Road stays rigid and flat, stress colors build up, then SNAP.
    //   2. Lambda — axial constraint force for overloaded trusses / cables.
    //
    // Fatigue is the primary gameplay mechanic:
    //   - Car on unsupported wood road: breaks in ~1 second
    //   - Bicycle on unsupported wood road: very slow fatigue (survives level 1)
    //   - Any vehicle on supported road: no fatigue (beams do their job)

    let worstMember = null;
    let worstStress = 0;

    for (const m of state.members) {
        if (m.broken) continue;

        const mat = MATERIALS[m.type];

        // Tension-only: check if slack
        if (mat.tensionOnly) {
            const dx = m.n2.x - m.n1.x;
            const dy = m.n2.y - m.n1.y;
            const dist = Math.hypot(dx, dy);
            if (dist <= m.rest) {
                m.stress *= 0.9;
                continue;
            }
        }

        // 1. Fatigue stress — unsupported roads under vehicle load
        if (mat.isRoad && !m._driveable) {
            const vForce = Math.max(m.n1._extFY || 0, m.n2._extFY || 0);
            if (vForce > 0) {
                // Heavier vehicles → faster fatigue.  Scale so:
                //   bicycle (force ~4): +0.003/frame → ~5.5s to break
                //   car     (force ~20): +0.015/frame → ~1.1s to break
                //   bus     (force ~120): +0.09/frame → ~0.2s to break
                m._fatigue = (m._fatigue || 0) + vForce * 0.00075;
            }
        }

        // 2. Lambda-based stress (axial constraint force)
        const forceMag = Math.abs(m.lambda) / (SUB_DT * SUB_DT);
        const lambdaStress = forceMag / mat.breakForce;

        const rawStress = Math.max(m._fatigue || 0, lambdaStress);

        // Smooth display stress (for color visualization)
        m.stress = m.stress * 0.7 + rawStress * 0.3;

        // Breaking threshold
        m._breakStress = (m._breakStress || 0) * 0.2 + rawStress * 0.8;
        if (m._breakStress > worstStress) {
            worstStress = m._breakStress;
            worstMember = m;
        }
    }

    // Break only the single worst member if it exceeds threshold
    if (worstMember && worstStress > 1.0) {
        worstMember.broken = true;
        state.shakeMag = 5;

        // ── Kick halves outward for a clean split ──
        // Stronger kick at the tips (far from anchors), zero at anchors.
        // This creates angular momentum so each half swings toward its wall.
        const breakX = (worstMember.n1.x + worstMember.n2.x) / 2;
        const lvl = state._lvl;
        for (const n of state.nodes) {
            if (n.invMass === 0) continue;
            const onLeft = n.x < breakX;
            const anchorX = onLeft ? lvl.lX : lvl.rX;
            const dist = Math.abs(n.x - anchorX);
            const maxDist = lvl.gap / 2;
            const strength = Math.min(1, dist / maxDist);  // 0 at anchor, 1 at tip
            n.vx += (onLeft ? -1 : 1) * strength * 5;
            n.vy += strength * 4;
        }

        // ── Cascade: break all members now disconnected from every anchor ──
        const reachable = new Set();
        const queue = [];
        for (const n of state.nodes) {
            if (n.fixed) { reachable.add(n); queue.push(n); }
        }
        while (queue.length) {
            const cur = queue.shift();
            for (const m of state.members) {
                if (m.broken) continue;
                const other = m.n1 === cur ? m.n2 : m.n2 === cur ? m.n1 : null;
                if (other && !reachable.has(other)) {
                    reachable.add(other);
                    queue.push(other);
                }
            }
        }

        // Free-floating debris → break it, give random kick
        for (const m of state.members) {
            if (m.broken) continue;
            if (!reachable.has(m.n1) && !reachable.has(m.n2)) {
                m.broken = true;
                for (const n of [m.n1, m.n2]) {
                    n.vx += (Math.random() - 0.5) * 3;
                    n.vy += Math.random() * 2;
                }
            }
        }

        updateRoadSupport(state);
    }
}

// ═══════════════════════════════════════════════════════
//  VEHICLE TICK
// ═══════════════════════════════════════════════════════
export function vehicleTick(state, lvl, lvlDef) {
    if (!state._active) return null;

    for (const v of state.vehicles) {
        if (!v.active || v.finished) continue;

        let roadY = null;
        let roadAngle = 0;
        let bestMember = null;

        // Ground surfaces at approaches
        if (v.x < lvl.lX + 10) { roadY = lvl.lY; roadAngle = 0; }
        else if (v.x > lvl.rX - 10) { roadY = lvl.rY; roadAngle = 0; }

        for (const m of state.members) {
            if (m.broken || !MATERIALS[m.type].isRoad) continue;

            const x1 = Math.min(m.n1.x, m.n2.x);
            const x2 = Math.max(m.n1.x, m.n2.x);
            if (v.x < x1 - 2 || v.x > x2 + 2) continue;

            const left  = m.n1.x <= m.n2.x ? m.n1 : m.n2;
            const right = m.n1.x <= m.n2.x ? m.n2 : m.n1;
            const curAngle = Math.atan2(right.y - left.y, right.x - left.x);
            const t = x2 === x1 ? 0.5 : Math.max(0, Math.min(1, (v.x - x1) / (x2 - x1)));
            const ry = left.y + t * (right.y - left.y);

            if (roadY === null || ry < roadY) {
                roadY = ry;
                roadAngle = curAngle;
                bestMember = m;
            }
        }

        const carBottom = v.y + v.cfg.h * 0.5;
        const snapDist = v._falling ? 5 : 10;
        const onSurface = roadY !== null && carBottom >= roadY - snapDist && carBottom <= roadY + snapDist;

        if (onSurface) {
            v._falling = false;
            const spd = v.cfg.speed * 1.2;
            v.x += spd * Math.cos(roadAngle);
            const targetY = roadY - v.cfg.h * 0.5;
            v.y = v.y * 0.5 + targetY * 0.5;
            v.angle = v.angle * 0.6 + roadAngle * 0.4;
            v.vx = spd;
            v.vy = 0;

            // Apply vehicle weight to road nodes
            if (bestMember) {
                const m = bestMember;
                const left  = m.n1.x <= m.n2.x ? m.n1 : m.n2;
                const right = m.n1.x <= m.n2.x ? m.n2 : m.n1;
                const x1 = Math.min(m.n1.x, m.n2.x);
                const x2 = Math.max(m.n1.x, m.n2.x);
                const t = x2 === x1 ? 0.5 : Math.max(0, Math.min(1, (v.x - x1) / (x2 - x1)));
                const w = v.cfg.mass * VEHICLE_G;
                if (left.invMass  > 0) left.fy  += w * (1 - t);
                if (right.invMass > 0) right.fy += w * t;
            }
        } else {
            // Falling
            if (!v._falling) { v._falling = true; if (!v.vx) v.vx = v.cfg.speed; }
            v.vy += 0.5;   // heavier falling gravity for vehicle
            v.x += v.vx;
            v.y += v.vy;
            v.vx *= 0.998;
            v.angVel = (v.angVel || 0) * 0.99 + 0.003 * (v.vx >= 0 ? 1 : -1);
            v.angle += v.angVel;

            // Wall collision
            const hw = v.cfg.w * 0.4;
            const hh = v.cfg.h * 0.4;
            if (v.x - hw < lvl.lX && v.y + hh > lvl.lY) {
                v.x = lvl.lX + hw;
                v.vx = Math.abs(v.vx) * 0.1;
                v.angVel = -0.02;
            }
            if (v.x + hw > lvl.rX && v.y + hh > lvl.rY) {
                v.x = lvl.rX - hw;
                v.vx = -Math.abs(v.vx) * 0.1;
                v.angVel = 0.02;
            }
            const groundY = v.x < lvl.lX ? lvl.lY : v.x > lvl.rX ? lvl.rY : null;
            if (groundY !== null && v.y + hh > groundY) {
                v.y = groundY - hh;
                v.vy = -v.vy * 0.15;
                v.vx *= 0.85;
                if (Math.abs(v.vy) < 0.3) { v.vy = 0; v.vx *= 0.9; }
            }
        }

        if (v.y > 1100) { v.active = false; return "fail"; }
        if (v.x > lvl.rX + 80 && v.y < lvl.rY + 60 && Math.abs(v.vy) < 3) v.finished = true;
    }

    if (state.vehicles.length && state.vehicles.every(v => v.finished)) return "win";
    return null;
}
