import fs from "node:fs";
import path from "node:path";
import { renderSoundDesign } from "../video/audio/production.mjs";

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const inputVideo = path.resolve(value("--input"));
const outputVideo = path.resolve(value("--output"));
const designFile = path.resolve(value("--design"));
if (!value("--input") || !value("--output") || !value("--design")) {
  console.error("Usage: node scripts/render_sound_design.mjs --input in.mp4 --output out.mp4 --design sound-design.json [--allow-trial]");
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, "..");
const policy = JSON.parse(fs.readFileSync(path.join(root, "config", "sound_policy.json"), "utf8"));
const design = JSON.parse(fs.readFileSync(designFile, "utf8"));
const ffmpeg = path.join(root, ".runtime", "ffmpeg", "bin", "ffmpeg.exe");
try {
  const result = await renderSoundDesign({ ffmpeg, inputVideo, outputVideo, design, policy, allowTrial: process.argv.includes("--allow-trial") });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
