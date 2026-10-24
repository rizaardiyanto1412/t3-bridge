# Launch video

A 56-second launch video for T3 Bridge, built from `index.html` (one animated scene per
entry in `timeline.mjs`), captured frame by frame with Playwright and encoded with ffmpeg.
The music bed is synthesized by `music.py`. `panel.png` is the real control panel (`pnpm build` at
the repo root, then `node panel-shot.mjs`) with mocked SandyWP and Repile bots.

```sh
npm install
node render.mjs                     # -> out/t3-bridge-launch.mp4
node render.mjs --still 12 30       # single frames -> out/still-12.png, out/still-30.png
```

## Voiceover

The voiceover lines live in `timeline.mjs`. With an ElevenLabs key:

```sh
ELEVENLABS_API_KEY=... npm run voiceover   # one clip per scene -> audio/, then re-renders
```

Scenes stretch to fit the narration and the music ducks under it. `ELEVENLABS_VOICE_ID`
picks another voice. Requires Node 22, ffmpeg, Python 3 with numpy,
and Playwright's Chromium.
