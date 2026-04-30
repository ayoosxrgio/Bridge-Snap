import kaplay from "kaplay";
import { menuScene } from "./scenes/menu.js";

import { gameScene } from "./scenes/game.js";
import { initAssistantBridge } from "./assistantBridge.js";

// Fixed logical "design" resolution so all UI is laid out on a consistent
// 1280×720 grid, regardless of which monitor the player is on. `stretch: true`
// with `letterbox: false` makes Kaplay fill the entire browser window with the
// canvas — any aspect-ratio mismatch is absorbed as a mild non-uniform stretch
// instead of letterbox bars. Laptop 16:10 and desktop 16:9 both end up full-screen.
const DESIGN_W = 1280;
const DESIGN_H = 720;

const k = kaplay({
    width: DESIGN_W,
    height: DESIGN_H,
    background: [59, 47, 32],
    stretch: true,
    letterbox: false,
    crisp: false,
    global: false,
    touchToMouse: true,
});

const BASE = import.meta.env.BASE_URL;

k.loadFont("PatrickHand", `${BASE}fonts/PatrickHand.woff2`);
k.loadFont("PressStart2P", `${BASE}fonts/PressStart2P.woff2`);
k.loadSprite("logo", `${BASE}assets/ui/LOGO.png`);
k.loadSprite("bridgeLeft", `${BASE}assets/ui/Left Bridge.png`);
k.loadSprite("bridgeRight", `${BASE}assets/ui/Right Bridge.png`);

// Flag animation (5 frames horizontal spritesheet)
k.loadSprite("flag", `${BASE}assets/misc/flag animation.png`, {
    sliceX: 5,
    anims: {
        wave: { from: 0, to: 4, loop: true, speed: 8 },
    },
});
// Blue variant — same spritesheet, recolored cloth. Used for car B finish flags.
k.loadSprite("flagBlue", "/assets/misc/flag blue animation.png", {
    sliceX: 5,
    anims: {
        wave: { from: 0, to: 4, loop: true, speed: 8 },
    },
});

// Vehicle sprites (retro pixel art)
k.loadSprite("veh_bicycle",  `${BASE}assets/vehicles/motor-cycle-male.png`);
k.loadSprite("veh_car",      `${BASE}assets/vehicles/blue-car.png`);
k.loadSprite("veh_datsun",   `${BASE}assets/vehicles/brown-datsun.png`);
k.loadSprite("veh_sports",   `${BASE}assets/vehicles/yellow-sports-car.png`);
k.loadSprite("veh_corolla",  `${BASE}assets/vehicles/red-corolla.png`);
k.loadSprite("veh_jeep",     `${BASE}assets/vehicles/pink-jeep.png`);
k.loadSprite("veh_icecream", `${BASE}assets/vehicles/ice-cream-van-1.png`);
k.loadSprite("veh_truck",    `${BASE}assets/vehicles/luton-van.png`);
k.loadSprite("veh_camper",   `${BASE}assets/vehicles/camper-van.png`);
k.loadSprite("veh_plumbing", `${BASE}assets/vehicles/white-plumbing-van.png`);
k.loadSprite("veh_bus",      `${BASE}assets/vehicles/yellow-bus.png`);
k.loadSprite("veh_flatbed",  `${BASE}assets/vehicles/flatbed-with-house.png`);
k.loadSprite("veh_boat",     `${BASE}assets/vehicles/SUV-towing-boat.png`);

k.scene("menu", (params) => menuScene(k, params));

k.scene("game", (params) => gameScene(k, params));

k.onLoad(() => {
    initAssistantBridge();
    k.go("menu");
});
