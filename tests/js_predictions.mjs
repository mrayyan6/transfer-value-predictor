// Called from test_export.py: runs the browser models over a list of players
// and prints the predictions as JSON so python can compare them.
import { readFileSync } from "node:fs";
import { predict } from "../web/js/model.js";

const [modelPath, playersPath] = process.argv.slice(2);
const model = JSON.parse(readFileSync(modelPath, "utf8"));
const players = JSON.parse(readFileSync(playersPath, "utf8"));
console.log(JSON.stringify(players.map((p) => predict(model, p))));
