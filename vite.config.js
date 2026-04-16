import { defineConfig } from "vite";
import { readFileSync } from "fs";

const gameData = JSON.parse(readFileSync("./data/game.json", "utf-8"));
const isProd = process.env.NODE_ENV === "production";
const base = isProd ? `/staticGames/${gameData["game-id"]}/` : "./";

export default defineConfig({
    base,
});
