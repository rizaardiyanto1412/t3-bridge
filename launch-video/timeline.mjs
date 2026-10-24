// One entry per scene. `seconds` is the minimum length; when a voiceover clip
// exists for the scene, the scene stretches to fit it.
export const scenes = [
  {
    id: "hook",
    seconds: 5,
    voice: "T3 Code has a brilliant orchestrator. We take it further.",
  },
  {
    id: "coworker",
    seconds: 5,
    voice: "What if you could message it like a coworker, in the chat apps your team already lives in?",
  },
  {
    id: "title",
    seconds: 5.5,
    voice: "So I built T3 Bridge. It connects T3 Code to Slack, Discord, and Telegram.",
  },
  {
    id: "rule",
    seconds: 7,
    voice: "The rule is simple. One project. One thread. One bot.",
  },
  {
    id: "chat",
    seconds: 11,
    voice: "You message the bot. The thread picks it up, hands the work to subagents, asks before anything risky, and reports back right in your chat.",
  },
  {
    id: "delegate",
    seconds: 7.5,
    voice: "The orchestrator never does the work itself. Everything goes to a subagent, so the thread stays clean, no matter how long it runs.",
  },
  {
    id: "panel",
    seconds: 6.5,
    voice: "Add bots, pick threads, and keep an eye on everything from one control panel. Even on your phone.",
  },
  {
    id: "cta",
    seconds: 8.5,
    voice: "T3 Bridge is open source and MIT licensed. One command to install. Go message your code.",
  },
];

// Crossfade between scenes, and the delay before each voiceover clip starts.
export const FADE = 0.4;
export const VOICE_LEAD = 0.35;
export const VOICE_TAIL = 0.8;
