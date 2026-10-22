import { SHORTCUT_FORWARD } from "./blocks.ts";

/**
 * Bumped when the manifest gains scopes, events or shortcuts, so the control panel can ask
 * existing bots to update their Slack app. 2 added canvases, the Stop button and "Send to";
 * 3 made the bot a Slack agent (AI app), which threads each request.
 */
export const MANIFEST_VERSION = 3;
export const AGENT_LAYOUT_MANIFEST_VERSION = 3;

/** The Slack app manifest a user pastes into api.slack.com → Create app → From manifest. */
export function slackManifest(name: string) {
  const displayName = name.trim().slice(0, 35) || "T3 Bridge";
  // Slack caps shortcut names at 24 characters.
  const shortcutName = `Send to ${displayName}`.slice(0, 24);
  return {
    display_information: {
      name: displayName,
      description: "Chat with your T3 Code orchestrator thread.",
      background_color: "#16161a",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: displayName, always_online: true },
      // Slack's AI-app experience: the "is working…" status, the Stop button, streaming
      // replies, and one thread per request in the bot's Messages tab.
      agent_view: {
        agent_description:
          `${displayName} hands your requests to a T3 Code agent and its subagents.`.slice(0, 300),
        suggested_prompts: [
          {
            title: "What's going on?",
            message: "What are you working on right now, and what is waiting on me?",
          },
          {
            title: "Check open issues",
            message:
              "Check the open GitHub issues and pull requests and summarize what needs attention.",
          },
          { title: "Summarize today", message: "Summarize what was done today." },
        ],
      },
      shortcuts: [
        {
          name: shortcutName,
          type: "message",
          callback_id: SHORTCUT_FORWARD,
          description: `Ask ${displayName} to handle this message`,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "assistant:write",
          "canvases:write",
          "channels:history",
          "channels:read",
          "chat:write",
          "commands",
          "files:read",
          "files:write",
          "groups:history",
          "groups:read",
          "im:history",
          "im:read",
          "im:write",
          "mpim:history",
          "reactions:read",
          "reactions:write",
          "users:read",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [
          "agent_session_stopped",
          // Slack asks agent apps to subscribe to this; opening the bot's tab needs no reply.
          "app_home_opened",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
          "reaction_added",
        ],
      },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}
