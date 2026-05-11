import { describe, it, expect } from "vitest";
import { generateSkeleton, pickArchetype, validArchetypes, groupIntoSteps, buildPlayerDigest } from "../src/aiSkeleton.js";
import { MATERIALS, GRID } from "../src/constants.js";

const FLAT_LVL = {
    lX: 180, lY: 396,
    rX: 540, rY: 396,
    midX: 360,
    gap: 360, hDiff: 0,
    budget: 7000,
    terrain: "canyon",
    vType: "car",
};
const FLAT_DEF = {
    name: "FLAT",
    concept: "BASICS",
    difficulty: 1,
    materials: ["wood_road", "wood_beam"],
    extraAnchors: [],
};

const PIER_LVL = {
    lX: 180, lY: 396,
    rX: 720, rY: 324,
    midX: 450,
    gap: 540, hDiff: -72,
    budget: 13000,
    terrain: "gorge",
    vType: "jeep",
};
const PIER_DEF = {
    name: "PIER",
    concept: "PIERS",
    difficulty: 2,
    materials: ["wood_road", "wood_beam"],
    extraAnchors: [{ side: "MID", dx: -72, dy: 36 }],
};

const SUSP_LVL = {
    lX: 180, lY: 396,
    rX: 648, rY: 396,
    midX: 414,
    gap: 468, hDiff: 0,
    budget: 16000,
    terrain: "canyon",
    vType: "camper",
};
const SUSP_DEF = {
    name: "SUSP",
    concept: "TENSION",
    difficulty: 3,
    materials: ["wood_road", "wood_beam", "rope"],
    extraAnchors: [
        { side: "L", dx: -36, dy: -144 },
        { side: "R", dx:  36, dy: -144 },
    ],
};

describe("pickArchetype / validArchetypes", () => {
    it("forces beam_pier when there's a mid-gap anchor", () => {
        expect(validArchetypes(PIER_LVL, PIER_DEF)).toEqual(["beam_pier"]);
        expect(pickArchetype(PIER_LVL, PIER_DEF)).toBe("beam_pier");
    });
    it("offers suspension-class variants when both cliffs have high anchors and tension is allowed", () => {
        const opts = validArchetypes(SUSP_LVL, SUSP_DEF);
        expect(opts).toContain("suspension");
        expect(opts).toContain("cable_stayed");
        expect(opts).toContain("tied_arch");
        expect(opts).not.toContain("truss"); // basic trusses excluded on suspension levels
    });
    it("offers the truss + arch family on standard cliff-to-cliff levels", () => {
        const opts = validArchetypes(FLAT_LVL, FLAT_DEF);
        expect(opts).toContain("truss");
        expect(opts).toContain("truss_above");
        expect(opts).toContain("tied_arch");
        expect(opts).toContain("arch_deck");
    });
    it("pickArchetype returns one of the valid options", () => {
        const opts = validArchetypes(FLAT_LVL, FLAT_DEF);
        for (let i = 0; i < 20; i++) {
            expect(opts).toContain(pickArchetype(FLAT_LVL, FLAT_DEF));
        }
    });
});

describe("generateSkeleton", () => {
    it("produces a road chain from left anchor to right anchor", () => {
        const sk = generateSkeleton(FLAT_LVL, FLAT_DEF);
        const roadKeys = new Set(FLAT_DEF.materials.filter(k => MATERIALS[k].isRoad));
        const adj = new Map();
        const key = (x, y) => `${x},${y}`;
        for (const m of sk.members) {
            if (!roadKeys.has(m.type)) continue;
            const a = key(m.x1, m.y1), b = key(m.x2, m.y2);
            if (!adj.has(a)) adj.set(a, new Set());
            if (!adj.has(b)) adj.set(b, new Set());
            adj.get(a).add(b);
            adj.get(b).add(a);
        }
        const start = key(FLAT_LVL.lX, FLAT_LVL.lY);
        const end   = key(FLAT_LVL.rX, FLAT_LVL.rY);
        const visited = new Set([start]);
        const queue = [start];
        let connected = false;
        while (queue.length) {
            const cur = queue.shift();
            if (cur === end) { connected = true; break; }
            for (const nb of adj.get(cur) || []) if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
        }
        expect(connected).toBe(true);
    });

    it("respects the level's allowed materials list", () => {
        const sk = generateSkeleton(SUSP_LVL, SUSP_DEF);
        const allowed = new Set(SUSP_DEF.materials);
        for (const m of sk.members) {
            expect(allowed.has(m.type)).toBe(true);
        }
    });

    it("snaps every coordinate to the grid", () => {
        const sk = generateSkeleton(PIER_LVL, PIER_DEF);
        for (const m of sk.members) {
            expect(m.x1 % GRID).toBe(0);
            expect(m.y1 % GRID).toBe(0);
            expect(m.x2 % GRID).toBe(0);
            expect(m.y2 % GRID).toBe(0);
        }
    });

    it("never exceeds the level budget for the chosen archetype", () => {
        for (const [lvl, def] of [[FLAT_LVL, FLAT_DEF], [PIER_LVL, PIER_DEF], [SUSP_LVL, SUSP_DEF]]) {
            const sk = generateSkeleton(lvl, def);
            const cost = sk.members.reduce((sum, m) => {
                const mat = MATERIALS[m.type];
                const len = Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
                return sum + len * mat.price / 10;
            }, 0);
            expect(cost).toBeLessThanOrEqual(lvl.budget);
        }
    });

    it("uses the mid pier as a node on beam_pier levels", () => {
        const sk = generateSkeleton(PIER_LVL, PIER_DEF);
        const pierX = Math.round((PIER_LVL.midX + PIER_DEF.extraAnchors[0].dx) / GRID) * GRID;
        const pierY = Math.round((PIER_LVL.lY + PIER_DEF.extraAnchors[0].dy) / GRID) * GRID;
        const pierKey = `${pierX},${pierY}`;
        const seen = sk.members.some(m =>
            `${m.x1},${m.y1}` === pierKey || `${m.x2},${m.y2}` === pierKey
        );
        expect(seen).toBe(true);
    });

    it("groups members into deck → primary → connectors steps", () => {
        const sk = generateSkeleton(SUSP_LVL, SUSP_DEF);
        const steps = groupIntoSteps(sk);
        expect(steps.length).toBeGreaterThanOrEqual(2);
        expect(steps[0].slot).toBe("deck");
    });
});

describe("buildPlayerDigest", () => {
    it("reports an empty build", () => {
        const d = buildPlayerDigest(FLAT_LVL, FLAT_DEF, { members: [], nodes: [] });
        expect(d.memberCount).toBe(0);
        expect(d.roadConnected).toBe(false);
        expect(d.triangleCount).toBe(0);
    });

    it("reports cost & material counts for placed members", () => {
        const n1 = { x: FLAT_LVL.lX, y: FLAT_LVL.lY };
        const n2 = { x: FLAT_LVL.lX + 36, y: FLAT_LVL.lY };
        const fakeMember = { n1, n2, type: "wood_road", builtin: false };
        const d = buildPlayerDigest(FLAT_LVL, FLAT_DEF, { members: [fakeMember], nodes: [n1, n2] });
        expect(d.memberCount).toBe(1);
        expect(d.totalCost).toBeGreaterThan(0);
    });

    it("detects a triangle formed by two beams + a road segment", () => {
        // Three nodes forming a triangle: two deck nodes + one apex above.
        const a = { x: FLAT_LVL.lX,        y: FLAT_LVL.lY };
        const b = { x: FLAT_LVL.lX + 72,   y: FLAT_LVL.lY };
        const c = { x: FLAT_LVL.lX + 36,   y: FLAT_LVL.lY - 36 };
        const members = [
            { n1: a, n2: b, type: "wood_road", builtin: false },
            { n1: a, n2: c, type: "wood_beam", builtin: false },
            { n1: b, n2: c, type: "wood_beam", builtin: false },
        ];
        const d = buildPlayerDigest(FLAT_LVL, FLAT_DEF, { members, nodes: [a, b, c] });
        expect(d.triangleCount).toBe(1);
    });

    it("flags floating structural members not connected to any anchor", () => {
        // Two beams forming an isolated triangle far from any anchor.
        const a = { x: FLAT_LVL.lX + 100,  y: FLAT_LVL.lY - 100 };
        const b = { x: FLAT_LVL.lX + 150,  y: FLAT_LVL.lY - 100 };
        const c = { x: FLAT_LVL.lX + 125,  y: FLAT_LVL.lY - 60 };
        const members = [
            { n1: a, n2: b, type: "wood_beam", builtin: false },
            { n1: a, n2: c, type: "wood_beam", builtin: false },
            { n1: b, n2: c, type: "wood_beam", builtin: false },
        ];
        const d = buildPlayerDigest(FLAT_LVL, FLAT_DEF, { members, nodes: [a, b, c] });
        expect(d.floatingStructuralMembers).toBe(3);
    });
});
