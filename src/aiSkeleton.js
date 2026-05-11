// Parametric bridge skeleton generators.
//
// The AI helper used to ask the LLM to invent geometry, which produced
// asymmetric / under-triangulated bridges. Instead, we generate a known-good
// archetype here in code and let the LLM only narrate it. Each generator
// returns members tagged with a `group` ("deck" | "primary" | "connectors")
// so the lesson can split them into ordered build steps.

import { MATERIALS, GRID } from "./constants.js";

const snap = (v) => Math.round(v / GRID) * GRID;

function pickMat(lvlDef, pred) {
    const allowed = lvlDef.materials || Object.keys(MATERIALS);
    return allowed.find(k => MATERIALS[k] && pred(MATERIALS[k])) || null;
}
const pickRoadKey    = (lvlDef) => pickMat(lvlDef, m => m.isRoad)                       || "wood_road";
const pickBeamKey    = (lvlDef) => pickMat(lvlDef, m => !m.isRoad && !m.tensionOnly)    || "wood_beam";
const pickTensionKey = (lvlDef) => pickMat(lvlDef, m => m.tensionOnly);

function getAnchors(lvl, lvlDef) {
    const anchors = [
        { side: "L",   x: lvl.lX, y: lvl.lY },
        { side: "R",   x: lvl.rX, y: lvl.rY },
    ];
    if (lvlDef.extraAnchors) {
        for (const a of lvlDef.extraAnchors) {
            let x, y;
            if (a.side === "L")      { x = lvl.lX + a.dx;   y = lvl.lY + a.dy; }
            else if (a.side === "R") { x = lvl.rX + a.dx;   y = lvl.rY + a.dy; }
            else                     { x = lvl.midX + a.dx; y = lvl.lY + a.dy; }
            anchors.push({ side: a.side, x: snap(x), y: snap(y) });
        }
    }
    return anchors;
}

// Segment the deck into pieces no longer than the road material's maxLength.
function deckPoints(lvl, lvlDef) {
    const roadKey = pickRoadKey(lvlDef);
    const roadMax = MATERIALS[roadKey].maxLength;
    const segs = Math.max(1, Math.ceil(lvl.gap / roadMax));
    const xs = [], ys = [];
    for (let i = 0; i <= segs; i++) {
        xs.push(snap(lvl.lX + (i * lvl.gap) / segs));
        ys.push(snap(lvl.lY + (i * lvl.hDiff) / segs));
    }
    xs[0] = lvl.lX; ys[0] = lvl.lY;
    xs[segs] = lvl.rX; ys[segs] = lvl.rY;
    return { xs, ys, segs, roadKey };
}

// Sum cost of a list of `{x1,y1,x2,y2,type}` members.
function costOf(members) {
    let sum = 0;
    for (const m of members) {
        const mat = MATERIALS[m.type];
        if (!mat) continue;
        const len = Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
        sum += len * mat.price / 10;
    }
    return Math.round(sum);
}

// ─── ARCHETYPE: simple supports ─────────────────────────────────
// Cheapest archetype for short, light-load levels. Deck + a handful of
// inverted-V braces underneath every other interior node. No bottom chord.
function genSimpleSupports(lvl, lvlDef) {
    const beamKey = pickBeamKey(lvlDef);
    const { xs, ys, segs, roadKey } = deckPoints(lvl, lvlDef);
    const depth = GRID * 3;
    const members = [];
    for (let i = 0; i < segs; i++) {
        members.push({ x1: xs[i], y1: ys[i], x2: xs[i+1], y2: ys[i+1], type: roadKey, group: "deck" });
    }
    // Braces: at each interior node, drop a strut down and tie to neighbours.
    for (let i = 1; i < segs; i++) {
        const bx = xs[i], by = ys[i] + depth;
        members.push({ x1: xs[i-1], y1: ys[i-1], x2: bx, y2: by, type: beamKey, group: "primary" });
        members.push({ x1: xs[i+1], y1: ys[i+1], x2: bx, y2: by, type: beamKey, group: "primary" });
    }
    return { archetype: "simple_supports", members };
}

// ─── ARCHETYPE: truss (Pratt-style) ─────────────────────────────
// One textbook truss section spanning anchor-to-anchor. Adaptive depth:
// tries 3-grid first, then 2, then 1, picking the deepest that fits budget.
function genTruss(lvl, lvlDef) {
    for (const depthCells of [3, 2, 1]) {
        const members = trussSection(lvl.lX, lvl.lY, lvl.rX, lvl.rY, lvlDef, depthCells);
        if (members.length > 0 && costOf(members) <= lvl.budget) {
            return { archetype: "truss", members };
        }
    }
    // Even depth=1 didn't fit — fall back to simple supports.
    return genSimpleSupports(lvl, lvlDef);
}

// Build a Pratt truss section between two arbitrary endpoints. Used both as
// the body of `genTruss` (whole-bridge) and for each half of `genBeamPier`
// (pier splits the bridge in two). Adaptively picks segment count + truss
// depth so every member stays within the beam material's maxLength even on
// sloped sections — sloped anchor diagonals get longer than flat ones.
//
// `options.above` flips the truss web ABOVE the deck (deck is bottom chord)
// instead of below — used by the truss_above variant.
function trussSection(startX, startY, endX, endY, lvlDef, depthCells = 3, options = {}) {
    const above = !!options.above;
    const beamKey = pickBeamKey(lvlDef);
    const roadKey = pickRoadKey(lvlDef);
    const roadMax = MATERIALS[roadKey].maxLength;
    const beamMax = MATERIALS[beamKey].maxLength;
    const gap = Math.abs(endX - startX);
    const hDiff = endY - startY;

    // Find the smallest segment count that keeps anchor diagonals within
    // beamMax. Sloped sections with longer cells push that diagonal over.
    let segs = Math.max(2, Math.ceil(gap / roadMax));
    let depth = GRID * depthCells;
    while (segs <= 12) {
        const cellLen = gap / segs;
        if (cellLen > roadMax) { segs++; continue; }
        const slopePerCell = Math.abs(hDiff) / segs;
        const anchorDiag = Math.hypot(cellLen, depth + slopePerCell);
        const interiorDiag = Math.hypot(cellLen, depth + slopePerCell * 2);
        if (anchorDiag <= beamMax && interiorDiag <= beamMax) break;
        segs++;
    }

    const xs = [], ys = [];
    for (let i = 0; i <= segs; i++) {
        xs.push(snap(startX + (endX - startX) * i / segs));
        ys.push(snap(startY + hDiff * i / segs));
    }
    xs[0] = startX; ys[0] = startY;
    xs[segs] = endX; ys[segs] = endY;

    const members = [];
    // Deck
    for (let i = 0; i < segs; i++) {
        members.push({ x1: xs[i], y1: ys[i], x2: xs[i+1], y2: ys[i+1], type: roadKey, group: "deck" });
    }
    if (segs < 2) return members; // single-segment span — no room for a truss

    // Off-chord nodes at interior deck x's. Sign chooses below (default) or above.
    const sign = above ? -1 : 1;
    const bx = xs.slice(1, segs);
    const by = ys.slice(1, segs).map(y => y + depth * sign);
    for (let i = 0; i < bx.length - 1; i++) {
        members.push({ x1: bx[i], y1: by[i], x2: bx[i+1], y2: by[i+1], type: beamKey, group: "primary" });
    }
    // Anchor diagonals (deck endpoints to outer off-chord nodes)
    members.push({ x1: xs[0],    y1: ys[0],    x2: bx[0],            y2: by[0],            type: beamKey, group: "primary" });
    members.push({ x1: xs[segs], y1: ys[segs], x2: bx[bx.length - 1], y2: by[by.length - 1], type: beamKey, group: "primary" });
    // Verticals at every interior node
    for (let i = 0; i < bx.length; i++) {
        members.push({ x1: xs[i+1], y1: ys[i+1], x2: bx[i], y2: by[i], type: beamKey, group: "connectors" });
    }
    // Diagonals — alternate per cell
    for (let i = 0; i < bx.length - 1; i++) {
        if (i % 2 === 0) {
            members.push({ x1: xs[i+1], y1: ys[i+1], x2: bx[i+1], y2: by[i+1], type: beamKey, group: "connectors" });
        } else {
            members.push({ x1: xs[i+2], y1: ys[i+2], x2: bx[i],   y2: by[i],   type: beamKey, group: "connectors" });
        }
    }
    return members;
}

// ─── ARCHETYPE: truss_above (top chord above the deck) ──────────────
// Same Pratt anatomy as genTruss but inverted — the deck is the bottom
// chord and the web rises above it. Reads like a classic through-truss
// railroad bridge.
function genTrussAbove(lvl, lvlDef) {
    for (const depthCells of [3, 2, 1]) {
        const members = trussSection(lvl.lX, lvl.lY, lvl.rX, lvl.rY, lvlDef, depthCells, { above: true });
        if (members.length > 0 && costOf(members) <= lvl.budget) {
            return { archetype: "truss_above", members };
        }
    }
    return genSimpleSupports(lvl, lvlDef);
}

// ─── ARCHETYPE: tied_arch / bowstring truss ─────────────────────────
// A parabolic top chord springs from each cliff anchor and rises above
// midspan. The deck is the TIE that resists the arch's outward thrust.
//
// When tension material (rope/cable) is available, the verticals are
// drawn as HANGERS — pure tension members pulling the deck up to the
// arch, exactly like a real tied-arch bridge with steel rod hangers.
// Otherwise verticals are beams. Either way, alternating beam diagonals
// fill every interior cell so the structure is fully triangulated and
// won't fold flat under load.
function genTiedArch(lvl, lvlDef) {
    const beamKey = pickBeamKey(lvlDef);
    const tensionKey = pickTensionKey(lvlDef);
    const { xs, ys, segs, roadKey } = deckPoints(lvl, lvlDef);
    if (segs < 3) return genSimpleSupports(lvl, lvlDef);
    const members = [];

    // 1. Deck (the tie)
    for (let i = 0; i < segs; i++) {
        members.push({ x1: xs[i], y1: ys[i], x2: xs[i+1], y2: ys[i+1], type: roadKey, group: "deck" });
    }

    // 2. Arched top chord — parabola from cliff to cliff, peaking above midspan.
    const archRise = GRID * 5;
    const x0 = xs[0], y0 = ys[0], xN = xs[segs], yN = ys[segs];
    const archYAt = (x) => {
        const t = (x - x0) / (xN - x0);
        const slopeY = y0 + (yN - y0) * t;
        return snap(slopeY - 4 * archRise * t * (1 - t));
    };
    const archPts = xs.map(x => ({ x, y: archYAt(x) }));
    archPts[0] = { x: x0, y: y0 };
    archPts[segs] = { x: xN, y: yN };
    for (let i = 0; i < segs; i++) {
        members.push({
            x1: archPts[i].x, y1: archPts[i].y,
            x2: archPts[i+1].x, y2: archPts[i+1].y,
            type: beamKey, group: "primary",
        });
    }

    // 3. Verticals at every interior node — rope hangers when tension material
    // is available (tied-arch with steel rod hangers in real engineering),
    // beams otherwise.
    const vertKey = tensionKey || beamKey;
    for (let i = 1; i < segs; i++) {
        const ap = archPts[i];
        if (ap.y >= ys[i] - GRID) continue;
        members.push({
            x1: ap.x, y1: ap.y, x2: xs[i], y2: ys[i],
            type: vertKey, group: "connectors",
        });
    }

    // 4. Diagonals through every interior cell. When verticals are ROPE
    // (compliant + tension-only) we need X-bracing so every deck node has
    // a beam-anchored path; when verticals are BEAM (rigid both ways) a
    // single alternating diagonal per cell is enough and saves budget on
    // smaller levels.
    const useXBrace = !!tensionKey;
    for (let i = 1; i <= segs - 2; i++) {
        if (useXBrace) {
            members.push({
                x1: xs[i], y1: ys[i], x2: archPts[i+1].x, y2: archPts[i+1].y,
                type: beamKey, group: "connectors",
            });
            members.push({
                x1: xs[i+1], y1: ys[i+1], x2: archPts[i].x, y2: archPts[i].y,
                type: beamKey, group: "connectors",
            });
        } else if (i % 2 === 0) {
            members.push({
                x1: xs[i], y1: ys[i], x2: archPts[i+1].x, y2: archPts[i+1].y,
                type: beamKey, group: "connectors",
            });
        } else {
            members.push({
                x1: xs[i+1], y1: ys[i+1], x2: archPts[i].x, y2: archPts[i].y,
                type: beamKey, group: "connectors",
            });
        }
    }

    return { archetype: "tied_arch", members };
}

// ─── ARCHETYPE: arch_deck (deck arch — arch sweeps below the deck) ──
// Classic stone-arch / Sydney-Harbour style. The arch springs from each
// cliff anchor and curves DOWNWARD beneath the deck. Verticals push the
// deck's load down onto the arch, which carries it in compression to
// the abutments. X-bracing in every cell so the structure is fully
// triangulated even with pin-jointed XPBD constraints.
function genArchDeck(lvl, lvlDef) {
    const beamKey = pickBeamKey(lvlDef);
    const { xs, ys, segs, roadKey } = deckPoints(lvl, lvlDef);
    if (segs < 3) return genSimpleSupports(lvl, lvlDef);
    const members = [];

    // 1. Deck (the load-bearing surface)
    for (let i = 0; i < segs; i++) {
        members.push({ x1: xs[i], y1: ys[i], x2: xs[i+1], y2: ys[i+1], type: roadKey, group: "deck" });
    }

    // 2. Arch — parabola curving DOWN from each cliff anchor.
    const archDrop = GRID * 5;
    const x0 = xs[0], y0 = ys[0], xN = xs[segs], yN = ys[segs];
    const archYAt = (x) => {
        const t = (x - x0) / (xN - x0);
        const slopeY = y0 + (yN - y0) * t;
        return snap(slopeY + 4 * archDrop * t * (1 - t));
    };
    const archPts = xs.map(x => ({ x, y: archYAt(x) }));
    archPts[0] = { x: x0, y: y0 };
    archPts[segs] = { x: xN, y: yN };
    for (let i = 0; i < segs; i++) {
        members.push({
            x1: archPts[i].x, y1: archPts[i].y,
            x2: archPts[i+1].x, y2: archPts[i+1].y,
            type: beamKey, group: "primary",
        });
    }

    // 3. Verticals from each deck node down to its corresponding arch node.
    for (let i = 1; i < segs; i++) {
        const ap = archPts[i];
        if (ap.y <= ys[i] + GRID) continue;
        members.push({
            x1: xs[i], y1: ys[i], x2: ap.x, y2: ap.y,
            type: beamKey, group: "connectors",
        });
    }

    // 4. Alternating diagonals through every interior cell. Beams in both
    // directions, so single diagonal per cell is enough to triangulate.
    for (let i = 1; i <= segs - 2; i++) {
        if (i % 2 === 0) {
            members.push({
                x1: xs[i], y1: ys[i], x2: archPts[i+1].x, y2: archPts[i+1].y,
                type: beamKey, group: "connectors",
            });
        } else {
            members.push({
                x1: xs[i+1], y1: ys[i+1], x2: archPts[i].x, y2: archPts[i].y,
                type: beamKey, group: "connectors",
            });
        }
    }

    return { archetype: "arch_deck", members };
}

// ─── ARCHETYPE: cable_stayed (fan stays from tower) ─────────────────
// Each high tower fans straight stay-cables out to deck nodes on its
// half of the bridge. Stiffening truss sits beneath the deck so the
// stays only have to handle gravity, not bending. Needs at least one
// high tower anchor.
function genCableStayed(lvl, lvlDef) {
    const tensionKey = pickTensionKey(lvlDef);
    if (!tensionKey) return genTruss(lvl, lvlDef);
    const beamKey = pickBeamKey(lvlDef);
    const anchors = getAnchors(lvl, lvlDef);
    const highL = anchors.find(a => a.side === "L" && a.y < lvl.lY);
    const highR = anchors.find(a => a.side === "R" && a.y < lvl.rY);
    if (!highL && !highR) return genTruss(lvl, lvlDef);

    const { xs, ys, segs, roadKey } = deckPoints(lvl, lvlDef);
    const members = [];

    // 1. Deck (also the bottom chord of a stiffening truss)
    for (let i = 0; i < segs; i++) {
        members.push({ x1: xs[i], y1: ys[i], x2: xs[i+1], y2: ys[i+1], type: roadKey, group: "deck" });
    }

    // 2. Stays fanning out from each tower. With both towers, each handles
    // its own half; with one, it covers the whole deck.
    const tensionMax = MATERIALS[tensionKey].maxLength;
    for (let i = 1; i < segs; i++) {
        let tower;
        if (highL && highR) {
            tower = (xs[i] - highL.x) <= (highR.x - xs[i]) ? highL : highR;
        } else {
            tower = highL || highR;
        }
        if (tower.y >= ys[i]) continue;
        const stayLen = Math.hypot(xs[i] - tower.x, ys[i] - tower.y);
        if (stayLen > tensionMax) continue;
        members.push({
            x1: tower.x, y1: tower.y, x2: xs[i], y2: ys[i],
            type: tensionKey, group: "primary",
        });
    }

    // 3. Stiffening truss anchored at cliffs (same anatomy as suspension).
    const trussDepth = GRID * 2;
    const bx = xs.slice(1, segs);
    const by = ys.slice(1, segs).map(y => y + trussDepth);
    for (let i = 0; i < bx.length - 1; i++) {
        members.push({ x1: bx[i], y1: by[i], x2: bx[i+1], y2: by[i+1], type: beamKey, group: "primary" });
    }
    if (bx.length > 0) {
        members.push({ x1: xs[0],    y1: ys[0],    x2: bx[0],            y2: by[0],            type: beamKey, group: "primary" });
        members.push({ x1: xs[segs], y1: ys[segs], x2: bx[bx.length - 1], y2: by[by.length - 1], type: beamKey, group: "primary" });
    }
    for (let i = 0; i < bx.length; i++) {
        members.push({ x1: xs[i+1], y1: ys[i+1], x2: bx[i], y2: by[i], type: beamKey, group: "connectors" });
    }
    for (let i = 0; i < bx.length - 1; i++) {
        if (i % 2 === 0) {
            members.push({ x1: xs[i+1], y1: ys[i+1], x2: bx[i+1], y2: by[i+1], type: beamKey, group: "connectors" });
        } else {
            members.push({ x1: xs[i+2], y1: ys[i+2], x2: bx[i],   y2: by[i],   type: beamKey, group: "connectors" });
        }
    }

    return { archetype: "cable_stayed", members };
}

// ─── ARCHETYPE: beam-pier (mid-gap rock) ────────────────────────
// Two Pratt half-trusses meeting at the pier — each half is anchored at one
// cliff and at the pier. The pier itself sits below the deck, connected by a
// vertical strut. This gives a textbook "two-span continuous truss" anatomy
// instead of just a deck with a tepee under the middle.
function genBeamPier(lvl, lvlDef) {
    const beamKey = pickBeamKey(lvlDef);
    const anchors = getAnchors(lvl, lvlDef);
    const mid = anchors.find(a => a.side === "MID");
    if (!mid) return genTruss(lvl, lvlDef);

    // Deck level above the pier — slope-interpolated and grid-snapped.
    const deckAtPierY = snap(lvl.lY + lvl.hDiff * (mid.x - lvl.lX) / lvl.gap);

    const members = [];
    // Pier strut: vertical from pier anchor up to the deck.
    members.push({
        x1: mid.x, y1: mid.y, x2: mid.x, y2: deckAtPierY,
        type: beamKey, group: "primary",
    });
    // Left & right half-trusses share the pier-deck node as their inner anchor.
    members.push(...trussSection(lvl.lX, lvl.lY, mid.x, deckAtPierY, lvlDef));
    members.push(...trussSection(mid.x, deckAtPierY, lvl.rX, lvl.rY, lvlDef));
    return { archetype: "beam_pier", members };
}

// ─── ARCHETYPE: suspension (high towers) ────────────────────────
// Real suspension anatomy: the deck hangs from a parabolic main cable
// between two high tower anchors, AND a Pratt-style stiffening truss runs
// the length of the deck with its bottom chord anchored at both cliffs.
// The cable handles gravity load (deck sags toward midspan, cable pulls
// back up via hangers); the stiffening truss handles bending — it's what
// keeps the road from acting like a single bowstring under a heavy vehicle.
//
// Without the anchored truss, the road takes all the bending load itself
// because the cable+hangers only support discrete points. That's the
// "all the strain on the road, none on the beams" failure mode.
function genSuspension(lvl, lvlDef) {
    const tensionKey = pickTensionKey(lvlDef);
    if (!tensionKey) return genTruss(lvl, lvlDef);
    const beamKey = pickBeamKey(lvlDef);
    const anchors = getAnchors(lvl, lvlDef);
    const highL = anchors.find(a => a.side === "L" && a.y < lvl.lY);
    const highR = anchors.find(a => a.side === "R" && a.y < lvl.rY);
    if (!highL || !highR) return genTruss(lvl, lvlDef);

    const { xs, ys, segs, roadKey } = deckPoints(lvl, lvlDef);
    const members = [];

    // ─── 1. Deck (top chord of the stiffening truss) ────────
    for (let i = 0; i < segs; i++) {
        members.push({ x1: xs[i], y1: ys[i], x2: xs[i+1], y2: ys[i+1], type: roadKey, group: "deck" });
    }

    // ─── 2. Stiffening truss — bottom chord + web, anchored at cliffs ──
    // This is the load distributor. With it, the deck behaves as a stiff
    // girder rather than a floppy chain of road segments.
    const trussDepth = GRID * 2;
    const bx = xs.slice(1, segs);
    const by = ys.slice(1, segs).map(y => y + trussDepth);
    // Bottom chord between interior nodes.
    for (let i = 0; i < bx.length - 1; i++) {
        members.push({ x1: bx[i], y1: by[i], x2: bx[i+1], y2: by[i+1], type: beamKey, group: "primary" });
    }
    // Anchor diagonals — outermost bottom-chord nodes back to each cliff anchor.
    if (bx.length > 0) {
        members.push({ x1: xs[0],    y1: ys[0],    x2: bx[0],            y2: by[0],            type: beamKey, group: "primary" });
        members.push({ x1: xs[segs], y1: ys[segs], x2: bx[bx.length - 1], y2: by[by.length - 1], type: beamKey, group: "primary" });
    }
    // Verticals at every interior deck node.
    for (let i = 0; i < bx.length; i++) {
        members.push({ x1: xs[i+1], y1: ys[i+1], x2: bx[i], y2: by[i], type: beamKey, group: "connectors" });
    }
    // Alternating diagonals through each cell so triangles don't all lean
    // the same way (Warren-style web).
    for (let i = 0; i < bx.length - 1; i++) {
        if (i % 2 === 0) {
            members.push({ x1: xs[i+1], y1: ys[i+1], x2: bx[i+1], y2: by[i+1], type: beamKey, group: "connectors" });
        } else {
            members.push({ x1: xs[i+2], y1: ys[i+2], x2: bx[i],   y2: by[i],   type: beamKey, group: "connectors" });
        }
    }

    // ─── 3. Main suspension cable — parabolic curve between high towers ──
    const cableSpan = highR.x - highL.x;
    const towerY = (highL.y + highR.y) / 2;
    const deckMidY = lvl.lY + lvl.hDiff / 2;
    const cableBulge = Math.max(GRID * 2, deckMidY - towerY - GRID * 2);
    const cableYAt = (x) => {
        const t = (x - highL.x) / cableSpan;
        return snap(towerY + 4 * cableBulge * t * (1 - t));
    };

    const cablePts = [{ x: highL.x, y: highL.y }];
    for (let i = 0; i <= segs; i++) {
        cablePts.push({ x: xs[i], y: cableYAt(xs[i]) });
    }
    cablePts.push({ x: highR.x, y: highR.y });

    for (let i = 0; i < cablePts.length - 1; i++) {
        members.push({
            x1: cablePts[i].x, y1: cablePts[i].y,
            x2: cablePts[i+1].x, y2: cablePts[i+1].y,
            type: tensionKey, group: "primary",
        });
    }

    // ─── 4. Vertical hangers from cable to interior deck nodes ─────
    for (let i = 1; i < segs; i++) {
        const cp = cablePts[i + 1];
        if (cp.y >= ys[i] - GRID) continue;
        members.push({
            x1: cp.x, y1: cp.y, x2: xs[i], y2: ys[i],
            type: tensionKey, group: "primary",
        });
    }

    return { archetype: "suspension", members };
}

// Compute every archetype that's compatible with the level's anchor layout
// and material list. The "Show me a bridge" flow picks one at random from
// this set, so the same level produces a different design each time.
export function validArchetypes(lvl, lvlDef) {
    const anchors = getAnchors(lvl, lvlDef);
    const hasMid   = anchors.some(a => a.side === "MID");
    const hasHighL = anchors.some(a => a.side === "L" && a.y < lvl.lY);
    const hasHighR = anchors.some(a => a.side === "R" && a.y < lvl.rY);
    const hasTension = !!pickTensionKey(lvlDef);

    // Mid-pier levels demand a pier-aware design — other archetypes would
    // ignore the pier.
    if (hasMid) return ["beam_pier"];

    // High-anchor levels (towers exist + tension material exists) are tuned
    // for suspension-style designs. Their budgets assume the cable / stays
    // are doing the heavy lifting; a basic full-deck truss tends to overspend
    // and fail to clear the heavy vehicle these levels typically use.
    if ((hasHighL || hasHighR) && hasTension) {
        const options = ["tied_arch"];
        if (hasHighL && hasHighR) options.push("suspension");
        options.push("cable_stayed");
        return options;
    }

    // Standard cliff-to-cliff levels: classic truss + arch family.
    return ["truss", "truss_above", "tied_arch", "arch_deck"];
}

// Single-archetype pick. Random across the valid set so successive AI helper
// invocations give the player different designs to learn from.
export function pickArchetype(lvl, lvlDef) {
    const opts = validArchetypes(lvl, lvlDef);
    return opts[Math.floor(Math.random() * opts.length)];
}

function generateOne(lvl, lvlDef, archetype) {
    switch (archetype) {
        case "beam_pier":     return genBeamPier(lvl, lvlDef);
        case "suspension":    return genSuspension(lvl, lvlDef);
        case "truss_above":   return genTrussAbove(lvl, lvlDef);
        case "tied_arch":     return genTiedArch(lvl, lvlDef);
        case "arch_deck":     return genArchDeck(lvl, lvlDef);
        case "cable_stayed":  return genCableStayed(lvl, lvlDef);
        case "truss":         return genTruss(lvl, lvlDef);
        case "simple_supports":
        default:              return genSimpleSupports(lvl, lvlDef);
    }
}

export function generateSkeleton(lvl, lvlDef, archetype = null) {
    archetype = archetype || pickArchetype(lvl, lvlDef);
    let result = generateOne(lvl, lvlDef, archetype);
    // If the random pick blew the budget, try other valid archetypes before
    // collapsing to simple_supports. Keeps variety high while still safe.
    if (costOf(result.members) > lvl.budget && result.archetype !== "simple_supports") {
        for (const alt of validArchetypes(lvl, lvlDef)) {
            if (alt === archetype) continue;
            const tryAlt = generateOne(lvl, lvlDef, alt);
            if (costOf(tryAlt.members) <= lvl.budget) { result = tryAlt; break; }
        }
    }
    if (costOf(result.members) > lvl.budget && result.archetype !== "simple_supports") {
        const fallback = genSimpleSupports(lvl, lvlDef);
        if (costOf(fallback.members) < costOf(result.members)) result = fallback;
    }
    return result;
}

// Group members by their `group` tag, in build order: deck → primary → connectors.
export function groupIntoSteps(skeleton) {
    const buckets = { deck: [], primary: [], connectors: [] };
    for (const m of skeleton.members) {
        (buckets[m.group] || buckets.connectors).push(m);
    }
    const steps = [];
    if (buckets.deck.length)       steps.push({ slot: "deck",       members: buckets.deck });
    if (buckets.primary.length)    steps.push({ slot: "primary",    members: buckets.primary });
    if (buckets.connectors.length) steps.push({ slot: "connectors", members: buckets.connectors });
    return steps;
}

// Plain-English description of what each slot represents per archetype —
// used by the narrative prompt so the LLM knows which step is which.
export function slotDescriptions(archetype) {
    switch (archetype) {
        case "truss":
            return {
                deck:       "lay the road across the gap",
                primary:    "build the bottom chord and tie it back to both anchors",
                connectors: "add verticals and diagonals to triangulate every cell",
            };
        case "beam_pier":
            return {
                deck:       "lay the deck across both spans (cliff → pier → cliff)",
                primary:    "raise a vertical strut from the pier and run a bottom chord under each half-span back to its anchor",
                connectors: "add verticals and diagonals to triangulate every cell of both half-trusses",
            };
        case "suspension":
            return {
                deck:       "lay the road between the cliff anchors",
                primary:    "stretch a curved main cable between the two high towers (sagging down toward midspan), and run a stiffening truss along the deck",
                connectors: "drop vertical hangers from the cable to each deck node, and triangulate the truss web underneath",
            };
        case "truss_above":
            return {
                deck:       "lay the deck — this is the bottom chord of the truss",
                primary:    "build a top chord above the deck and tie it back to both anchors",
                connectors: "add verticals and diagonals between the deck and the top chord to triangulate every cell",
            };
        case "tied_arch":
            return {
                deck:       "lay the deck — it's the TIE that holds the arch's outward thrust in tension",
                primary:    "build an arched top chord that springs from each cliff anchor and rises above midspan",
                connectors: "drop verticals at every interior node and add alternating diagonals through each cell so the arch+deck rectangles become triangulated (this is what makes it a bowstring TRUSS, not a flopping arch)",
            };
        case "arch_deck":
            return {
                deck:       "lay the deck across the gap",
                primary:    "build an arch that springs from each cliff anchor and curves DOWN below the deck — this is the main load-bearing curve, working purely in compression",
                connectors: "drop verticals from each deck node onto the arch and add diagonal bracing through every cell to triangulate the structure",
            };
        case "cable_stayed":
            return {
                deck:       "lay the deck across both cliff anchors",
                primary:    "fan straight stay-cables from each high tower to the deck nodes on its side, and run a stiffening truss along the deck",
                connectors: "triangulate the truss web with verticals and diagonals",
            };
        case "simple_supports":
        default:
            return {
                deck:       "lay the road across the gap",
                primary:    "place beams below the deck to hold it up",
                connectors: "",
            };
    }
}

// Structural analysis of the player's bridge — used by the "Coach my build"
// mode to give the LLM grounded facts (instead of just member counts) so its
// tips reference what's actually there. Generic LLM advice without this
// hallucinates ("add triangulation" on a fully triangulated bridge).
export function buildPlayerDigest(lvl, lvlDef, players) {
    const { members = [] } = players || {};
    const placed = members.filter(m => !m.builtin && !m.broken);

    // ─── Material counts ──────────────────────────────────
    const matCounts = {};
    for (const m of placed) matCounts[m.type] = (matCounts[m.type] || 0) + 1;
    const matStr = Object.entries(matCounts).length
        ? Object.entries(matCounts).map(([k, n]) => `${n}× ${MATERIALS[k]?.label || k}`).join(", ")
        : "(none yet)";

    // ─── Cost so far ──────────────────────────────────────
    const totalCost = costOf(placed.map(m => ({
        x1: m.n1.x, y1: m.n1.y, x2: m.n2.x, y2: m.n2.y, type: m.type,
    })));

    // ─── Adjacency graphs ─────────────────────────────────
    // adjAll: every placed member (road + structural)
    // adjStruct: structural-only (beams + cables, no road)
    const key = (x, y) => `${x},${y}`;
    const adjAll = new Map();
    const adjStruct = new Map();
    const addEdge = (g, a, b) => {
        if (!g.has(a)) g.set(a, new Set());
        if (!g.has(b)) g.set(b, new Set());
        g.get(a).add(b);
        g.get(b).add(a);
    };
    const roadEdges = new Set();
    const structEdges = new Set();
    for (const m of placed) {
        const a = key(m.n1.x, m.n1.y), b = key(m.n2.x, m.n2.y);
        const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
        addEdge(adjAll, a, b);
        if (MATERIALS[m.type]?.isRoad) roadEdges.add(edge);
        else { addEdge(adjStruct, a, b); structEdges.add(edge); }
    }

    // ─── Road continuity ──────────────────────────────────
    const startKey = key(lvl.lX, lvl.lY);
    const endKey   = key(lvl.rX, lvl.rY);
    const reachableByRoad = new Set([startKey]);
    {
        const q = [startKey];
        while (q.length) {
            const cur = q.shift();
            for (const nb of adjAll.get(cur) || []) {
                const e = cur < nb ? `${cur}|${nb}` : `${nb}|${cur}`;
                if (roadEdges.has(e) && !reachableByRoad.has(nb)) {
                    reachableByRoad.add(nb);
                    q.push(nb);
                }
            }
        }
    }
    const roadConnected = reachableByRoad.has(endKey);

    // ─── Triangle count (in any 3-cycle of placed members) ─
    // A triangle is a set of three nodes pairwise connected. Count each
    // triangle once by sorting node keys.
    const triangles = new Set();
    for (const [a, neighbors] of adjAll) {
        for (const b of neighbors) {
            if (b <= a) continue;
            for (const c of neighbors) {
                if (c <= b) continue;
                if (adjAll.get(b)?.has(c)) {
                    triangles.add([a, b, c].join("|"));
                }
            }
        }
    }
    const triangleCount = triangles.size;

    // ─── Structural anchorage ─────────────────────────────
    // A "structural anchor" is a fixed cliff anchor. Walk the structural-only
    // graph from each cliff anchor — nodes reachable that way are anchored;
    // structural members between un-anchored nodes are "floating".
    const cliffAnchors = [key(lvl.lX, lvl.lY), key(lvl.rX, lvl.rY)];
    if (lvlDef.extraAnchors) {
        for (const a of lvlDef.extraAnchors) {
            let x, y;
            if (a.side === "L")      { x = lvl.lX + a.dx;   y = lvl.lY + a.dy; }
            else if (a.side === "R") { x = lvl.rX + a.dx;   y = lvl.rY + a.dy; }
            else                     { x = lvl.midX + a.dx; y = lvl.lY + a.dy; }
            cliffAnchors.push(key(snap(x), snap(y)));
        }
    }
    const anchored = new Set(cliffAnchors);
    {
        const q = [...cliffAnchors];
        while (q.length) {
            const cur = q.shift();
            for (const nb of adjStruct.get(cur) || []) {
                if (!anchored.has(nb)) { anchored.add(nb); q.push(nb); }
            }
        }
    }
    let floatingStructuralMembers = 0;
    for (const m of placed) {
        if (MATERIALS[m.type]?.isRoad) continue;
        const a = key(m.n1.x, m.n1.y), b = key(m.n2.x, m.n2.y);
        if (!anchored.has(a) || !anchored.has(b)) floatingStructuralMembers++;
    }

    // ─── Deck-node support ────────────────────────────────
    // For every interior node along the road chain, count how many structural
    // (non-road) beams touch it. Zero = the deck rests on nothing there.
    const deckY = lvl.lY;
    const deckNodes = [];
    for (const nodeKey of reachableByRoad) {
        const [xs, ys] = nodeKey.split(",").map(Number);
        deckNodes.push({ x: xs, y: ys, k: nodeKey });
    }
    let interiorDeckNodes = 0;
    let unsupportedDeckNodes = 0;
    for (const dn of deckNodes) {
        if (dn.k === startKey || dn.k === endKey) continue;
        interiorDeckNodes++;
        const struct = adjStruct.get(dn.k);
        if (!struct || struct.size === 0) unsupportedDeckNodes++;
    }

    // ─── Chord detection ──────────────────────────────────
    // A chord is a structural member running roughly horizontally. We split
    // them into above-deck (top chord) and below-deck (bottom chord).
    let hasTopChord = false, hasBottomChord = false;
    for (const m of placed) {
        if (MATERIALS[m.type]?.isRoad) continue;
        const dx = Math.abs(m.n2.x - m.n1.x);
        const dy = Math.abs(m.n2.y - m.n1.y);
        // horizontal-ish: |dx| > |dy|, and at least one grid horizontal span
        if (dx <= GRID || dx <= dy) continue;
        const midY = (m.n1.y + m.n2.y) / 2;
        if (midY < deckY - 1) hasTopChord = true;
        else if (midY > deckY + 1) hasBottomChord = true;
    }

    const archetype = generateSkeleton(lvl, lvlDef).archetype;
    const wellTriangulated = interiorDeckNodes === 0
        ? true
        : triangleCount >= Math.max(1, interiorDeckNodes - 1);

    return {
        archetype,
        materialsUsed: matStr,
        totalCost,
        budget: lvl.budget,
        roadConnected,
        memberCount: placed.length,
        nonRoadCount: placed.filter(m => !MATERIALS[m.type]?.isRoad).length,
        // structural facts
        triangleCount,
        wellTriangulated,
        hasTopChord,
        hasBottomChord,
        interiorDeckNodes,
        unsupportedDeckNodes,
        floatingStructuralMembers,
    };
}
