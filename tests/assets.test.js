// Verify every asset path referenced in main.js / constants.js exists on disk.
// Prevents `loadSprite(404)` errors that only show up at runtime.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { VEHICLES } from "../src/constants.js";

const ROOT = resolve(import.meta.dirname, "..");
const PUBLIC = join(ROOT, "public");

// Parse main.js and extract every string literal passed to k.loadSprite / k.loadFont
function extractAssetPaths() {
    const src = readFileSync(join(ROOT, "src", "main.js"), "utf8");
    const re = /k\.load(?:Sprite|Font)\s*\([^,]+,\s*["']([^"']+)["']/g;
    const paths = [];
    let m;
    while ((m = re.exec(src))) paths.push(m[1]);
    return paths;
}

describe("asset files on disk", () => {
    const paths = extractAssetPaths();

    it("main.js references at least one asset", () => {
        expect(paths.length).toBeGreaterThan(0);
    });

    it.each(paths)("asset exists: %s", (p) => {
        // Paths in main.js are web-root style ("/assets/..."); resolve against public/
        const diskPath = join(PUBLIC, p.replace(/^\//, ""));
        expect(existsSync(diskPath), `missing ${diskPath}`).toBe(true);
    });
});

describe("vehicle sprite keys", () => {
    it("every vehicle has a sprite key", () => {
        for (const [key, v] of Object.entries(VEHICLES)) {
            expect(v.sprite, `vehicle "${key}" missing sprite`).toBeTruthy();
        }
    });

    it("every vehicle sprite key is loaded in main.js", () => {
        const src = readFileSync(join(ROOT, "src", "main.js"), "utf8");
        for (const [key, v] of Object.entries(VEHICLES)) {
            const pattern = new RegExp(`loadSprite\\s*\\(\\s*["']${v.sprite}["']`);
            expect(pattern.test(src), `vehicle "${key}" sprite "${v.sprite}" not loaded in main.js`).toBe(true);
        }
    });
});
