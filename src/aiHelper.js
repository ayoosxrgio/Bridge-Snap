import { MATERIALS, GRID } from "./constants.js";

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

let _requestId = 0;
function portalAIRequest(payload) {
    return new Promise((resolve, reject) => {
        const requestId = ++_requestId;

        function handler(event) {
            const d = event.data;
            if (d?.source === "bridge-snap" && d?.requestId === requestId) {
                window.removeEventListener("message", handler);
                if (d.error) reject(new Error(d.error));
                else resolve(d.payload);
            }
        }

        window.addEventListener("message", handler);
        window.parent.postMessage({
            source: "bridge-snap",
            type: "PORTAL_AI_REQUEST",
            requestId,
            payload,
        }, "*");

        // GPT-4o on long prompts can take a while; give the portal time to respond.
        setTimeout(() => {
            window.removeEventListener("message", handler);
            reject(new Error("AI request timed out"));
        }, 60000);
    });
}

// ─── Prompt — TEACHING-MODE helper ────────────────────────
// The model returns a step-by-step plan where each step has a one-line title,
// a 1-3 sentence engineering explanation (why we're doing this — physics,
// shape, material choice, load path), and the members to place. The UI walks
// through the steps; the bridge grows as the player clicks "Next".
//
// No quiz options, no correct/wrong feedback. The goal is to teach concepts
// while building an effective bridge.
export function buildPrompt(lvl, lvlDef) {
    const allowedKeys = lvlDef.materials || Object.keys(MATERIALS);
    const allowedMats = allowedKeys.filter(k => MATERIALS[k]);
    const matList = allowedMats
        .map(k => {
            const m = MATERIALS[k];
            const role = m.isRoad ? "ROAD SURFACE (drive on this)" : (m.tensionOnly ? "TENSION-ONLY (goes slack in compression — use as a cable from a HIGH anchor to pull the road up)" : "structural beam (compression + tension)");
            return `- key="${k}" displayName="${m.label}" — breakForce=${m.breakForce}, cost=$${m.price}/10 units length, maxLen=${m.maxLength}. ${role}.`;
        })
        .join("\n");
    const roadKeys = allowedMats.filter(k => MATERIALS[k].isRoad);
    const beamKeys = allowedMats.filter(k => !MATERIALS[k].isRoad && !MATERIALS[k].tensionOnly);
    const tensionKeys = allowedMats.filter(k => MATERIALS[k].tensionOnly);

    // Pre-compute geometric scaffolding
    const roadMatKey = roadKeys[0] || "wood_road";
    const roadMax = MATERIALS[roadMatKey].maxLength;
    const roadSegs = Math.max(1, Math.ceil(lvl.gap / roadMax));
    const roadXs = [];
    for (let i = 0; i <= roadSegs; i++) {
        roadXs.push(lvl.lX + Math.round((i * lvl.gap) / roadSegs / GRID) * GRID);
    }
    const roadYs = roadXs.map((_, i) => lvl.lY + Math.round((i * lvl.hDiff) / roadSegs / GRID) * GRID);
    const roadbedPairs = roadXs.slice(0, -1)
        .map((x, i) => `(${x},${roadYs[i]})→(${roadXs[i + 1]},${roadYs[i + 1]})`)
        .join(", ");
    const supDepth = GRID * 3;
    const supXs = roadXs.slice(1, -1);
    const supList = supXs.length
        ? supXs.map((x, i) => `(${x},${roadYs[i + 1] + supDepth})`).join(", ")
        : "(none — single road piece spans anchor to anchor)";

    const anchors = [];
    anchors.push(`- LEFT ANCHOR (${lvl.lX}, ${lvl.lY}) — top of left cliff`);
    anchors.push(`- RIGHT ANCHOR (${lvl.rX}, ${lvl.rY}) — top of right cliff`);
    let hasMidPier = false;
    if (lvlDef.extraAnchors) {
        for (const a of lvlDef.extraAnchors) {
            let x, y, where;
            if (a.side === "L") { x = lvl.lX + a.dx; y = lvl.lY + a.dy; where = a.dy < 0 ? "high tower on LEFT cliff" : "buried in LEFT cliff wall"; }
            else if (a.side === "R") { x = lvl.rX + a.dx; y = lvl.rY + a.dy; where = a.dy < 0 ? "high tower on RIGHT cliff" : "buried in RIGHT cliff wall"; }
            else { x = lvl.midX + a.dx; y = lvl.lY + a.dy; where = "MID-GAP ROCK PIER (a stone pillar in the water — USE THIS as a vertical support point for the deck)"; hasMidPier = true; }
            x = Math.round(x / GRID) * GRID;
            y = Math.round(y / GRID) * GRID;
            anchors.push(`- EXTRA ANCHOR (${x}, ${y}) — ${where}`);
        }
    }

    const vehicleMass = lvlDef.multiVehicle
        ? lvlDef.multiVehicle.map(mv => mv.vType).join(" + ")
        : lvlDef.vType;

    return `You are an EXPERT bridge-engineering tutor. Your job: design a working bridge for THIS level and walk the player through HOW and WHY it works, step by step. The bridge will be built on-screen as the player advances through your steps. NO quiz questions — you are teaching, not testing.

## Coordinate system (critical!):
- X increases RIGHT, Y increases DOWNWARD (screen coords)
- BELOW the road → HIGHER y. ABOVE the road → LOWER y.
- All coordinates MUST be multiples of ${GRID}.

## This specific level — "${lvlDef.name}"
- Concept being taught: ${lvlDef.concept}  (gimmick tag: "${lvlDef.gimmick || "none"}", difficulty ${lvlDef.difficulty || "?"})
- Designer's one-line hint: "${lvlDef.hint || ""}"
- Designer's lesson: "${lvlDef.lesson || ""}"
- Gap to span: ${lvl.gap} units, height drop: ${lvl.hDiff} units ${lvl.hDiff > 0 ? "(right side lower → slope)" : lvl.hDiff < 0 ? "(left side lower)" : "(flat)"}
- Budget: $${lvl.budget}
- Vehicle(s) that will cross: ${vehicleMass}
- Terrain: ${lvl.terrain || "canyon"}

## Anchor points (ONLY these nodes are fixed — everything else you add is free):
${anchors.join("\n")}

## Materials available on THIS LEVEL (you MUST NOT use any other):
${matList}

Grouped:
- ROAD material(s): ${roadKeys.length ? roadKeys.join(", ") : "(none — unusual!)"}
- STRUCTURAL beam(s): ${beamKeys.length ? beamKeys.join(", ") : "(none — unusual!)"}
- TENSION-ONLY: ${tensionKeys.length ? tensionKeys.join(", ") : "(none — no suspension possible here)"}

## Suggested geometry for THIS level (use if it fits — adapt for cable/suspension designs):
- Roadbed needs ${roadSegs} segment(s) to span ${lvl.gap} units
- Roadbed x,y points: ${roadXs.map((x, i) => `(${x},${roadYs[i]})`).join(", ")}
- Roadbed members should go: ${roadbedPairs}
- Suggested bottom-chord support row ${supDepth}u BELOW roadbed: ${supList}

## Bridge archetypes — PICK ONE and commit
Beam supports can sit ABOVE the deck (overhead truss / roof-style) OR BELOW (floor-style truss). On levels with high anchors, an overhead truss often saves cost because the beams pull the deck up via tension/compression to anchor points already provided. Prefer overhead when high anchors exist; prefer below when only cliff-top anchors are available.

- **Warren/Pratt TRUSS** (above OR below): road on one chord, parallel chord on the OTHER side, diagonals zig-zag forming triangles. Both chords EXTEND TO ANCHORS. Below-deck = floor truss; above-deck = overhead truss.
- **ARCH** (above OR below): arch curves toward the anchors. Short verticals tie the deck to the arch. A below-deck arch carries compression upward; an above-deck arch carries the deck via hangers.
- **SUSPENSION** (needs HIGH anchors): main cable drapes between high anchors, vertical hangers drop to each road node. Always above the deck.
- **CABLE-STAYED** (one tower): straight cables from tower top down to each road node.
- **CANTILEVER** (one anchor only): rigid truss extends from cliff. Back-stays anchor the root.
- **BEAM + PIER** (mid-gap anchor): single vertical pier from mid-anchor up to road, then road spans both halves.

## HARD RULES — the final bridge MUST satisfy ALL of these:
1. **Connectivity**: every member connects TWO nodes. A node is legal only if it (a) IS an anchor, or (b) is also an endpoint of ANOTHER member that traces back to an anchor.
2. **NO ANCHORING INTO THE CLIFF**: a non-anchor point (x, y) must satisfy: if x ≤ ${lvl.lX} then y ≤ ${lvl.lY}; if x ≥ ${lvl.rX} then y ≤ ${lvl.rY}.
3. **Road continuity**: road members form one unbroken chain from LEFT ANCHOR (${lvl.lX},${lvl.lY}) to RIGHT ANCHOR (${lvl.rX},${lvl.rY}).
4. **Load path to anchors**: every interior road node traces through structural members to an anchor. Bottom chords / cables EXTEND ALL THE WAY to both anchors.
5. **Trusses need BOTH chords**: top chord (road) AND bottom chord (parallel chain below) AND diagonals. A bare zigzag with no horizontal bottom chord is NOT a truss.
6. **Materials**: use only the listed keys. No invented keys.
7. **Coordinates**: every x,y is a multiple of ${GRID}.
8. **Budget**: sum of (member_length × price / 10) must be < $${lvl.budget}. STRICT: count every member you list across all steps. If you're close, drop a redundant diagonal or use a cheaper material on non-critical members. Going over budget fails the level — don't.
9. **maxLength**: no single member longer than its material's maxLen.
10. **Tension-only**: rope/cable only work when the anchor end is ABOVE (lower Y) the road end. Don't put them underneath the road — they go slack.
11. **Triangulation**: for trusses, every interior road node is the apex of a triangle whose base is on the bottom chord.

## Teaching voice — pedagogy rules
The player is reading your "explanation" text while the bridge gets built. Talk to them.

- NEVER show internal keys ("wood_road"). Use displayNames ("Wood Road", "Wood Beam", "Steel Cable").
- NEVER show raw coordinates ("(180, 360)"). Use plain English: "the middle of the deck", "two grid cells below the road", "where the road meets the right cliff", "halfway between the tower and the deck".
- Coordinates only appear inside the "members" array — that's for the engine, never visible.
- Each "explanation" should teach ONE engineering concept tied to what's being placed:
  - WHY this shape: triangulation = rigid; arch = compression; cables = tension; pier = shorter spans.
  - WHY this material: stone road for heavy loads; cables can only PULL; steel beams when the load is high.
  - WHY this load path: forces flow from the deck → through structural members → to the anchors. If the path breaks, the bridge collapses.
  - HOW the physics matters in real engineering: bridges in the real world balance these same trade-offs.
- Tone: clear, energetic, high-school physics depth. 1-3 sentences. Not condescending. Use real terms (compression, tension, span, chord, hanger, thrust, deflection) — but always explain on first use.

### Good explanation examples — calibrate by these
Triangulation (truss being built):
"Notice the triangle forming under the deck: a triangle is the only shape whose angles can't change without one of its sides stretching or breaking. When the car's weight pushes the road down, that force gets redirected sideways along the diagonal beams into the cliffs instead of dropping straight down — that's why every bridge ever built uses triangles."

Pier:
"By running a vertical Wood Beam from the rock pier up to the deck we're splitting the gap into TWO short spans instead of one long one. Shorter spans deflect less under load, so each half can be built much lighter than a single long span would need to be. Real highway bridges follow this pattern — that's why you see piers in the water under most river crossings."

Suspension cable:
"Cables can only pull, never push, so we're using rope IN TENSION between the high tower and the road node. Gravity pulls the deck down → the rope stretches and pulls back up. If the cable were below the deck it'd go slack and contribute nothing — tension members must always have their anchor ABOVE the load they support."

## Step plan (3-5 steps):
1. Lay the full roadbed from LEFT ANCHOR to RIGHT ANCHOR.
2. Install the PRIMARY LOAD PATH of your chosen archetype (truss bottom chord, arch curve, main cable, central pier) — all the way to both anchors.
3. Connect each interior road node to that primary load path (diagonals, hangers, struts).
4. (Optional) Reinforce weak spots, switch to stronger material at the highest-stress members.

Each step's "members" array contains ONLY the new members for that step (don't repeat earlier ones).
The first step's "title" should be 2-4 words ("Lay the deck", "Hang the cable"), the explanation 1-3 sentences.

## Self-check BEFORE you output:
- Does every member connect to a node placed earlier OR an anchor?
- Does EVERY interior road node trace to an anchor through structural members?
- Is every material key in the allowed list?
- Is total cost < budget? (Run the sum.)
- Is every member ≤ its maxLen?
- Does each explanation teach a real engineering concept tied to that step?
If any answer is "no", fix it before returning.

## Output — return a single JSON object. No prose outside the JSON.
{
  "concept": "the core concept name (e.g. Triangulation, Suspension, Cantilever, Arch)",
  "archetype": "which bridge pattern you chose (truss/arch/suspension/cable-stayed/cantilever/beam-pier)",
  "summary": "One sentence recap of the design choice and why it works for THIS level.",
  "steps": [
    {
      "title": "Short action label (2-4 words)",
      "explanation": "1-3 sentences explaining the engineering concept — what force is at work, why this shape/material, how it ties into the load path. Real physics terms, no coordinates, no material keys.",
      "members": [
        {"x1": ${lvl.lX}, "y1": ${lvl.lY}, "x2": ${roadXs[1] || lvl.rX}, "y2": ${roadYs[1] || lvl.rY}, "type": "${roadMatKey}"}
      ]
    }
  ]
}

Variation seed: ${Math.floor(Math.random() * 1000)}. Use it as a hint to vary the angle of explanation across runs (different opening concept, different archetype if the level allows).`;
}

// Compute the set of preset anchor coordinates for a level. A beam endpoint
// is only allowed inside terrain if it coincides with one of these — otherwise
// it'd be "anchored to the cliff wall", which isn't a real attachment point.
function getAnchorSet(lvl, lvlDef) {
    const s = new Set([`${lvl.lX},${lvl.lY}`, `${lvl.rX},${lvl.rY}`]);
    if (lvlDef.extraAnchors) {
        for (const a of lvlDef.extraAnchors) {
            let x, y;
            if (a.side === "L")      { x = lvl.lX + a.dx;   y = lvl.lY + a.dy; }
            else if (a.side === "R") { x = lvl.rX + a.dx;   y = lvl.rY + a.dy; }
            else                     { x = lvl.midX + a.dx; y = lvl.lY + a.dy; }
            s.add(`${Math.round(x / GRID) * GRID},${Math.round(y / GRID) * GRID}`);
        }
    }
    return s;
}

function isInsideTerrain(x, y, lvl) {
    if (x <= lvl.lX && y > lvl.lY) return true;   // left cliff / table
    if (x >= lvl.rX && y > lvl.rY) return true;   // right cliff / table
    return false;
}

function stripCliffIntrusions(result, lvl, lvlDef) {
    const anchorSet = getAnchorSet(lvl, lvlDef);
    const nodeOk = (x, y) => anchorSet.has(`${x},${y}`) || !isInsideTerrain(x, y, lvl);
    for (const step of result.steps) {
        if (!Array.isArray(step.members)) continue;
        step.members = step.members.filter(m =>
            nodeOk(m.x1, m.y1) && nodeOk(m.x2, m.y2)
        );
    }
}

// Trim members until the AI's plan fits under budget. Strategy: keep all
// road members and any member whose endpoints are both anchors (load-path
// critical), then drop the most expensive non-essential members one by
// one until under budget. The model still occasionally overspends despite
// the prompt; this is a final guarantee.
function enforceBudget(result, lvl, lvlDef) {
    const allowed = lvlDef.materials || Object.keys(MATERIALS);
    const roadKeys = new Set(allowed.filter(k => MATERIALS[k]?.isRoad));
    const anchorSet = getAnchorSet(lvl, lvlDef);
    const isAnchorPt = (x, y) => anchorSet.has(`${x},${y}`);

    const memberCost = (m) => {
        const mat = MATERIALS[m.type];
        if (!mat) return 0;
        const len = Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
        return Math.round(len * mat.price / 10);
    };

    const totalCost = () => {
        let sum = 0;
        for (const s of result.steps || []) for (const m of s.members || []) sum += memberCost(m);
        return sum;
    };

    let budget = lvl.budget;
    let cost = totalCost();
    if (cost <= budget) return;

    // Build a list of removable members (skip roads; skip pure anchor-to-anchor)
    const candidates = [];
    for (let si = 0; si < (result.steps || []).length; si++) {
        const arr = result.steps[si].members || [];
        for (let mi = 0; mi < arr.length; mi++) {
            const m = arr[mi];
            if (roadKeys.has(m.type)) continue;
            if (isAnchorPt(m.x1, m.y1) && isAnchorPt(m.x2, m.y2)) continue;
            candidates.push({ si, mi, cost: memberCost(m) });
        }
    }
    // Drop the most expensive first, then re-key indices because splice shifts
    candidates.sort((a, b) => b.cost - a.cost);
    for (const c of candidates) {
        if (cost <= budget) break;
        const arr = result.steps[c.si].members;
        const idx = arr.findIndex(m => memberCost(m) === c.cost && !roadKeys.has(m.type));
        if (idx === -1) continue;
        cost -= memberCost(arr[idx]);
        arr.splice(idx, 1);
    }

    if (cost > budget) {
        // Last resort: surface a warning so the UI can show it.
        result._budgetWarning = `AI plan still $${cost - budget} over the $${budget} budget after trimming.`;
    }
}

function ensureRoadContinuity(result, lvl, lvlDef) {
    const allowed = lvlDef.materials || Object.keys(MATERIALS);
    const roadKeys = new Set(allowed.filter(k => MATERIALS[k]?.isRoad));
    if (roadKeys.size === 0) return;

    const key = (x, y) => `${x},${y}`;
    const adj = new Map();
    const addEdge = (a, b) => {
        if (!adj.has(a)) adj.set(a, new Set());
        if (!adj.has(b)) adj.set(b, new Set());
        adj.get(a).add(b);
        adj.get(b).add(a);
    };

    for (const step of result.steps) {
        for (const m of step.members || []) {
            if (roadKeys.has(m.type)) addEdge(key(m.x1, m.y1), key(m.x2, m.y2));
        }
    }

    const startKey = key(lvl.lX, lvl.lY);
    const endKey   = key(lvl.rX, lvl.rY);
    const visited = new Set([startKey]);
    const queue = [startKey];
    while (queue.length) {
        const cur = queue.shift();
        if (cur === endKey) return; // already continuous
        for (const nb of (adj.get(cur) || [])) {
            if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
        }
    }

    // Road doesn't span the gap — fill missing canonical segments
    const roadMatKey = [...roadKeys][0];
    const roadMax = MATERIALS[roadMatKey].maxLength;
    const roadSegs = Math.max(1, Math.ceil(lvl.gap / roadMax));
    const pts = [];
    for (let i = 0; i <= roadSegs; i++) {
        const x = lvl.lX + Math.round((i * lvl.gap) / roadSegs / GRID) * GRID;
        const y = lvl.lY + Math.round((i * lvl.hDiff) / roadSegs / GRID) * GRID;
        pts.push({ x, y });
    }

    const lastStep = result.steps[result.steps.length - 1];
    if (!Array.isArray(lastStep.members)) lastStep.members = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const a = key(pts[i].x, pts[i].y);
        const b = key(pts[i + 1].x, pts[i + 1].y);
        if (adj.get(a)?.has(b)) continue;
        lastStep.members.push({
            x1: pts[i].x, y1: pts[i].y,
            x2: pts[i + 1].x, y2: pts[i + 1].y,
            type: roadMatKey,
        });
        addEdge(a, b);
    }
}

// Fetch a lesson. Uses the dev .env key when present (standalone testing);
// otherwise routes through the portal proxy. Returns
// `{ concept, archetype, summary, steps }` on success, `{ error }` on failure.
export async function solveBridge(lvl, lvlDef) {
    const useLocal = !!getDevKey();
    const standalone = window.parent === window;
    if (!useLocal && standalone) {
        return { error: "AI helper requires the web portal." };
    }

    try {
        const prompt = buildPrompt(lvl, lvlDef);
        const requestBody = {
            model: "gpt-4o",
            max_tokens: 3500,
            temperature: 0.7,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: prompt }],
        };
        const data = useLocal ? await localAIRequest(requestBody) : await portalAIRequest(requestBody);

        const text = data.choices?.[0]?.message?.content || "";
        const jsonMatch =
            text.match(/```json\s*([\s\S]*?)```/) ||
            text.match(/\{[\s\S]*"steps"[\s\S]*\}/);
        if (!jsonMatch) return { error: "Could not parse AI response." };

        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const result = JSON.parse(jsonStr);

        if (!Array.isArray(result.steps) || result.steps.length === 0) {
            return { error: "AI response missing steps array." };
        }
        for (const s of result.steps) {
            if (typeof s.explanation !== "string" || !Array.isArray(s.members)) {
                return { error: "AI response step is malformed." };
            }
            if (typeof s.title !== "string") s.title = "Build step";
        }

        stripCliffIntrusions(result, lvl, lvlDef);
        ensureRoadContinuity(result, lvl, lvlDef);
        enforceBudget(result, lvl, lvlDef);

        return result;
    } catch (err) {
        return { error: `Request failed: ${err.message}` };
    }
}
