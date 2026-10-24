// Generates one ElevenLabs voiceover clip per scene into audio/, then records
// their lengths in audio/durations.json so render.mjs can time the scenes to them.
//
//   ELEVENLABS_API_KEY=... node voiceover.mjs
//   ELEVENLABS_VOICE_ID=<voice id> picks another voice (default: George)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scenes } from "./timeline.mjs";

const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error("Set ELEVENLABS_API_KEY first.");
  process.exit(1);
}
const voice = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const model = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
const audio = join(dirname(fileURLToPath(import.meta.url)), "audio");
mkdirSync(audio, { recursive: true });

const durations = {};
for (const [i, scene] of scenes.entries()) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text: scene.voice,
      model_id: model,
      // Neighbouring lines keep the delivery continuous across clips.
      previous_text: scenes[i - 1]?.voice,
      next_text: scenes[i + 1]?.voice,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    console.error(`ElevenLabs ${res.status} for "${scene.id}": ${await res.text()}`);
    process.exit(1);
  }
  const file = join(audio, `vo-${scene.id}.mp3`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  durations[scene.id] = Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString(),
  );
  console.log(`${scene.id}: ${durations[scene.id].toFixed(2)}s`);
}
writeFileSync(join(audio, "durations.json"), JSON.stringify(durations, null, 2));
