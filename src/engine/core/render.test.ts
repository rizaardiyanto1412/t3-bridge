import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { requestTitle, standaloneHtml } from "./BotRuntime.ts";

import { extractLocalFiles, postForTurnItem, runStatus, type RenderContext } from "./render.ts";

const node = (
  id: string,
  kind: OrchestrationV2ExecutionNode["kind"],
  parentNodeId: string | null,
) => ({ id, kind, parentNodeId }) as unknown as OrchestrationV2ExecutionNode;

function context(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    threadId: "thread-1",
    nodes: new Map([
      ["root", node("root", "root_turn", null)],
      ["sub", node("sub", "subagent", "root")],
      ["inner", node("inner", "assistant_message", "sub")],
    ]),
    requests: new Map(),
    sentByBridge: () => false,
    localFile: (path) => ({ name: path, load: async () => ({ bytes: Buffer.alloc(0), mimeType: "image/png" }) }),
    attachmentImage: (attachment) => ({
      name: attachment.name,
      load: async () => ({ bytes: Buffer.alloc(0), mimeType: attachment.mimeType }),
    }),
    htmlRender: () => ({
      name: "x.html",
      load: async () => ({ bytes: Buffer.alloc(0), mimeType: "text/html" }),
    }),
    ...overrides,
  };
}

const item = (fields: Record<string, unknown>) =>
  ({
    id: "item-1",
    threadId: "thread-1",
    runId: "run-1",
    nodeId: "root",
    status: "completed",
    title: null,
    ...fields,
  }) as unknown as OrchestrationV2TurnItem;

describe("postForTurnItem", () => {
  it("posts the orchestrator's own replies", () => {
    const keyed = postForTurnItem(
      item({ type: "assistant_message", text: "Done.", streaming: false }),
      context(),
    );
    expect(keyed).toEqual({
      key: "a:item-1",
      post: { kind: "assistant", markdown: "Done.", streaming: false, images: [] },
    });
  });

  it("keeps provider-native subagent chatter out of chat", () => {
    expect(
      postForTurnItem(
        item({ type: "assistant_message", nodeId: "inner", text: "thinking", streaming: false }),
        context(),
      ),
    ).toBeNull();
  });

  it("echoes text typed in T3 but not messages the bridge sent", () => {
    const typed = item({
      type: "user_message",
      messageId: "m1",
      createdBy: "user",
      text: "from the app",
    });
    expect(postForTurnItem(typed, context())?.post).toEqual({
      kind: "echo",
      markdown: "from the app",
    });
    expect(postForTurnItem(typed, context({ sentByBridge: () => true }))).toBeNull();
    const wake = item({
      type: "user_message",
      messageId: "m2",
      createdBy: "system",
      text: "subagent finished",
    });
    expect(postForTurnItem(wake, context())).toBeNull();
  });

  it("shows an approval as open until its request resolves", () => {
    const approval = item({
      type: "approval_request",
      requestId: "req",
      requestKind: "command",
      prompt: "rm -rf build",
      status: "waiting",
    });
    const open = postForTurnItem(approval, context());
    expect(open?.key).toBe("r:thread-1:req");
    expect(open?.post).toMatchObject({
      kind: "approval",
      resolved: null,
      decisions: ["accept", "acceptForSession", "decline"],
    });
    const resolved = postForTurnItem(
      approval,
      context({
        requests: new Map([
          [
            "req",
            {
              id: "req",
              status: "resolved",
              decision: "decline",
            } as unknown as OrchestrationV2RuntimeRequest,
          ],
        ]),
      }),
    );
    expect(resolved?.post).toMatchObject({ resolved: "decline" });
  });

  it("ignores tool chatter", () => {
    expect(postForTurnItem(item({ type: "command_execution", input: "ls" }), context())).toBeNull();
  });
});

describe("runStatus", () => {
  it("maps T3 run states to chat reactions", () => {
    expect(runStatus("queued")).toBeNull();
    expect(runStatus("waiting")).toBe("running");
    expect(runStatus("rolled_back")).toBe("interrupted");
    expect(runStatus("completed")).toBe("completed");
  });
});

describe("standaloneHtml", () => {
  it("adds T3's theme and padding so a downloaded render looks as it does in T3", () => {
    const page = standaloneHtml(
      '<!doctype html><html><head><title>x</title></head><body><div style="color:var(--foreground)">Hi</div></body></html>',
    );
    expect(page).toContain('<style id="t3-theme">');
    expect(page).toContain("--foreground:");
    expect(page.indexOf("t3-bridge-standalone")).toBeLessThan(page.indexOf("<title>"));
    expect(page).toContain("<body><div");
  });
});

describe("requestTitle", () => {
  it("names a thread after its opening request, short and on one line", () => {
    expect(requestTitle("Can you check PR on <https://x.dev|Pro> repo?\nThanks")).toBe(
      "Can you check PR on repo? Thanks",
    );
    expect(requestTitle("x".repeat(80))).toHaveLength(60);
    expect(requestTitle("   ")).toBe("Files");
  });
});

describe("extractLocalFiles", () => {
  it("takes screenshots saved on the host out of the text, to upload them", () => {
    const result = extractLocalFiles(
      "Here it is.\n\n![shot](/Users/me/.t3/userdata/browser-artifacts/a%20b.png)\n\nDone. ![web](https://x.dev/a.png)",
    );
    expect(result.paths).toEqual(["/Users/me/.t3/userdata/browser-artifacts/a b.png"]);
    expect(result.markdown).toBe("Here it is.\n\nDone. ![web](https://x.dev/a.png)");
  });

  it("leaves other paths alone and holds back a half-streamed image or local link", () => {
    expect(extractLocalFiles("![log](/tmp/run.log)").paths).toEqual([]);
    expect(extractLocalFiles("See [Engine.ts](/src/Engine.ts:12)").markdown).toBe("See [Engine.ts](/src/Engine.ts:12)");
    expect(extractLocalFiles("Look: ![shot](/Users/me/sh").markdown).toBe("Look: ");
    expect(extractLocalFiles("Watch [Video](/tmp/explainer-vi").markdown).toBe("Watch ");
    expect(extractLocalFiles("Docs [here](https://x.de").markdown).toBe("Docs [here](https://x.de");
  });

  it("uploads a video the agent links by path and keeps the link's label", () => {
    const result = extractLocalFiles("It's ready: [Explainer video](/tmp/explainer-video/explainer.mp4)\n\n![](/tmp/a.MOV)");
    expect(result.paths).toEqual(["/tmp/explainer-video/explainer.mp4", "/tmp/a.MOV"]);
    expect(result.markdown).toBe("It's ready: Explainer video\n\n");
  });

  it("puts the images on the reply", () => {
    const keyed = postForTurnItem(
      item({ type: "assistant_message", text: "![s](file:///tmp/s.png)", streaming: false }),
      context(),
    );
    expect(keyed?.post).toMatchObject({ kind: "assistant", markdown: "", images: [{ name: "/tmp/s.png" }] });
  });
});
