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

    // Build prioritized list of structural facts. Order matters — we want
    // the most impactful issues at the top so the LLM addresses those first.
    const facts = [];
    const forbidden = [];

    if (!digest.roadConnected) {
        facts.push("CRITICAL: the road does not yet span from the left anchor to the right anchor — there's a gap somewhere in the deck. Vehicles can't cross.");
    }
    if (digest.mechanismDeficit > 0) {
        facts.push(`CRITICAL: by Maxwell rigidity count, this structure has ${digest.mechanismDeficit} unconstrained mechanism mode(s) (it needs ${digest.mechanismDeficit} more bracing member(s) to be truly rigid). Under load it will deform without straining the beams — the road will take all the load and snap. Look for cells that are rectangles instead of triangles.`);
    }
    if (digest.floatingStructuralMembers > 0) {
        facts.push(`${digest.floatingStructuralMembers} structural member(s) don't trace back to any cliff anchor through OTHER structural members (a floating chain) — those barely carry load.`);
    }
    if (digest.unsupportedDeckNodes > 0) {
        facts.push(`${digest.unsupportedDeckNodes} of ${digest.interiorDeckNodes} interior deck nodes have NO beam attached — those will sag and crack the road around them.`);
    } else if (digest.interiorDeckNodes > 0) {
        forbidden.push("'add support under the deck' — every interior deck node already has a beam attached");
    }
    if (digest.wellTriangulated) {
        forbidden.push(`'add triangulation' — they already have ${digest.triangleCount} triangle(s) for ${digest.interiorDeckNodes} interior deck node(s), which is well-triangulated`);
    } else if (digest.triangleCount < digest.interiorDeckNodes / 2 && digest.interiorDeckNodes > 0) {
        facts.push(`only ${digest.triangleCount} triangle(s) for ${digest.interiorDeckNodes} interior deck node(s) — under-triangulated. Adding diagonals to form triangles is a valid focus.`);
    }

    // Level-specific compliance with the recommended archetype.
    if (digest.hasMidPier && !digest.usesPier) {
        facts.push("This level has a MID-GAP ROCK PIER that the student is ignoring. The intended design uses it as a vertical support point — without it, the gap is much too long for a single span.");
    }
    if (digest.hasHighTowers && !digest.usesHighAnchor) {
        facts.push("This level has HIGH TOWER ANCHORS above each cliff that the student is ignoring. The intended design hangs the deck from those towers via cables — without using them, the design is missing the point of the level.");
    }
    if (digest.hasHighTowers && digest.usesHighAnchor && !digest.usesTension) {
        facts.push("The student is using the high tower anchors but only with beams — the intended design uses ROPE/CABLE (tension members) since those are what suspension cables are in real life.");
    }

    if (digest.archetype === "beam_pier" && digest.hasMidPier && digest.usesPier && !digest.hasBottomChord) {
        facts.push("The pier is used, but there's no bottom chord on either side — a two-span continuous truss puts a bottom chord on each half-span, anchored at the cliff AND at the pier.");
    }
    if (digest.archetype === "truss" && !digest.hasBottomChord && digest.interiorDeckNodes > 0) {
        facts.push("The recommended design is a Pratt truss with a BOTTOM CHORD running below the deck anchor-to-anchor. The student has no bottom chord — they're missing the most important member of the truss.");
    }
    if (digest.archetype === "truss_above" && !digest.hasTopChord && digest.interiorDeckNodes > 0) {
        facts.push("The recommended design is a through-truss with a TOP CHORD running above the deck. The student has no top chord.");
    }
    if (digest.archetype === "tied_arch" && !digest.hasTopChord) {
        facts.push("The recommended design is a tied arch / bowstring truss: an arched member rising ABOVE the deck. The student doesn't have one yet.");
    }
    if (digest.archetype === "arch_deck" && !digest.hasBottomChord) {
        facts.push("The recommended design is a deck arch: an arched member curving DOWN below the deck. The student doesn't have one yet.");
    }
    if (digest.archetype === "suspension" && !digest.usesTension) {
        facts.push("The recommended design is a suspension bridge: a draped CABLE between the two towers, with hangers dropping down to the deck. The student isn't using rope/cable yet.");
    }
    if (digest.archetype === "cable_stayed" && !digest.usesTension) {
        facts.push("The recommended design is a cable-stayed bridge: straight rope/cable stays fanning out from each tower to the deck. The student isn't using rope/cable yet.");
    }

    // Budget-related observations.
    if (digest.budgetPct > 0.95 && digest.roadConnected) {
        facts.push(`Cost is at ${Math.round(digest.budgetPct * 100)}% of budget — very little room to add reinforcement. Consider downgrading any over-spec'd materials.`);
    } else if (digest.budgetPct < 0.4 && digest.roadConnected && digest.mechanismDeficit === 0) {
        facts.push(`Cost is only ${Math.round(digest.budgetPct * 100)}% of budget — they have lots of room for stronger materials on critical members if the bridge feels marginal.`);
    }

    const factSection = facts.length
        ? facts.map((f, i) => `${i + 1}. ${f}`).join("\n")
        : "(no critical issues detected — the bridge looks structurally sound)";
    const forbiddenSection = forbidden.length
        ? "FORBIDDEN tips (the bridge already satisfies these):\n" + forbidden.map(f => `  - DO NOT say ${f}`).join("\n")
        : "";

    return `You are a bridge-engineering coach reviewing a STUDENT's in-progress bridge. Your tips must reference the PROBLEMS LIST below — those are the actual structural issues computed from their bridge. If the problems list is empty, the bridge is fine and you should say so.

## This level: "${lvlDef.name}"
- Concept being taught: ${lvlDef.concept} — "${lvlDef.lesson || ""}"
- Vehicle(s): ${vehicleMass}
- Recommended archetype: ${digest.archetype}
  How it works: ${slots.deck}; ${slots.primary}${slots.connectors ? "; " + slots.connectors : ""}

## Student's build — quick stats
- Members: ${digest.memberCount} (${digest.nonRoadCount} structural). Cost: $${digest.totalCost} of $${digest.budget}.
- Road continuous: ${digest.roadConnected ? "yes" : "no"}. Top chord: ${digest.hasTopChord ? "yes" : "no"}. Bottom chord: ${digest.hasBottomChord ? "yes" : "no"}.

## PROBLEMS LIST (ordered most-impactful first)
${factSection}

${forbiddenSection}

## Output rules
- Pick the top 1–3 problems above. Write a tip for EACH. Skip any problem the student has already solved.
- If the problems list says "no critical issues", output ONE tip with title "Looking good" and a sentence about what they did well, plus optionally one fine-tuning suggestion (cost efficiency, heavier-material upgrade).
- NEVER write a tip that contradicts a "DO NOT say" line above.
- Tips must NAME the specific issue from the list — don't paraphrase into platitudes.
- Use real engineering terms (compression, tension, load path, triangulation, bottom chord, mechanism, etc.) and explain on first use.
- 1–3 sentences per tip. No coordinates, no material keys ("wood_road"), no generic advice.

## Output format — JSON only
{
  "summary": "One sentence overall.",
  "tips": [
    { "title": "2-4 word focus label", "explanation": "1-3 sentences referencing a specific problem from the list above." }
  ]
}

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
