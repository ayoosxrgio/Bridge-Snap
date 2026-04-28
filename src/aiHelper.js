import { MATERIALS, GRID } from "./constants.js";

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

// Build a Socratic-tutor prompt. The model returns a step-by-step lesson
// where each step is a multiple-choice question followed by the members to
// place when the player answers, so the bridge grows as the lesson progresses.
export function buildPrompt(lvl, lvlDef) {
    // Only include materials actually unlocked for THIS level
    const allowedKeys = lvlDef.materials || Object.keys(MATERIALS);
    const allowedMats = allowedKeys.filter(k => MATERIALS[k]);
    const matList = allowedMats
        .map(k => {
            const m = MATERIALS[k];
            const role = m.isRoad ? "ROAD SURFACE (drive on this)" : (m.tensionOnly ? "TENSION-ONLY (goes slack in compression — use as a cable from a HIGH anchor to pull the road up)" : "structural beam (compression + tension)");
            // Internal key is for YOUR "members" output only — the DISPLAY NAME
            // is "${m.label}" (this is what you must use in question and option text).
            return `- key="${k}" displayName="${m.label}" — breakForce=${m.breakForce}, cost=$${m.price}/10 units length, maxLen=${m.maxLength}. ${role}.`;
        })
        .join("\n");
    const roadKeys = allowedMats.filter(k => MATERIALS[k].isRoad);
    const beamKeys = allowedMats.filter(k => !MATERIALS[k].isRoad && !MATERIALS[k].tensionOnly);
    const tensionKeys = allowedMats.filter(k => MATERIALS[k].tensionOnly);

    // ── Pre-compute geometric scaffolding so the model has real numbers ──
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

    return `You are a SHARP bridge-engineering tutor. Teach through a Socratic multiple-choice lesson while the bridge actually grows on-screen as the player answers. Every question should make the player think about a concrete decision on THIS bridge — not parrot vocabulary.

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

Grouped for convenience:
- ROAD material(s): ${roadKeys.length ? roadKeys.join(", ") : "(none — unusual!)"}
- STRUCTURAL beam(s): ${beamKeys.length ? beamKeys.join(", ") : "(none — unusual!)"}
- TENSION-ONLY: ${tensionKeys.length ? tensionKeys.join(", ") : "(none — no suspension possible here)"}

## Suggested geometry for THIS level (use if it fits — adapt for cable/suspension designs):
- Roadbed needs ${roadSegs} segment(s) to span ${lvl.gap} units
- Roadbed x,y points: ${roadXs.map((x, i) => `(${x},${roadYs[i]})`).join(", ")}
- Roadbed members should go: ${roadbedPairs}
- Suggested bottom-chord support row ${supDepth}u BELOW roadbed: ${supList}

## Bridge archetypes — PICK THE ONE THAT FITS THIS LEVEL and commit to it
Don't mix patterns ad-hoc. Decide on a design first, then all your members should serve it.

- **Warren/Pratt TRUSS** (for Triangulation / plain beam levels):
  Road on top chord. Bottom chord below (same length, parallel). Diagonals zig-zag between them forming triangles. Every interior road node is the APEX of at least one triangle whose base sits on the bottom chord. Bottom chord EXTENDS TO BOTH ANCHORS.
- **ARCH** (good for rigid stone/reinforced road over a canyon):
  Arch apex in the middle, curving down to the two bottom anchors (or to the bridge endpoints sitting on them). Short vertical struts rise from the arch to each interior road node. The arch carries compression; vehicles rest on top.
- **SUSPENSION** (requires high anchors ABOVE the road):
  Main cable from high-anchor to high-anchor draping below its anchors. Vertical hangers (also cable/rope) drop from the main cable to each road node. Cables MUST pull up, never push down.
- **CABLE-STAYED** (one high tower or high anchor):
  Separate cables run from the top of the tower directly to each road node, like a fan. Each cable is straight.
- **CANTILEVER** (when only one anchor is available on one side):
  Rigid truss extends from the supported cliff past the gap. Back-stays / counter-weight beams anchor the root so it doesn't tip over.
- **BEAM + PIER** (tall levels with mid-gap anchor): single vertical pier from mid-gap anchor straight up to the roadbed, then roadbed spans between pier and both cliffs.

If the concept is "${lvlDef.concept}", the archetype of choice is usually obvious — commit to it.

## HARD RULES (the final bridge MUST satisfy all of these):
1. **Connectivity**: every member connects TWO nodes. A node is legal only if it (a) IS an anchor, or (b) is also an endpoint of ANOTHER member that traces back to an anchor.
2. **NO ANCHORING INTO THE CLIFF**: the ONLY valid attachment points that are inside the cliff/table geometry are the anchors listed above. Any non-anchor endpoint must be in OPEN AIR — i.e. NOT inside a cliff wall. Formally: a non-anchor point (x, y) must satisfy BOTH of these: if x ≤ ${lvl.lX} then y ≤ ${lvl.lY}; if x ≥ ${lvl.rX} then y ≤ ${lvl.rY}. If you want to "anchor" something to a cliff, the cliff-top corner anchor is your ONLY option. Do not invent attachment points on the side of a cliff.
3. **Road continuity**: road members form one unbroken chain from LEFT ANCHOR (${lvl.lX},${lvl.lY}) to RIGHT ANCHOR (${lvl.rX},${lvl.rY}).
4. **Load path to anchors**: pick ANY interior road node and trace through structural members — you MUST reach an anchor. Prefer designs where the bottom-chord/truss EXTENDS ALL THE WAY to both anchors, or where cables from high anchors hold up each interior node. NEVER leave a road hanging only from a truss that dead-ends mid-span.
5. **Trusses need BOTH chords**: if you pick a truss archetype, you need the top chord (the road itself) AND a bottom chord (a parallel chain of beams below the road, connecting the same endpoints) AND diagonals between them. A bare zigzag below the road with no horizontal bottom chord is NOT a truss — the zigzag apexes just swing freely and the bridge collapses.
6. **Materials**: you may ONLY use the material keys listed above. Do not invent keys.
7. **Coordinates**: every x,y is a multiple of ${GRID}.
8. **Budget**: sum of (member_length × price / 10) must be < $${lvl.budget}.
9. **maxLength**: no single member longer than its material's maxLen.
10. **Tension-only**: rope/cable only work when the anchor end is ABOVE (lower Y) the road end. Don't put them underneath the road — they'll go slack.
11. **Triangulation**: for truss designs, every interior road node must be the apex of a triangle whose base is on the bottom chord.

## Writing good questions — pedagogy rules (read carefully)

This is a LEARNING tool for students. Your questions are how they build physical intuition about bridges.

**Voice rules (non-negotiable):**
- In visible text (question, options, explanations), NEVER show internal keys like "wood_road" — always use the displayName (e.g. "Wood Road", "Wood Beam", "Steel Cable").
- NEVER show raw coordinates like "(180, 360)" to the student. Describe positions in PLAIN ENGLISH: "the middle of the deck", "over the left cliff", "just above the canyon floor", "where the road meets the right anchor", "halfway between the tower and the deck". A student should never see a pair of numbers.
- Internal x/y values only appear inside the "members" array of the JSON — students never see that; it's for the physics engine.

**Content rules:**
- Questions should test PHYSICAL REASONING — what force is at work, what would fail, which shape distributes load, how compression vs tension differ — NOT "which material key is which". The player can see the material list on screen; don't quiz them on its contents.
- Every wrong option must be a real misconception a beginner would pick, explained by the physics (e.g. "a single vertical post under the deck" reads plausible but doesn't stop sag — that's the lesson).
- No yes/no questions. No "which is true about X" vocabulary questions. Ask what to DO in this specific situation.
- The "explainCorrect" should teach the principle in 1–2 sentences of real physics language — forces, triangles, tension, compression, load paths — at a high-school level.
- The "explainWrong" should name the failure mode that option would cause: "without cross-bracing, the car's weight pushes the center road node down and the deck snaps", not "it's wrong because it's wrong".

### Good-question examples — use these to calibrate TONE and DEPTH (don't copy the text)

Triangulation level (flat span, wood beams available):
Q: "You've laid the road across the gap. The car's weight will push down hardest at the middle of the deck. What shape, placed UNDER the deck, actually stops the middle from dropping?"
Options (any order):
- A triangle formed by two beams running from the middle of the deck down-outward to the cliffs on either side — the two beams meet above the canyon floor
- A single vertical post straight down from the middle of the deck to a new point below
- A horizontal beam running left-to-right under the deck, hanging in the gap
Correct answer: the triangle. explainCorrect: "A triangle is the only shape that can't change its angles without one of its sides stretching or breaking — the car's weight pushes sideways along the two beams into the cliffs instead of dropping straight down." explainWrong: "A lone vertical post has nothing stopping it from swinging sideways, so it falls over under load. A horizontal beam hanging in mid-air isn't connected to anything solid and just drops with the deck."

${hasMidPier ? `Pier level (mid-gap rock pier available, like the level you're on now):
Q: "There's a stone pier sticking up out of the water in the middle of the gap. What's the smartest way to use it for this build?"
Options:
- Run a single vertical wood beam straight up from the pier to the deck right above it, then triangulate each half-span (pier→cliff) underneath with diagonals
- Ignore the pier and span the entire gap with one long truss as if the pier weren't there
- Run cables from the pier diagonally up to the cliff anchors as a substitute for the deck
Correct answer: vertical post + triangulation in each half. explainCorrect: "Splitting the span at the pier turns one long span into two short ones. The vertical pier post takes the deck's weight straight down into the rock, and each half can be triangulated cheaply since it's much shorter." explainWrong: "Spanning the whole gap when you have a free pier is wasteful — it forces the truss to be much taller and heavier. Diagonal cables from a low pier point downward to the cliffs, which doesn't help hold the deck up at all."

` : ""}Suspension level (tall anchors above the deck):
Q: "The two tall anchors above the deck are perfect for a suspension bridge. What should hang between them to carry the deck's weight?"
Options:
- A single straight cable stretched tight between the two tall anchors — the deck hangs from that
- A draping curved main cable between the two tall anchors, with short vertical hangers dropping from the drape to each point on the deck
- Two diagonal cables forming an X between opposing tall anchors and road ends
Correct answer: the draping cable with hangers. explainCorrect: "Suspension bridges work because cables are strongest in tension — and a drape lets a long cable split the deck's weight equally between both towers. Short vertical hangers then pull each part of the deck up toward the drape." explainWrong: "A single straight cable can't hold the middle of the deck up — the middle is far below the cable. A crossed X doesn't support anything vertical; it resists lateral wind, not weight."

## Step order (3–5 steps):
1. Lay the full roadbed from LEFT ANCHOR to RIGHT ANCHOR.
2. Install the PRIMARY LOAD PATH of your chosen archetype (main cable, arch apex, truss bottom chord + diagonals, pier, etc.) — members that REACH ALL THE WAY to both anchors.
3. Connect each interior road node to the primary load path (hangers, struts, or triangle apexes).
4. (Optional) Reinforce weak spots, add back-stays or counterweights, switch to stronger material if budget allows.
Each step's "members" array should ONLY contain members not already placed in earlier steps.

## Self-check BEFORE you output:
- Does every member connect to a node placed earlier or an anchor?
- Does EVERY interior road node trace to an anchor through structural members?
- Is every material key in the allowed list?
- Is total cost < budget? (Run the sum.)
- Is every member ≤ its maxLen?
- Is each question tied to THIS level, and does each wrong option represent a real misconception?
If any answer is "no", FIX it before returning.

## Output — return a single JSON object. No prose outside the JSON.
Put the correct answer at WHICHEVER index (0, 1, or 2) — the UI shuffles options before showing them, so position doesn't matter; pick whatever reads best and set "correct" to that index honestly.

{
  "concept": "the core concept name (e.g. Triangulation, Suspension, Cantilever, Arch)",
  "archetype": "which bridge pattern you chose (truss/arch/suspension/cable-stayed/cantilever/beam-pier)",
  "steps": [
    {
      "question": "A level-specific question that mentions real coordinates, materials, or numbers from THIS level",
      "options": ["option phrased concretely with real numbers", "another concrete option", "third concrete option"],
      "correct": 0,
      "explainCorrect": "WHY the correct option works here, citing the actual physics/numbers.",
      "explainWrong": "Name the specific failure mode(s) of the wrong options.",
      "members": [
        {"x1": ${lvl.lX}, "y1": ${lvl.lY}, "x2": ${roadXs[1] || lvl.rX}, "y2": ${roadYs[1] || lvl.rY}, "type": "${roadMatKey}"}
      ]
    }
  ],
  "summary": "One sentence recap tied to ${lvlDef.concept}, naming the archetype used."
}

## Variety — VARY YOUR APPROACH each time
This player may run the AI tutor multiple times on the same level. Don't repeat the same lesson verbatim. Ways to vary:
- Pick different question angles (force-on-the-deck → load-path-to-anchors → why-this-shape-not-that-one).
- Vary the order of steps (you don't always have to do roadbed first if a different starter makes more pedagogical sense).
- For trusses, alternate between Warren (alternating diagonals) and Pratt (vertical members) patterns.
- For pier levels, vary HOW the pier is used (single vertical post vs. triangulated A-frame from pier to cliffs).
- Vary which materials you emphasize when multiple are available.
Treat this prompt's variation seed: ${Math.floor(Math.random() * 1000)}. Use it as a hint to pick a different angle than your default — different first question, different step ordering, etc.`;
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

// Returns true if (x,y) is inside a solid cliff/table interior. Below the
// cliff-top on either approach is solid ground — beam endpoints can't live
// there unless the point is a preset anchor (handled by the caller).
function isInsideTerrain(x, y, lvl) {
    if (x <= lvl.lX && y > lvl.lY) return true;   // left cliff / table
    if (x >= lvl.rX && y > lvl.rY) return true;   // right cliff / table
    return false;
}

// Drop any member whose endpoint sits inside a cliff and isn't on a preset
// anchor. GPT-4o sometimes "extends" a diagonal into the cliff wall, which
// the physics engine then treats as a floating node — the bridge fails
// spectacularly even though the structure looked complete on screen.
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

// Walk all road members the AI placed and check whether you can trace a path
// of road segments from the left anchor to the right anchor. If not, append
// the missing canonical road segments (using the same geometry the prompt
// suggested) to the final step so the bridge always spans the gap.
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
        if (cur === endKey) return; // already continuous — nothing to do
        for (const nb of (adj.get(cur) || [])) {
            if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
        }
    }

    // Road doesn't span the gap. Compute the canonical roadbed and fill in
    // any segment that isn't already covered by an AI-placed road member.
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

// Fetch a lesson from OpenAI via the portal proxy. Returns
// `{ concept, steps, summary }` on success, `{ error }` on failure.
export async function solveBridge(lvl, lvlDef) {
    if (window.parent === window) {
        return { error: "AI tutor requires the web portal." };
    }

    try {
        const prompt = buildPrompt(lvl, lvlDef);
        const data = await portalAIRequest({
            model: "gpt-4o",               // full 4o — spatial reasoning matters here
            max_tokens: 3500,
            // Bumped for variety — the spatial-reasoning rules in the
            // prompt keep geometry stable; this temp lets question angles
            // and archetype choices vary across runs of the same level.
            temperature: 0.7,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: prompt }],
        });

        const text = data.choices?.[0]?.message?.content || "";

        // json_object mode returns pure JSON; still handle fenced fallback for robustness
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
            if (typeof s.question !== "string" || !Array.isArray(s.options) ||
                typeof s.correct !== "number" || !Array.isArray(s.members)) {
                return { error: "AI response step is malformed." };
            }
        }

        // Drop any members whose endpoints fall inside a cliff wall (unless
        // the endpoint is a preset anchor). Done BEFORE the road-continuity
        // pass so a cliff-intrusive "road" member doesn't count as coverage.
        stripCliffIntrusions(result, lvl, lvlDef);

        // Guarantee road continuity. GPT-4o frequently stops the roadbed short
        // of the right anchor — no amount of prompt-pleading reliably fixes
        // this, so we check it in code and append any missing canonical road
        // segments to the final step's members.
        ensureRoadContinuity(result, lvl, lvlDef);

        // Shuffle each step's options client-side. GPT-4o has a strong bias to
        // put the correct answer at the index shown in the example output (we
        // saw it land on index 1 virtually every time). Randomizing here makes
        // the lesson feel like a real quiz instead of "always pick B".
        for (const s of result.steps) {
            if (s.correct < 0 || s.correct >= s.options.length) continue;
            const correctText = s.options[s.correct];
            for (let i = s.options.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [s.options[i], s.options[j]] = [s.options[j], s.options[i]];
            }
            s.correct = s.options.indexOf(correctText);
        }

        return result;
    } catch (err) {
        return { error: `Request failed: ${err.message}` };
    }
}
