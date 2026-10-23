# T3 Bridge

Chat with a T3 Code thread from Slack. Each bot is one Slack app talking to one T3 thread. That
thread acts as an **orchestrator**: it never does the work itself, it hands each task to a
subagent and reports back. Replies, subagent progress, approvals, and questions show up in
Slack; your messages, files, and button clicks go back to T3.

T3 Bridge runs next to [T3 Code](https://github.com/pingdotgg/t3code) as its own program. It
talks to T3 Code the same way the T3 mobile app does, so updating T3 Code does not touch it. If
T3 Code ever changes its protocol, the bridge shows "Update T3 Bridge" instead of half-working; see
[Keeping up with T3 Code](#keeping-up-with-t3-code).

This is an independent project, not made or supported by T3 Tools.

Requirements: macOS with T3 Code running, Node.js 22.18 or newer, and optionally
[Tailscale](https://tailscale.com) to open the control panel from other devices.

## Install

On the Mac that runs T3 Code (over SSH works too):

```sh
npx t3-bridge install
```

T3 Bridge now runs in the background, starts at login, and pairs with T3 Code by itself. The
command prints the control panel link, `http://<tailscale-ip>:47821/#token=…`. Open it in any
browser on your Tailscale network, your phone included, and bookmark it. Everything else,
adding Slack bots included, happens in that page. The link works like a password.

With T3 Code on more than one Mac, run the same command on each Mac whose threads you want in
Slack, and bookmark each link. On a single Mac without Tailscale, open the `127.0.0.1` link.

| Command | |
|---|---|
| `npx t3-bridge` | Run in the terminal instead of in the background |
| `npx t3-bridge install` | Run in the background, starting at login |
| `npx t3-bridge uninstall` | Stop and remove the background service; bots and settings are kept |
| `npx t3-bridge link` | Print the control panel link again |
| `npx t3-bridge status` | Show whether T3 Code and the bots are connected |

To update, open the control panel's **Updates** card and choose **Update now**, or run
`npx t3-bridge@latest install`. Settings live in `~/Library/Application Support/T3 Bridge` and
logs in `~/Library/Logs/T3 Bridge.log`.

**Replace link** in **Open from other devices** issues a new link; every old copy stops working.

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
- Forwarded messages reach the agent with their text, author and link, plus their images and
  files.
- Images go both ways: pictures you attach in Slack reach the agent, and screenshots or images
  the agent shows (including ones it saved on the Mac) are uploaded to the thread.
- HTML pages the agent renders arrive as an `.html` file.
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
```

Then publish a new version (see Develop).

## Develop

```sh
pnpm test        # unit tests
pnpm typecheck
pnpm build       # bundles the CLI (tsdown) and the control panel (vite) into dist/
pnpm start       # builds, then runs in the terminal
node dist/cli.cjs install   # runs this build as the background service
```

To run against an isolated T3 server instead of your own:

```sh
T3_BRIDGE_DATA=/tmp/bridge T3_BRIDGE_PORT=47899 T3_BRIDGE_T3_URL=http://127.0.0.1:4791 \
T3_BRIDGE_PAIR_COMMAND='node apps/server/src/bin.ts auth pairing create --base-dir /tmp/t3' \
node dist/cli.cjs
```

To release, bump `version` in `package.json` and run `pnpm publish`. Installed copies offer the
update in their control panel. Chat platforms plug in through `ChatAdapter` in
`src/engine/core/types.ts`; Slack is the first adapter.

## License

MIT. The files in `vendor/t3code` are from T3 Code, also MIT; see `vendor/t3code/LICENSE`.
