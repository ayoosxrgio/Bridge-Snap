import { defineConfig } from "vite";
import { readFileSync } from "fs";

const gameData = JSON.parse(readFileSync("./data/game.json", "utf-8"));

export default defineConfig(({ command }) => ({
    base: command === "build" ? `/staticGames/${gameData["game-id"]}/` : "/",
}));
