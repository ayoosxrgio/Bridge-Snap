import { MATERIALS, GRID } from "./constants.js";
import { generateSkeleton, groupIntoSteps, slotDescriptions, buildPlayerDigest } from "./aiSkeleton.js";

// ─── Two transport paths ──────────────────────────────────
// 1) .env key (dev only) → fetch OpenAI directly. Read from
//    `VITE_OPENAI_API_KEY` in .env so the dev can test the helper while
//    running `npm run dev`. The key never appears in committed code (.env
//    is gitignored) but bundlers DO inline it into the client build, so
//    only use this in local dev — never publish a build with it set.
// 2) Portal proxy → postMessage to the parent frame, which forwards the
//    request through its server-side OpenAI integration. Used in the web
//    portal where the player doesn't have their own key.

function getDevKey() {
    try {
        return (import.meta.env && import.meta.env.VITE_OPENAI_API_KEY) || "";
    } catch { return ""; }
}

async function localAIRequest(payload) {
    const key = getDevKey();
    if (!key) throw new Error("VITE_OPENAI_API_KEY not set");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`,
        },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        let detail = "";
        try { detail = (await res.json())?.error?.message || ""; } catch {}
        throw new Error(`OpenAI ${res.status}${detail ? ": " + detail : ""}`);
    }
    return await res.json();
}

async function portalAIRequest(payload) {
    const res = await fetch("/api/ai/openai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        let detail = "";
        try { detail = (await res.json())?.error || ""; } catch {}
        throw new Error(`Portal proxy ${res.status}${detail ? ": " + detail : ""}`);
    }
    return await res.json();
}

async function chat(payload) {
    const useLocal = !!getDevKey();
    return useLocal ? await localAIRequest(payload) : await portalAIRequest(payload);
}

function extractJSON(text) {
    const jsonMatch =
        text.match(/```json\s*([\s\S]*?)```/) ||
        text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const jsonStr = jsonMatch[1] || jsonMatch[0];
    try { return JSON.parse(jsonStr); } catch { return null; }
}

// ─── Mode 1: "Show me a bridge" — narrate a code-generated skeleton ───────
//
// Geometry comes from `aiSkeleton.generateSkeleton`, so the bridge is
// guaranteed symmetric, triangulated, and within budget. The LLM only
// writes a teaching narrative for each pre-defined build step.
function buildNarrativePrompt(lvl, lvlDef, skeleton, steps) {
    const slots = slotDescriptions(skeleton.archetype);
    const stepBriefs = steps.map((s, i) =>
        `Step ${i + 1} — slot="${s.slot}" — engineer's intent: ${slots[s.slot] || s.slot}`
    ).join("\n");
    const vehicleMass = lvlDef.multiVehicle
        ? lvlDef.multiVehicle.map(mv => mv.vType).join(" + ")
        : lvlDef.vType;

    return `You are a high-school physics teacher narrating a bridge build for a student. We've already chosen the design and pre-computed the geometry — your job is to explain the WHY behind each step in plain, energetic prose. NO geometry, NO coordinates, NO material keys.

## Level: "${lvlDef.name}"
- Concept being taught: ${lvlDef.concept}
- Designer's lesson: "${lvlDef.lesson || ""}"
- Vehicle(s) crossing: ${vehicleMass}
- Gap: ${lvl.gap} units, height drop: ${lvl.hDiff}, terrain: ${lvl.terrain}

## Chosen design: ${skeleton.archetype.toUpperCase().replace("_", " ")}
The build is split into these ordered steps (the geometry is FIXED — don't redesign it):

${stepBriefs}

## Output format — JSON only, no prose outside it
{
  "concept": "Core physics concept (e.g. Triangulation, Tension, Compression, Load Path)",
  "summary": "One-sentence wrap-up of what we built and why it works for this level.",
  "steps": [
    { "title": "2-4 word action label", "explanation": "1-3 sentences using real engineering terms (compression, tension, load path, span, chord, hanger). Tie this step's slot to the physics. Address the student directly. NO coordinates, NO material keys." }
  ]
}

Step counts MUST match exactly: ${steps.length} step(s).

Pedagogy rules:
- Use displayNames for materials in your narrative ("Wood Beam", not "wood_beam"). But DON'T list materials — talk about FORCES.
- Real terms (compression, tension, triangulation, load path, span) — explain on first use.
- Tone: clear, energetic, never condescending. Talk to the student.
- Each step's explanation should teach ONE concept that maps to that slot.

Variation seed: ${Math.floor(Math.random() * 1000)}.`;
}

// "Show me a bridge" entry point. Returns `{ concept, summary, steps[] }`
// where each step has `members` (placed by the game scene) plus `title` and
// `explanation` (rendered in the panel).
export async function solveBridgeShow(lvl, lvlDef) {
    const useLocal = !!getDevKey();
    const standalone = window.parent === window;
    if (!useLocal && standalone) {
        return { error: "AI helper requires the web portal." };
    }
    try {
        const skeleton = generateSkeleton(lvl, lvlDef);
        const stepGroups = groupIntoSteps(skeleton);
        const prompt = buildNarrativePrompt(lvl, lvlDef, skeleton, stepGroups);
        const data = await chat({
            model: "gpt-4o",
            max_tokens: 1500,
            temperature: 0.7,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: prompt }],
        });
        const text = data.choices?.[0]?.message?.content || "";
        const parsed = extractJSON(text);
        if (!parsed || !Array.isArray(parsed.steps)) {
            return fallbackNarrative(skeleton, stepGroups, lvlDef);
        }
        // Zip narrative with the pre-computed members. If counts mismatch,
        // fall back to default titles for missing slots.
        const steps = stepGroups.map((g, i) => {
            const narration = parsed.steps[i] || {};
            return {
                title:       narration.title       || defaultTitle(g.slot, skeleton.archetype),
                explanation: narration.explanation || defaultExplanation(g.slot, skeleton.archetype),
                members:     g.members,
            };
        });
        return {
            concept:   parsed.concept || lvlDef.concept,
            summary:   parsed.summary || "",
            archetype: skeleton.archetype,
            steps,
        };
    } catch (err) {
        return { error: `Request failed: ${err.message}` };
    }
}

function defaultTitle(slot, archetype) {
    const titles = {
        truss:           { deck: "Lay the deck",   primary: "Bottom chord",        connectors: "Triangulate" },
        truss_above:     { deck: "Lay the deck",   primary: "Top chord",           connectors: "Triangulate" },
        tied_arch:       { deck: "Lay the tie",    primary: "Raise the arch",      connectors: "Hang the deck" },
        arch_deck:       { deck: "Lay the deck",   primary: "Curve the arch",      connectors: "Triangulate" },
        cable_stayed:    { deck: "Lay the deck",   primary: "Fan the stays",       connectors: "Brace the deck" },
        beam_pier:       { deck: "Lay the deck",   primary: "Raise the pier",      connectors: "Brace the pier" },
        suspension:      { deck: "Lay the deck",   primary: "Drop the hangers",    connectors: "Brace the deck" },
        simple_supports: { deck: "Lay the deck",   primary: "Add supports",        connectors: "Brace the deck" },
    };
    return titles[archetype]?.[slot] || "Build step";
}
function defaultExplanation(slot, archetype) {
    return slotDescriptions(archetype)[slot] || "";
}

// If the LLM call fails or returns garbage, ship the geometry anyway with a
// canned narrative so the lesson still works.
function fallbackNarrative(skeleton, stepGroups, lvlDef) {
    return {
        concept: lvlDef.concept,
        summary: "Built a clean bridge for this level — see each step's tip.",
        archetype: skeleton.archetype,
        steps: stepGroups.map(g => ({
            title:       defaultTitle(g.slot, skeleton.archetype),
            explanation: defaultExplanation(g.slot, skeleton.archetype),
            members:     g.members,
        })),
    };
}

// ─── Mode 2: "Coach my build" — tips on the player's current bridge ───────
function buildCoachPrompt(lvl, lvlDef, digest) {
    const slots = slotDescriptions(digest.archetype);
    const vehicleMass = lvlDef.multiVehicle
        ? lvlDef.multiVehicle.map(mv => mv.vType).join(" + ")
        : lvlDef.vType;
    const triangulationFact = digest.wellTriangulated
        ? `WELL TRIANGULATED — ${digest.triangleCount} triangle(s) for ${digest.interiorDeckNodes} interior deck node(s). DO NOT suggest "add triangulation" — they already have it.`
        : `UNDER TRIANGULATED — only ${digest.triangleCount} triangle(s) for ${digest.interiorDeckNodes} interior deck node(s). Triangulation is a valid focus.`;
    const supportFact = digest.unsupportedDeckNodes === 0
        ? `Every interior deck node has a structural beam attached — DO NOT suggest "add support under the deck", they have it.`
        : `${digest.unsupportedDeckNodes} of ${digest.interiorDeckNodes} interior deck nodes have NO beam attached — those will sag.`;
    const chordFact = `Top chord (above deck): ${digest.hasTopChord ? "PRESENT" : "absent"}. Bottom chord (below deck): ${digest.hasBottomChord ? "PRESENT" : "absent"}.`;
    const floatingFact = digest.floatingStructuralMembers === 0
        ? `All structural members trace back to a cliff anchor — no floating chains.`
        : `${digest.floatingStructuralMembers} structural member(s) don't trace back to any anchor (a floating chain) — those don't carry real load.`;

    return `You are a bridge-engineering coach reviewing a STUDENT's in-progress bridge. Be specific and grounded — NEVER recommend something they already have. The structural facts below were computed from their actual bridge, not just guessed.

## Level: "${lvlDef.name}"
- Concept being taught: ${lvlDef.concept}
- Vehicle(s) that will cross: ${vehicleMass}
- Gap: ${lvl.gap} units, height drop: ${lvl.hDiff}
- Budget: $${lvl.budget}
- Recommended archetype for this level: ${digest.archetype}
  (${slots.deck}; ${slots.primary}${slots.connectors ? "; " + slots.connectors : ""})

## Student's current build — STRUCTURAL ANALYSIS
- Members placed: ${digest.materialsUsed}
- Total members: ${digest.memberCount} (${digest.nonRoadCount} structural)
- Cost so far: $${digest.totalCost} of $${digest.budget}
- Road continuity (left anchor → right anchor): ${digest.roadConnected ? "COMPLETE" : "INCOMPLETE — gap in the deck"}
- Triangulation: ${triangulationFact}
- Deck support: ${supportFact}
- Chords: ${chordFact}
- Anchorage: ${floatingFact}

## What to DO and NOT DO
- Read each fact above. If a fact says "DO NOT suggest X", do NOT suggest X. The bridge already has it.
- Pick tips that address things the bridge IS missing or weak on. If everything looks good, say so honestly and offer one fine-tuning tip (cost optimization, material upgrade for heavy vehicle, etc.) — don't invent problems.
- For a level where the recommended archetype is "truss" but the student built something else (e.g. floating-apex chain with no bottom chord), gently steer them toward the correct anatomy.
- Reference the SPECIFIC counts/facts above ("you have 8 triangles for 4 interior deck nodes — solid") instead of generic advice.

## Output format — JSON only
{
  "summary": "One sentence on the overall state of their build.",
  "tips": [
    { "title": "2-4 word focus label", "explanation": "1-3 sentences. Reference what they actually have using the facts above. Use real engineering terms. No coordinates, no material keys, no platitudes." }
  ]
}

Output 1–3 tips, most impactful first. If the bridge looks good, output 1 tip ("Looking good") and nothing else.

Variation seed: ${Math.floor(Math.random() * 1000)}.`;
}

// "Coach my build" entry point. Returns `{ summary, steps[] }` where each
// step is a tip with no members (the panel just shows text). Same step shape
// as solveBridgeShow so the panel/walkthrough code works for both.
export async function coachBuild(lvl, lvlDef, playerState) {
    const useLocal = !!getDevKey();
    const standalone = window.parent === window;
    if (!useLocal && standalone) {
        return { error: "AI helper requires the web portal." };
    }
    try {
        const digest = buildPlayerDigest(lvl, lvlDef, playerState);
        const prompt = buildCoachPrompt(lvl, lvlDef, digest);
        const data = await chat({
            model: "gpt-4o",
            max_tokens: 800,
            temperature: 0.7,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: prompt }],
        });
        const text = data.choices?.[0]?.message?.content || "";
        const parsed = extractJSON(text);
        if (!parsed || !Array.isArray(parsed.tips) || parsed.tips.length === 0) {
            return { error: "Couldn't read the coach response — try again." };
        }
        const steps = parsed.tips.map(t => ({
            title:       t.title || "Tip",
            explanation: t.explanation || "",
            members:     [],          // coach mode never places anything
        }));
        return {
            mode: "coach",
            concept: lvlDef.concept,
            summary: parsed.summary || "",
            steps,
        };
    } catch (err) {
        return { error: `Request failed: ${err.message}` };
    }
}

// ─── Back-compat alias ───────────────────────────────────────────
// External callers (game.js) may still import `solveBridge`. Default it to
// the show-me-a-bridge flow so existing call sites continue to work.
export const solveBridge = solveBridgeShow;
