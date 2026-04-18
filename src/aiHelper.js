import { MATERIALS, GRID } from "./constants.js";

let apiKey = import.meta.env.VITE_OPENAI_API_KEY || null;

export function setApiKey(key) {
    apiKey = key;
}

export function getApiKey() {
    return apiKey;
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
            return `- "${k}" — ${m.label}: breakForce=${m.breakForce}, cost=$${m.price}/10 units length, maxLen=${m.maxLength}. ${role}.`;
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
    if (lvlDef.extraAnchors) {
        for (const a of lvlDef.extraAnchors) {
            let x, y, where;
            if (a.side === "L") { x = lvl.lX + a.dx; y = lvl.lY + a.dy; where = a.dy < 0 ? "high tower on LEFT cliff" : "buried in LEFT cliff wall"; }
            else if (a.side === "R") { x = lvl.rX + a.dx; y = lvl.rY + a.dy; where = a.dy < 0 ? "high tower on RIGHT cliff" : "buried in RIGHT cliff wall"; }
            else { x = lvl.midX + a.dx; y = lvl.lY + a.dy; where = "mid-gap pier"; }
            x = Math.round(x / GRID) * GRID;
            y = Math.round(y / GRID) * GRID;
            anchors.push(`- EXTRA ANCHOR (${x}, ${y}) — ${where}`);
        }
    }

    const vehicleMass = lvlDef.multiVehicle
        ? lvlDef.multiVehicle.map(mv => mv.vType).join(" + ")
        : lvlDef.vType;

    return `You are an AI bridge-engineering tutor. Teach the player through a SOCRATIC multiple-choice lesson while actually building the bridge in pieces.

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

## HARD RULES (the final bridge MUST satisfy all of these):
1. **Connectivity**: every member connects TWO nodes. A node is legal only if it (a) IS an anchor, or (b) is also an endpoint of ANOTHER member that traces back to an anchor. No floating members, no truss dangling only from the road.
2. **Road continuity**: road members form one unbroken chain from LEFT ANCHOR (${lvl.lX},${lvl.lY}) to RIGHT ANCHOR (${lvl.rX},${lvl.rY}).
3. **Load path to anchors**: pick ANY interior road node and trace through structural members — you MUST reach an anchor (L, R, or extra). If a road node's only connections are to other road nodes, the whole middle section sags and fails. Prefer designs where the bottom-chord/truss EXTENDS ALL THE WAY to both anchors, or where cables from high anchors hold up each interior node.
4. **Materials**: you may ONLY use the material keys listed above. Do not invent keys.
5. **Coordinates**: every x,y is a multiple of ${GRID}.
6. **Budget**: sum of (member_length × price / 10) must be < $${lvl.budget}. Members' default lengths equal Euclidean distance between endpoints.
7. **maxLength**: no single member longer than its material's maxLen.
8. **Tension-only**: rope/cable only work when the anchor end is ABOVE (lower Y) the road end. Don't put them underneath the road — they'll go slack.
9. **Triangulation**: every interior road node should sit at the top of a triangle made from two structural members going to different nodes below — this is what prevents sag.

## Question variety — VERY IMPORTANT
Do NOT ask the same generic questions every level. Write questions that reflect THIS level's concept ("${lvlDef.concept}"), its terrain, its materials, and its vehicle. Examples of concept-specific question styles:
- Triangulation levels: "Which shape can't change angles without breaking a side?"
- Suspension levels: "The anchors above the road suggest what kind of bridge? / What pulls the road up?"
- Cantilever levels: "Only one cliff gives us anchor support here — how do we hold the far end?"
- Steel levels: "Steel is 4× stronger but 13× the price of wood. Where does it pay off?"
- Slope levels: "A downhill road pushes sideways. How do we resist THRUST?"
- Tension levels: "Rope costs little but only helps in one direction. Which direction?"
- Multi-vehicle / heavy levels: "Two loads at once means what about total force?"
- Budget-tight levels: "We can afford either a whole steel truss or half the wood — which is smarter here?"
Phrase options specifically (include actual material names or geometry like "add a triangle under the center" instead of just "add more beams"). Wrong options should be plausible misconceptions, not silly.

## Step order (3–5 steps):
1. Lay the full roadbed from LEFT ANCHOR to RIGHT ANCHOR.
2. Carry the load to the anchors (primary support: trusses touching both anchors, piers, or cables from overhead anchors depending on level).
3. Triangulate / reinforce any weak spots.
4. (Optional) Add tension members or optimize material choice for budget.
Final step's members close the bridge — after step N, the bridge MUST meet every HARD RULE.

## Self-check BEFORE you output — for each step, mentally run through:
- Does every member in this step's "members" array connect to either an anchor or a node already placed by this or an earlier step?
- After the final step, trace from every interior road node through structural members — does it reach an anchor?
- Is every material key in the allowed list?
- Is total cost < budget?
- Is every member ≤ its maxLen?
If any answer is "no", FIX the members before returning.

## Output — return a single JSON object. No prose outside the JSON.
{
  "concept": "the core concept name (e.g. Triangulation, Suspension, Cantilever, Truss)",
  "steps": [
    {
      "question": "A level-specific question about the engineering decision",
      "options": ["plausible wrong", "correct answer phrased concretely", "another plausible wrong"],
      "correct": 1,
      "explainCorrect": "WHY the correct option works for THIS level.",
      "explainWrong": "WHY the wrong options would fail here.",
      "members": [
        {"x1": ${lvl.lX}, "y1": ${lvl.lY}, "x2": ${roadXs[1] || lvl.rX}, "y2": ${roadYs[1] || lvl.rY}, "type": "${roadMatKey}"}
      ]
    }
  ],
  "summary": "One sentence recap tied to ${lvlDef.concept}."
}`;
}

// Fetch a lesson from OpenAI. Returns `{ concept, steps, summary }` on success,
// `{ error }` on failure.
export async function solveBridge(lvl, lvlDef) {
    if (!apiKey) {
        return { error: "No API key set. Click the key icon to enter your OpenAI API key." };
    }

    try {
        const prompt = buildPrompt(lvl, lvlDef);
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: "gpt-4o",               // full 4o — spatial reasoning matters here
                max_tokens: 3500,
                temperature: 0.2,
                response_format: { type: "json_object" },
                messages: [{ role: "user", content: prompt }],
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            return { error: `API error (${response.status}): ${errText.slice(0, 200)}` };
        }

        const data = await response.json();
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

        return result;
    } catch (err) {
        return { error: `Request failed: ${err.message}` };
    }
}
