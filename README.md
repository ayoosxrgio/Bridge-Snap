# Bridge Snap

An educational bridge construction game built with [Kaplay](https://kaplayjs.com/). Design and test bridges through physics — learn about trusses, tension, compression, and material science.

## How to Play

- Drag from any **anchor node** to place a structural member
- Choose your material from the toolbar — 3 road types, 2 beam types, rope, and steel cable
- Use the **Line Fill** tool (F) to quickly lay segments across a span
- Use the **Curve** tool (C) to bend existing members into arcs
- Stay **under budget**, then hit **Play** to simulate
- If the vehicle crosses safely, you win — earn S/A/B/C grades based on cost efficiency

## Materials

| Material | Type | Strength | Cost | Notes |
|----------|------|----------|------|-------|
| Wood Road | Road | Low | $120 | Cheap driving surface, breaks under heavy loads |
| Reinforced Road | Road | Medium | $250 | Handles trucks and heavier vehicles |
| Stone Road | Road | High | $400 | Handles the heaviest loads |
| Wood Beam | Structural | Medium | $35 | Cheap support beams |
| Steel Beam | Structural | Very High | $450 | Strongest rigid member |
| Rope | Tension | Low | $60 | Cheap, tension only — goes slack when pushed |
| Steel Cable | Tension | High | $150 | Strong tension member for suspension bridges |

## Vehicles

15 levels with 12 vehicle types ranging from a bicycle (mass 10) to a flatbed truck (mass 400). Heavier vehicles require stronger bridges with proper triangulation and support.

## Levels

6 chapters, 15 levels teaching progressive engineering concepts:

- **Ch 1** — Basics, triangulation, span, slopes
- **Ch 2** — Steel, material optimization
- **Ch 3** — Tension, suspension bridges
- **Ch 4** — Piers, reinforcement
- **Ch 5** — Efficiency, combined challenges
- **Ch 6** — Multi-vehicle, mastery

## Tech Stack

- [Kaplay](https://kaplayjs.com/) — game framework
- [Vite](https://vitejs.dev/) — build tool
- Custom XPBD constraint-based physics engine
- Portal integration via stem-assistant-bridge for AI tutoring

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Output goes to `dist/`.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| 1-7 | Select material |
| D | Toggle delete mode |
| F | Toggle line fill tool |
| C | Toggle curve tool |
| Z | Undo last member |
| Space | Play / Stop simulation |
| Esc | Back to level select |
