import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildPrompt, solveBridge, setApiKey, getApiKey } from "../src/aiHelper.js";
import { MATERIALS, GRID } from "../src/constants.js";

const SAMPLE_LVL = {
    lX: 180, lY: 396,
    rX: 576, rY: 396,
    midX: 378,
    gap: 396, hDiff: 0,
    budget: 10000,
};
const SAMPLE_LVL_DEF = {
    name: "TEST LEVEL",
    vType: "car",
    concept: "TRIANGULATION",
    extraAnchors: [],
};

// Helper: build a fake OpenAI chat-completions response
function openaiResponse(text) {
    return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: text } }] }),
    };
}

// Minimal valid lesson payload used by several tests
function sampleLesson() {
    return {
        concept: "Triangulation",
        steps: [
            {
                question: "What should we lay first?",
                options: ["steel", "wood road", "rope"],
                correct: 1,
                explainCorrect: "Right — cars need a road surface.",
                explainWrong: "Cables don't give the wheels anything to roll on.",
                members: [
                    { x1: 180, y1: 396, x2: 216, y2: 396, type: "wood_road" },
                ],
            },
            {
                question: "What shape prevents sagging?",
                options: ["square", "triangle"],
                correct: 1,
                explainCorrect: "Triangles are naturally rigid.",
                explainWrong: "Squares collapse into parallelograms.",
                members: [
                    { x1: 180, y1: 396, x2: 216, y2: 432, type: "wood_beam" },
                ],
            },
        ],
        summary: "You built a triangulated bridge!",
    };
}

describe("buildPrompt", () => {
    it("includes the level name, gap, hDiff, and budget", () => {
        const prompt = buildPrompt(SAMPLE_LVL, SAMPLE_LVL_DEF);
        expect(prompt).toContain("TEST LEVEL");
        expect(prompt).toContain("396");
        expect(prompt).toContain("10000");
    });

    it("describes every material in the default catalog", () => {
        const prompt = buildPrompt(SAMPLE_LVL, SAMPLE_LVL_DEF);
        for (const key of Object.keys(MATERIALS)) {
            expect(prompt).toContain(`"${key}"`);
        }
    });

    it("lists the primary anchors", () => {
        const prompt = buildPrompt(SAMPLE_LVL, SAMPLE_LVL_DEF);
        expect(prompt).toContain("LEFT ANCHOR (180, 396)");
        expect(prompt).toContain("RIGHT ANCHOR (576, 396)");
    });

    it("grid-snaps extraAnchors on side L", () => {
        const def = { ...SAMPLE_LVL_DEF, extraAnchors: [{ side: "L", dx: 0, dy: -108 }] };
        const prompt = buildPrompt(SAMPLE_LVL, def);
        expect(prompt).toContain("EXTRA ANCHOR (180, 288)");
    });

    it("grid-snaps extraAnchors on side R", () => {
        const def = { ...SAMPLE_LVL_DEF, extraAnchors: [{ side: "R", dx: 0, dy: -GRID * 2 }] };
        const prompt = buildPrompt(SAMPLE_LVL, def);
        expect(prompt).toContain(`EXTRA ANCHOR (576, ${396 - GRID * 2})`);
    });

    it("handles center (C) extraAnchors relative to midX", () => {
        const def = { ...SAMPLE_LVL_DEF, extraAnchors: [{ side: "C", dx: 0, dy: 0 }] };
        const prompt = buildPrompt(SAMPLE_LVL, def);
        const snappedX = Math.round(SAMPLE_LVL.midX / GRID) * GRID;
        expect(prompt).toContain(`EXTRA ANCHOR (${snappedX}, 396)`);
    });

    it("only lists materials unlocked for the current level", () => {
        const def = { ...SAMPLE_LVL_DEF, materials: ["wood_road", "wood_beam"] };
        const prompt = buildPrompt(SAMPLE_LVL, def);
        expect(prompt).toContain(`"wood_road"`);
        expect(prompt).toContain(`"wood_beam"`);
        // Locked materials should NOT appear in the prompt's allowed-materials section
        expect(prompt).not.toContain(`"steel"`);
        expect(prompt).not.toContain(`"stone_road"`);
        expect(prompt).not.toContain(`"cable"`);
    });

    it("incorporates level-specific context (hint + lesson + concept)", () => {
        const def = {
            ...SAMPLE_LVL_DEF,
            concept: "SUSPENSION",
            hint: "hang the road from cables above",
            lesson: "cables pull the roadbed up from high anchors",
        };
        const prompt = buildPrompt(SAMPLE_LVL, def);
        expect(prompt).toContain("SUSPENSION");
        expect(prompt).toContain("hang the road from cables above");
        expect(prompt).toContain("cables pull the roadbed up");
    });

    it("mentions the grid size", () => {
        const prompt = buildPrompt(SAMPLE_LVL, SAMPLE_LVL_DEF);
        expect(prompt).toContain(`multiples of ${GRID}`);
    });

    it("asks for a multi-step Socratic lesson in JSON", () => {
        const prompt = buildPrompt(SAMPLE_LVL, SAMPLE_LVL_DEF);
        expect(prompt).toMatch(/SOCRATIC/i);
        expect(prompt).toMatch(/"steps"/);
        expect(prompt).toMatch(/JSON/);
    });

    it("mentions the level's core concept so the lesson stays on-topic", () => {
        const prompt = buildPrompt(SAMPLE_LVL, SAMPLE_LVL_DEF);
        expect(prompt).toContain("TRIANGULATION");
    });
});

describe("setApiKey / getApiKey", () => {
    it("round-trips a key", () => {
        setApiKey("test-key-123");
        expect(getApiKey()).toBe("test-key-123");
    });
});

describe("solveBridge", () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        setApiKey(null);
    });

    it("returns an error when no API key is set", async () => {
        setApiKey(null);
        const result = await solveBridge(SAMPLE_LVL, SAMPLE_LVL_DEF);
        expect(result.error).toMatch(/no api key/i);
    });

    it("parses a fenced JSON lesson", async () => {
        setApiKey("k");
        const lesson = sampleLesson();
        global.fetch = vi.fn().mockResolvedValue(
            openaiResponse("here you go:\n```json\n" + JSON.stringify(lesson) + "\n```")
        );
        const result = await solveBridge(SAMPLE_LVL, SAMPLE_LVL_DEF);
        expect(result.concept).toBe("Triangulation");
        expect(result.steps).toHaveLength(2);
        expect(result.steps[0].options).toHaveLength(3);
        expect(result.summary).toMatch(/triangulated/);
    });

    it("parses a raw (unfenced) JSON lesson", async () => {
        setApiKey("k");
        const lesson = sampleLesson();
        global.fetch = vi.fn().mockResolvedValue(openaiResponse(JSON.stringify(lesson)));
        const result = await solveBridge(SAMPLE_LVL, SAMPLE_LVL_DEF);
        expect(result.steps).toHaveLength(2);
    });

    it("surfaces API errors from non-2xx responses", async () => {
        setApiKey("k");
        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            text: async () => "invalid key",
        });
        const result = await solveBridge(SAMPLE_LVL, SAMPLE_LVL_DEF);
        expect(result.error).toMatch(/401/);
        expect(result.error).toMatch(/invalid key/);
    });

    it("errors when response has no parseable JSON", async () => {
        setApiKey("k");
        global.fetch = vi.fn().mockResolvedValue(openaiResponse("I couldn't help with that."));
        const result = await solveBridge(SAMPLE_LVL, SAMPLE_LVL_DEF);
        expect(result.error).toMatch(/parse/i);
    });

    it("errors when response is missing the steps array", async () => {
        setApiKey("k");
        global.fetch = vi.fn().mockResolvedValue(
            openaiResponse("```json\n" + JSON.stringify({ concept: "x" }) + "\n```")
        );
        const result = await solveBridge(SAMPLE_LVL, SAMPLE_LVL_DEF);
        expect(result.error).toMatch(/steps/i);
    });

    it("errors when a step is missing required fields", async () => {
        setApiKey("k");
        const badLesson = {
            concept: "x",
            steps: [{ question: "hi", options: ["a"], members: [] }], // no `correct`
        };
        global.fetch = vi.fn().mockResolvedValue(
            openaiResponse("```json\n" + JSON.stringify(badLesson) + "\n```")
        );
        const result = await solveBridge(SAMPLE_LVL, SAMPLE_LVL_DEF);
        expect(result.error).toMatch(/malformed|step/i);
    });

    it("catches thrown network errors", async () => {
        setApiKey("k");
        global.fetch = vi.fn().mockRejectedValue(new Error("network down"));
        const result = await solveBridge(SAMPLE_LVL, SAMPLE_LVL_DEF);
        expect(result.error).toMatch(/network down/i);
    });

    it("sends the OpenAI endpoint, Bearer auth, and prompt body", async () => {
        setApiKey("sk-proj-my-key");
        const fetchMock = vi.fn().mockResolvedValue(
            openaiResponse("```json\n" + JSON.stringify(sampleLesson()) + "\n```")
        );
        global.fetch = fetchMock;
        await solveBridge(SAMPLE_LVL, SAMPLE_LVL_DEF);

        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.openai.com/v1/chat/completions");
        expect(opts.method).toBe("POST");
        expect(opts.headers["Authorization"]).toBe("Bearer sk-proj-my-key");
        const body = JSON.parse(opts.body);
        expect(body.model).toMatch(/gpt/);
        expect(body.messages[0].role).toBe("user");
        expect(body.messages[0].content).toContain("TEST LEVEL");
    });
});
