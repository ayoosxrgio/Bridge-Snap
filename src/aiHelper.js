import { MATERIALS, GRID } from "./constants.js";

let apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY || null;

export function setApiKey(key) {
    apiKey = key;
}

export function getApiKey() {
    return apiKey;
}

// Build a prompt describing the current level for Claude
function buildPrompt(lvl, lvlDef) {
    const matList = Object.entries(MATERIALS)
        .map(([k, m]) => {
            return `- ${m.label} (key="${k}"): breakForce=${m.breakForce}, compliance=${m.compliance}, cost=$${m.price}/10units, maxLen=${m.maxLength}, ${m.isRoad ? "ROAD SURFACE" : "structural"}, ${m.tensionOnly ? "tension-only" : "compression+tension"}`;
        })
        .join("\n");

    const anchors = [];
    anchors.push(`Left anchor: (${lvl.lX}, ${lvl.lY}) — fixed`);
    anchors.push(`Right anchor: (${lvl.rX}, ${lvl.rY}) — fixed`);
    if (lvlDef.extraAnchors) {
        for (const a of lvlDef.extraAnchors) {
            let x, y;
            if (a.side === "L") {
                x = lvl.lX + a.dx;
                y = lvl.lY + a.dy;
            } else if (a.side === "R") {
                x = lvl.rX + a.dx;
                y = lvl.rY + a.dy;
            } else {
                x = lvl.midX + a.dx;
                y = lvl.lY + a.dy;
            }
            x = Math.round(x / GRID) * GRID;
            y = Math.round(y / GRID) * GRID;
            anchors.push(`Extra anchor: (${x}, ${y}) — fixed`);
        }
    }

    return `You are an AI bridge engineering tutor in a bridge-building game. The player needs help building an efficient bridge for this level.

## Level: "${lvlDef.name}"
- Gap to span: ${lvl.gap} units (left anchor to right anchor)
- Height difference: ${lvl.hDiff} units (positive = right side is lower)
- Budget: $${lvl.budget}
- Vehicle: ${lvlDef.vType} (crosses left to right on road surfaces)
- Grid size: ${GRID} units (all coordinates snap to multiples of ${GRID})

## Anchor points (fixed nodes):
${anchors.join("\n")}

## Available materials:
${matList}

## Rules:
- Members connect two nodes at grid-snapped positions
- Vehicles only drive on "wood_road" members
- Road must form a continuous path from left anchor to right anchor
- New nodes can be created at any grid position, but members can only start from existing nodes
- Nodes on the cliff walls (x=${lvl.lX} or x=${lvl.rX}, below the surface) are automatically fixed
- Budget = sum of (member_length × material_price / 10) for all non-builtin members

## Task:
Design the most cost-efficient bridge that will safely support the vehicle. Return your answer as JSON with this exact format:

\`\`\`json
{
  "members": [
    {"x1": 200, "y1": 400, "x2": 225, "y2": 400, "type": "wood_road"},
    {"x1": 200, "y1": 400, "x2": 225, "y2": 425, "type": "wood_beam"}
  ],
  "explanation": "A 2-3 sentence explanation of WHY this design works — which engineering principles are at play, and why these materials were chosen for each role.",
  "concept": "The key engineering concept demonstrated (e.g. 'Triangulation', 'Suspension', etc.)"
}
\`\`\`

All coordinates must be multiples of ${GRID}. Keep cost under $${lvl.budget}. Prioritize structural integrity, then cost efficiency. The explanation should be educational — imagine you're teaching a student.`;
}

// Call Claude API to get an optimal bridge design
export async function solveBridge(lvl, lvlDef) {
    if (!apiKey) {
        return {
            error: "No API key set. Click the key icon to enter your Anthropic API key.",
        };
    }

    try {
        const prompt = buildPrompt(lvl, lvlDef);

        const response = await fetch(
            "https://api.anthropic.com/v1/messages",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                    "anthropic-dangerous-direct-browser-access": "true",
                },
                body: JSON.stringify({
                    model: "claude-sonnet-4-6",
                    max_tokens: 2048,
                    messages: [{ role: "user", content: prompt }],
                }),
            },
        );

        if (!response.ok) {
            const errText = await response.text();
            return {
                error: `API error (${response.status}): ${errText.slice(0, 200)}`,
            };
        }

        const data = await response.json();
        const text = data.content?.[0]?.text || "";

        // Extract JSON from response
        const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ||
            text.match(/\{[\s\S]*"members"[\s\S]*\}/);
        if (!jsonMatch) {
            return { error: "Could not parse AI response." };
        }

        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const result = JSON.parse(jsonStr);

        if (!result.members || !Array.isArray(result.members)) {
            return { error: "AI response missing members array." };
        }

        return result;
    } catch (err) {
        return { error: `Request failed: ${err.message}` };
    }
}
