import { describe, it, expect } from "vitest";
import { LEVELS } from "../src/levels.js";
import { MATERIALS, VEHICLES, GRID } from "../src/constants.js";

describe("LEVELS", () => {
    it("has at least one level", () => {
        expect(LEVELS.length).toBeGreaterThan(0);
    });

    it("every level has a unique id", () => {
        const ids = LEVELS.map(l => l.id);
        const unique = new Set(ids);
        expect(unique.size).toBe(ids.length);
    });

    it.each(LEVELS.map((l, i) => [i, l.id, l]))("level %i (%s) has required fields", (_, __, lvl) => {
        expect(lvl.id).toBeTruthy();
        expect(lvl.name).toBeTruthy();
        expect(lvl.concept).toBeTruthy();
        expect(lvl.budget).toBeGreaterThan(0);
        expect(lvl.gap).toBeGreaterThan(0);
        expect(Number.isInteger(lvl.hDiff)).toBe(true);
        expect(Array.isArray(lvl.materials)).toBe(true);
        expect(lvl.materials.length).toBeGreaterThan(0);
    });

    it.each(LEVELS.map((l, i) => [i, l.id, l]))("level %i (%s) gap is a multiple of GRID", (_, __, lvl) => {
        expect(lvl.gap % GRID).toBe(0);
    });

    it.each(LEVELS.map((l, i) => [i, l.id, l]))("level %i (%s) hDiff is a multiple of GRID", (_, __, lvl) => {
        expect(lvl.hDiff % GRID).toBe(0);
    });

    it.each(LEVELS.map((l, i) => [i, l.id, l]))("level %i (%s) references a real vehicle", (_, __, lvl) => {
        if (lvl.multiVehicle) {
            for (const mv of lvl.multiVehicle) {
                expect(VEHICLES[mv.vType], `${lvl.id} multi-vehicle has unknown vType "${mv.vType}"`).toBeTruthy();
            }
        } else {
            expect(VEHICLES[lvl.vType], `${lvl.id} has unknown vType "${lvl.vType}"`).toBeTruthy();
        }
    });

    it.each(LEVELS.map((l, i) => [i, l.id, l]))("level %i (%s) references real materials", (_, __, lvl) => {
        for (const matKey of lvl.materials) {
            expect(MATERIALS[matKey], `${lvl.id} uses unknown material "${matKey}"`).toBeTruthy();
        }
    });

    it.each(LEVELS.map((l, i) => [i, l.id, l]))("level %i (%s) includes at least one road material", (_, __, lvl) => {
        const hasRoad = lvl.materials.some(k => MATERIALS[k]?.isRoad);
        expect(hasRoad, `${lvl.id} has no road material — vehicles have nothing to drive on`).toBe(true);
    });

    it.each(LEVELS.map((l, i) => [i, l.id, l]))("level %i (%s) extraAnchors use valid sides", (_, __, lvl) => {
        if (!lvl.extraAnchors) return;
        // aiHelper treats "L"/"R" as side anchors and anything else as a
        // center-relative anchor (midX + dx, lY + dy), so any string works
        // for "C" — but dx/dy must be finite numbers.
        for (const a of lvl.extraAnchors) {
            expect(typeof a.side).toBe("string");
            expect(a.side.length).toBeGreaterThan(0);
            expect(Number.isFinite(a.dx)).toBe(true);
            expect(Number.isFinite(a.dy)).toBe(true);
        }
    });
});
