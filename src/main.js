import kaplay from "kaplay";
import { menuScene } from "./scenes/menu.js";

import { gameScene } from "./scenes/game.js";
import { initAssistantBridge } from "./assistantBridge.js";

const k = kaplay({
    width: window.innerWidth || 1280,
    height: window.innerHeight || 720,
    background: [59, 47, 32],
    stretch: true,
    letterbox: false,
    crisp: false,
    global: false,
    touchToMouse: true,
});

k.loadFont("PatrickHand", "/fonts/PatrickHand.woff2");
k.loadFont("PressStart2P", "/fonts/PressStart2P.woff2");
k.loadSprite("logo", "/assets/ui/LOGO.png");
k.loadSprite("bridgeLeft", "/assets/ui/Left Bridge.png");
k.loadSprite("bridgeRight", "/assets/ui/Right Bridge.png");

// Flag animation (5 frames horizontal spritesheet)
k.loadSprite("flag", "/assets/misc/flag animation.png", {
    sliceX: 5,
    anims: {
        wave: { from: 0, to: 4, loop: true, speed: 8 },
    },
});

// Vehicle sprites (retro pixel art)
k.loadSprite("veh_bicycle",  "/assets/vehicles/motor-cycle-male.png");
k.loadSprite("veh_car",      "/assets/vehicles/blue-car.png");
k.loadSprite("veh_datsun",   "/assets/vehicles/brown-datsun.png");
k.loadSprite("veh_sports",   "/assets/vehicles/yellow-sports-car.png");
k.loadSprite("veh_corolla",  "/assets/vehicles/red-corolla.png");
k.loadSprite("veh_jeep",     "/assets/vehicles/pink-jeep.png");
k.loadSprite("veh_icecream", "/assets/vehicles/ice-cream-van-1.png");
k.loadSprite("veh_truck",    "/assets/vehicles/luton-van.png");
k.loadSprite("veh_camper",   "/assets/vehicles/camper-van.png");
k.loadSprite("veh_plumbing", "/assets/vehicles/white-plumbing-van.png");
k.loadSprite("veh_bus",      "/assets/vehicles/yellow-bus.png");
k.loadSprite("veh_flatbed",  "/assets/vehicles/flatbed-with-house.png");
k.loadSprite("veh_boat",     "/assets/vehicles/SUV-towing-boat.png");

k.scene("menu", (params) => menuScene(k, params));

k.scene("game", (params) => gameScene(k, params));

k.onLoad(() => {
    initAssistantBridge();
    k.go("menu");
});
