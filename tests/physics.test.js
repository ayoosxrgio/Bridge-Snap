import { describe, it, expect } from "vitest";
import { Node, Member, snapToGrid, distToSegment, isConnectedToAnchor, calcCost } from "../src/physics.js";
import { GRID, MATERIALS } from "../src/constants.js";

describe("snapToGrid", () => {
    it("snaps to nearest grid multiple", () => {
        expect(snapToGrid(5, 7)).toEqual({ x: 0, y: GRID });
        expect(snapToGrid(GRID + 1, GRID * 2 - 1)).toEqual({ x: GRID, y: GRID * 2 });
    });

    it("handles negative coordinates", () => {
        const s1 = snapToGrid(-1, -1);
        // `+0` normalizes -0 to 0 (both are valid grid origin)
        expect(s1.x + 0).toBe(0);
        expect(s1.y + 0).toBe(0);
        // -GRID * 1.5 - 1 = -19 → rounds to -2 → -24
        expect(snapToGrid(-GRID * 1.5 - 1, -GRID * 1.5 - 1)).toEqual({ x: -GRID * 2, y: -GRID * 2 });
    });

    it("snaps to anchor when within 0.8 * GRID of one", () => {
        const anchor = { x: 100, y: 100 };
        const snapped = snapToGrid(100 + GRID * 0.5, 100 + GRID * 0.5, [anchor]);
        expect(snapped).toEqual({ x: 100, y: 100 });
    });

    it("falls through to grid when anchor is too far", () => {
        const anchor = { x: 100, y: 100 };
        const snapped = snapToGrid(500, 500, [anchor]);
        expect(snapped.x).not.toBe(100);
        expect(snapped.x % GRID).toBe(0);
        expect(snapped.y % GRID).toBe(0);
    });
});

describe("distToSegment", () => {
    const v = { x: 0, y: 0 };
    const w = { x: 10, y: 0 };

    it("returns 0 when point lies on segment", () => {
        expect(distToSegment({ x: 5, y: 0 }, v, w)).toBe(0);
    });

    it("measures perpendicular distance when projection falls inside segment", () => {
        expect(distToSegment({ x: 5, y: 3 }, v, w)).toBeCloseTo(3);
    });

    it("clamps to endpoint when projection falls past w", () => {
        expect(distToSegment({ x: 20, y: 0 }, v, w)).toBe(10);
    });

    it("clamps to endpoint when projection falls before v", () => {
        expect(distToSegment({ x: -5, y: 0 }, v, w)).toBe(5);
    });

    it("handles zero-length segment", () => {
        expect(distToSegment({ x: 3, y: 4 }, v, v)).toBe(5);
    });
});

describe("isConnectedToAnchor", () => {
    it("returns true for an anchor node itself", () => {
        const anchor = new Node(0, 0, true);
        const free = new Node(GRID, 0);
        const nodes = [anchor, free];
        const members = [new Member(anchor, free, "wood_beam")];
        expect(isConnectedToAnchor(nodes, members, 0, 0)).toBe(true);
    });

    it("returns true for a node transitively connected to an anchor", () => {
        const anchor = new Node(0, 0, true);
        const mid = new Node(GRID, 0);
        const far = new Node(GRID * 2, 0);
        const nodes = [anchor, mid, far];
        const members = [
            new Member(anchor, mid, "wood_beam"),
            new Member(mid, far, "wood_beam"),
        ];
        expect(isConnectedToAnchor(nodes, members, GRID * 2, 0)).toBe(true);
    });

    it("returns false for an isolated node", () => {
        const anchor = new Node(0, 0, true);
        const orphan = new Node(GRID * 5, 0);
        expect(isConnectedToAnchor([anchor, orphan], [], GRID * 5, 0)).toBe(false);
    });

    it("broken members don't conduct connectivity", () => {
        const anchor = new Node(0, 0, true);
        const far = new Node(GRID, 0);
        const m = new Member(anchor, far, "wood_beam");
        m.broken = true;
        expect(isConnectedToAnchor([anchor, far], [m], GRID, 0)).toBe(false);
    });
});

describe("calcCost", () => {
    it("returns 0 for no members", () => {
        expect(calcCost([])).toBe(0);
    });

    it("charges each member by length * price / 10", () => {
        const a = new Node(0, 0, true);
        const b = new Node(100, 0);
        const m = new Member(a, b, "wood_road"); // price 120, length 100
        expect(calcCost([m])).toBe(Math.round((100 * MATERIALS.wood_road.price) / 10));
    });

    it("skips builtin members", () => {
        const a = new Node(0, 0, true);
        const b = new Node(100, 0);
        const m = new Member(a, b, "wood_road");
        m.builtin = true;
        expect(calcCost([m])).toBe(0);
    });

    it("sums multiple members", () => {
        const a = new Node(0, 0, true);
        const b = new Node(100, 0);
        const c = new Node(200, 0);
        const m1 = new Member(a, b, "wood_beam");
        const m2 = new Member(b, c, "wood_beam");
        const expected =
            Math.round((100 * MATERIALS.wood_beam.price) / 10) +
            Math.round((100 * MATERIALS.wood_beam.price) / 10);
        expect(calcCost([m1, m2])).toBe(expected);
    });
});

describe("Node", () => {
    it("fixed nodes have invMass 0", () => {
        const n = new Node(0, 0, true);
        expect(n.invMass).toBe(0);
        expect(n.fixed).toBe(true);
    });

    it("free nodes have invMass 1", () => {
        const n = new Node(0, 0, false);
        expect(n.invMass).toBe(1);
        expect(n.fixed).toBe(false);
    });

    it("reset restores position and clears velocity", () => {
        const n = new Node(10, 20);
        n.x = 50; n.y = 60;
        n.vx = 5; n.vy = 5;
        n.reset();
        expect(n.x).toBe(10);
        expect(n.y).toBe(20);
        expect(n.vx).toBe(0);
        expect(n.vy).toBe(0);
    });
});

describe("Member", () => {
    it("rest length equals distance between nodes", () => {
        const a = new Node(0, 0);
        const b = new Node(3, 4);
        const m = new Member(a, b, "wood_beam");
        expect(m.rest).toBe(5);
    });

    it("pulls compliance from its material", () => {
        const a = new Node(0, 0);
        const b = new Node(0, GRID);
        const m = new Member(a, b, "steel");
        expect(m.compliance).toBe(MATERIALS.steel.compliance);
    });
});
