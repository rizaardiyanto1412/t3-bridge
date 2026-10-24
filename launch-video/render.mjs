// Renders index.html frame by frame into out/t3-bridge-launch.mp4.
// Voiceover clips in audio/ (made by voiceover.mjs) are mixed in when present.
//
//   node render.mjs            full video
//   node render.mjs --still 12 single frame at 12s -> out/still.png
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scenes, VOICE_LEAD, VOICE_TAIL } from "./timeline.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const FPS = 30;
const out = join(here, "out");
const audio = join(here, "audio");
mkdirSync(out, { recursive: true });

const clipLengths = existsSync(join(audio, "durations.json"))
  ? JSON.parse(readFileSync(join(audio, "durations.json"), "utf8"))
  : {};

let start = 0;
const timeline = scenes.map((s) => {
  const voice = clipLengths[s.id];
  const dur = Math.max(s.seconds, voice ? VOICE_LEAD + voice + VOICE_TAIL : 0);
  const entry = { id: s.id, start, dur };
  start += dur;
  return entry;
});
const total = start;

const icons = Object.fromEntries(
  ["slack", "discord", "telegram", "github"].map((name) => [
    name,
    readFileSync(require.resolve(`simple-icons/icons/${name}.svg`), "utf8"),
  ]),
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL(join(here, "index.html")).href);
await page.evaluate(() => document.fonts.ready);
await page.evaluate(([tl, ic]) => window.setup(tl, ic), [timeline, icons]);

const stillAt = process.argv.indexOf("--still");
if (stillAt !== -1) {
  for (const s of process.argv.slice(stillAt + 1)) {
    await page.evaluate((t) => window.render(t), Number(s));
    await page.screenshot({ path: join(out, `still-${s}.png`) });
  }
  await browser.close();
  process.exit(0);
}

const silent = join(out, "video-silent.mp4");
const ff = spawn("ffmpeg", [
  "-y", "-loglevel", "error",
  "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
  "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
  silent,
], { stdio: ["pipe", "inherit", "inherit"] });

const frames = Math.round(total * FPS);
for (let f = 0; f < frames; f++) {
  await page.evaluate((t) => window.render(t), f / FPS);
  const jpg = await page.screenshot({ type: "jpeg", quality: 95 });
  if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % (FPS * 5) === 0) console.log(`frame ${f}/${frames}`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await browser.close();

// Music bed sized to the final length, then the mix.
execFileSync("python3", ["-I", join(here, "music.py"), String(total), join(out, "music.wav")], { stdio: "inherit" });
const voices = timeline.filter((s) => clipLengths[s.id]);
const inputs = ["-i", silent, "-i", join(out, "music.wav")];
let filter;
if (voices.length) {
  voices.forEach((s) => inputs.push("-i", join(audio, `vo-${s.id}.mp3`)));
  const delayed = voices.map((s, i) => {
    const ms = Math.round((s.start + VOICE_LEAD) * 1000);
    return `[${i + 2}:a]aresample=44100,adelay=${ms}|${ms}[v${i}]`;
  });
  filter = [
    ...delayed,
    `${voices.map((_, i) => `[v${i}]`).join("")}amix=inputs=${voices.length}:normalize=0,volume=1.0,asplit[vo][key]`,
    `[1:a]volume=0.55[bed]`,
    `[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked]`,
    `[ducked][vo]amix=inputs=2:normalize=0,alimiter=limit=0.95[a]`,
  ].join(";");
} else {
  filter = `[1:a]volume=0.8,alimiter=limit=0.95[a]`;
}
const final = join(out, "t3-bridge-launch.mp4");
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", ...inputs,
  "-filter_complex", filter, "-map", "0:v", "-map", "[a]",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", final,
], { stdio: "inherit" });
console.log(`${final} (${total.toFixed(1)}s, ${voices.length ? "with" : "no"} voiceover)`);
