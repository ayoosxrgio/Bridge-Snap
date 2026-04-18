import { describe, it, expect } from "vitest";
import { MATERIALS, VEHICLES, GRID } from "../src/constants.js";

describe("MATERIALS", () => {
    const REQUIRED = [
        "label", "key", "color", "colorDark",
        "compliance", "breakForce", "price",
        "width", "maxLength", "isRoad", "tensionOnly",
    ];

    it.each(Object.entries(MATERIALS))("%s has all required fields", (key, mat) => {
        for (const field of REQUIRED) {
            expect(mat[field], `${key}.${field} missing`).not.toBeUndefined();
        }
    });

    it.each(Object.entries(MATERIALS))("%s key field matches object key", (key, mat) => {
        expect(mat.key).toBe(key);
    });

    it.each(Object.entries(MATERIALS))("%s has positive numeric fields", (key, mat) => {
        expect(mat.compliance).toBeGreaterThan(0);
        expect(mat.breakForce).toBeGreaterThan(0);
        expect(mat.price).toBeGreaterThan(0);
        expect(mat.width).toBeGreaterThan(0);
        expect(mat.maxLength).toBeGreaterThan(0);
    });

    it.each(Object.entries(MATERIALS))("%s maxLength is a multiple of GRID", (key, mat) => {
        expect(mat.maxLength % GRID).toBe(0);
    });

    it("at least one road material exists", () => {
        const roads = Object.values(MATERIALS).filter(m => m.isRoad);
        expect(roads.length).toBeGreaterThan(0);
    });

    it("at least one tension-only material exists", () => {
        const tension = Object.values(MATERIALS).filter(m => m.tensionOnly);
        expect(tension.length).toBeGreaterThan(0);
    });

    it("tension-only materials are not roads", () => {
        for (const [key, mat] of Object.entries(MATERIALS)) {
            if (mat.tensionOnly) {
                expect(mat.isRoad, `${key} is both tension-only and a road`).toBe(false);
            }
        }
    });
});

describe("VEHICLES", () => {
    const REQUIRED = ["name", "mass", "w", "h", "speed", "color", "sprite"];

    it.each(Object.entries(VEHICLES))("%s has all required fields", (key, v) => {
        for (const field of REQUIRED) {
            expect(v[field], `${key}.${field} missing`).not.toBeUndefined();
        }
    });

    it.each(Object.entries(VEHICLES))("%s has positive mass and dimensions", (key, v) => {
        expect(v.mass).toBeGreaterThan(0);
        expect(v.w).toBeGreaterThan(0);
        expect(v.h).toBeGreaterThan(0);
        expect(v.speed).toBeGreaterThan(0);
    });
});

describe("GRID", () => {
    it("is a positive integer", () => {
        expect(Number.isInteger(GRID)).toBe(true);
        expect(GRID).toBeGreaterThan(0);
    });
});
