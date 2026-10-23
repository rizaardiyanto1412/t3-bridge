# T3 Bridge

Chat with a T3 Code thread from Slack. Each bot is one Slack app talking to one T3 thread. That
thread acts as an **orchestrator**: it never does the work itself, it hands each task to a
subagent and reports back. Replies, subagent progress, approvals, and questions show up in
Slack; your messages, files, and button clicks go back to T3.

T3 Bridge is a separate Mac app for [T3 Code](https://github.com/pingdotgg/t3code). It talks to
T3 Code the same way the T3 mobile app does, so updating T3 Code does not touch it. If T3 Code
ever changes its protocol, the bridge shows "Rebuild T3 Bridge" instead of half-working; see
[Keeping up with T3 Code](#keeping-up-with-t3-code).

This is an independent project, not made or supported by T3 Tools.

Requirements: macOS on Apple Silicon, T3 Code running on the same Mac, [Tailscale](https://tailscale.com)
to manage it from other devices, and Node.js 22.18+ with pnpm to build it.

## How it runs

- **Worker:** the Mac that runs T3 Code (for example a Mac mini). T3 Bridge runs there in the
  background, starts at login, and pairs with T3 Code by itself. You never paste a T3 pairing link.
- **Control panel:** any browser on your Tailscale network, phone included. Open the worker's link
  (it ends in `#token=…`) and bookmark it. The T3 Bridge app on another Mac is optional: choose
  **Connect to a worker…** and paste the same link.

## Install the worker

On the Mac that runs T3 Code:

```sh
git clone https://github.com/rizaardiyanto1412/t3-bridge.git
cd t3-bridge
pnpm install
pnpm dist             # builds release/T3 Bridge.app and a .dmg
pnpm install-worker   # installs to ~/Applications and starts it under launchd
```

To update, open the control panel's **Updates** card, choose **Check for updates**, then
**Update now**. It pulls, rebuilds and restarts the worker; the bots pause for about a minute.
From a terminal, the same is `git pull && pnpm dist && pnpm install-worker`. Logs are in `~/Library/Logs/T3 Bridge.log`.

To get the link for another Mac, open the worker's control panel (menu bar icon → **Copy link
for another Mac**) or read it from `~/Library/Application Support/T3 Bridge/config.json`:
`http://<tailscale-ip>:47821/#token=<controlToken>`. The link works like a password.

## Replacing the link

The link works like a password. **Replace link** in **Control from another Mac** issues a new one;
every old copy stops working, so paste the new link into T3 Bridge on your other Macs.

## Install the control panel on your MacBook

Open the worker link in a browser and download the `.dmg` from **Control from another Mac**.
The app has no Developer ID signature, so the first time you open it, right-click it and choose
**Open**. Then choose **Connect to a worker…** and paste the link. The window then shows the
worker's own control panel, so updating the worker updates what you see; the MacBook app itself
rarely needs reinstalling.

## Add a Slack bot

In the control panel, choose **Add Slack bot** and follow the steps:

1. Name the bot and copy the generated manifest.
2. On api.slack.com/apps, choose **Create New App → From a manifest**, paste it, and install the
   app to your workspace. Copy the **Bot User OAuth Token** (`xoxb-…`).
3. Under **Basic Information → App-Level Tokens**, create a token with the `connections:write`
   scope (`xapp-…`).
4. Paste both tokens and choose **Test tokens**.
5. Choose a thread, or create a new orchestrator thread. A new thread is pinned, runs with full
   access, and starts with the orchestrator instructions.
6. Leave **Who may use it** empty to claim the bot by sending it a direct message, or list Slack
   member IDs.

Message the bot directly, or invite it to a channel with `/invite @bot`. Both go to the same thread. In
a channel, mention the bot (`@bot fix the login page`) or reply under one of its messages; other
channel chatter is ignored.

## Updating an existing bot's Slack app

When a new version needs more Slack permissions, the bot's card shows **Update Slack app**. It
gives you a new manifest to paste under **App Manifest** on api.slack.com, then asks you to
reinstall the app. The tokens stay the same.

## In Slack

The bot is a Slack AI app. Each request is its own thread in the bot's Messages tab (or under
your mention in a channel): the reply streams in there, along with the request's subagents,
questions, and the summary the orchestrator posts after they finish. Reply in the thread to
continue that request; start a new message for a new one.

- Your message gets 👀 while the agent works, then ✅, ❌, or ⏹, and Slack shows
  "<bot> is working…" in the thread.
- Press Slack's **Stop** button while the agent works, add 🛑 (`:octagonal_sign:`) to any message,
  or send `!stop`, to stop the agent.
- On any message, choose **⋯ → Send to <bot>** to hand it to the agent with a note. The answer
  arrives in your DM with the bot.
- Long reports (over about 4,000 characters) go into a Slack canvas; chat gets the opening and a
  link. Workspaces without canvases get the whole reply in chat.
- Approvals and questions arrive with buttons. You can also answer a question by replying in its
  Slack thread.
- Subagents show as Slack task cards that update while they run. The orchestrator's reply
  summarizes what they found; expand a card to see the start of its raw result.
- Images go both ways: pictures you attach in Slack reach the agent, and screenshots or images
  the agent shows (including ones it saved on the Mac) are uploaded to the thread.
- HTML renders arrive as a screenshot plus the `.html` file.
- Messages typed in T3 itself also show up in Slack, marked _Sent from T3_.
- Every message reaches T3 tagged with its thread, e.g. `[Slack · Riza · thread "Check Pro PRs"]`,
  so a reply like "yes, merge it" arrives with its subject. Slack's thread list uses the same titles.
- When one request starts several subagents, they share one plan card in its thread.
- Send `!new` (or use **New thread** on the bot's card) to start a fresh orchestrator thread with
  the same project, model and instructions when the current one has grown long.

Only allowed people can send work. The bot runs code on your Mac, so keep that list short.

## Keeping up with T3 Code

The bridge speaks T3 Code's WebSocket protocol using T3 Code's own contract definitions, copied
into `vendor/t3code` (T3 Code is MIT licensed; `vendor/t3code/SOURCE.md` records the commit).
When T3 Code changes its protocol, refresh them from a T3 Code checkout and rebuild:

```sh
pnpm sync-t3code ~/Code/t3code
pnpm typecheck && pnpm test
pnpm dist && pnpm install-worker
```

## Develop

```sh
pnpm test        # unit tests
pnpm typecheck
pnpm build       # bundles the main process (tsdown) and the control panel (vite)
pnpm start       # runs the Electron app from source
```

`src/engine/cli.ts` runs the engine without Electron against any T3 server; see the comment at its
top. Chat platforms plug in through `ChatAdapter` in `src/engine/core/types.ts`; Slack is the
first adapter.

## License

MIT. The files in `vendor/t3code` are from T3 Code, also MIT; see `vendor/t3code/LICENSE`.
