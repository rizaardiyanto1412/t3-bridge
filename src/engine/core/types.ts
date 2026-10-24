import type { ProviderApprovalDecision } from "@t3tools/contracts";

/**
 * The platform-neutral boundary. The core turns T3 thread activity into `OutboundPost`s and
 * chat activity into T3 commands; each chat platform only implements `ChatAdapter`.
 */

/** Where a conversation happens on the platform, e.g. a Slack DM or channel. Opaque to the core. */
export interface ConversationRef {
  readonly id: string;
  readonly label: string;
  /** In threaded (agent) layout, the thread a post belongs in. */
  readonly threadTs?: string;
  /** Platform details the adapter needs later, e.g. who a channel stream is for. */
  readonly meta?: Readonly<Record<string, string>>;
}

/** Points at one message the adapter posted or received, so it can edit or react to it later. Opaque to the core. */
export type MessageRef = Readonly<Record<string, string>>;

export interface InboundFile {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly download: () => Promise<Buffer>;
}

export interface InboundMessage {
  readonly conversation: ConversationRef;
  readonly ref: MessageRef;
  readonly userId: string;
  readonly userName: string;
  /** Direct messages can claim an unowned bot; channel messages cannot. */
  readonly isDirect: boolean;
  /** In a shared channel, strangers only get an answer when they address the bot. */
  readonly mentionsBot: boolean;
  readonly text: string;
  readonly files: ReadonlyArray<InboundFile>;
  /** The message or thread this one replies to; for a reply to the bot's own post, that post. */
  readonly replyTo: MessageRef | null;
  /**
   * Loads what came before this message in the conversation it replies to: the message it
   * answers, or the start of the chat thread it was posted in. Without a reply (a mention in a
   * Discord thread), what was said there since the bot last spoke. The core calls it only when
   * the bot is brought into a conversation it was not part of, e.g. mentioned under an alert.
   */
  readonly earlier?: () => Promise<ReadonlyArray<EarlierMessage>>;
}

/** A message from before the bot was brought into a conversation, oldest first. */
export interface EarlierMessage {
  readonly author: string;
  readonly text: string;
  readonly files: ReadonlyArray<InboundFile>;
}

export type InboundAction =
  | {
      readonly type: "approval";
      readonly userId: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly decision: ProviderApprovalDecision;
    }
  | {
      readonly type: "answer";
      readonly userId: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly answers: Readonly<Record<string, string | ReadonlyArray<string>>>;
    }
  | { readonly type: "stop"; readonly userId: string };

export interface ImageRef {
  readonly name: string;
  readonly load: () => Promise<{ bytes: Buffer; mimeType: string }>;
}

export interface QuestionOption {
  readonly label: string;
  readonly description: string;
  readonly value: string;
}

export interface Question {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<QuestionOption>;
  readonly multiSelect: boolean;
  readonly allowCustomAnswer: boolean;
}

export interface SubagentTask {
  readonly id: string;
  readonly title: string;
  readonly model: string | null;
  readonly status: SubagentStatus;
  readonly progress: string | null;
  readonly result: string | null;
}

export type SubagentStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStatus = "running" | "completed" | "failed" | "interrupted";

export type OutboundPost =
  | {
      readonly kind: "assistant";
      readonly markdown: string;
      readonly streaming: boolean;
      readonly images: ReadonlyArray<ImageRef>;
    }
  | {
      /** Text a person typed into the thread from T3 itself rather than from chat. */
      readonly kind: "echo";
      readonly markdown: string;
    }
  | ({ readonly kind: "subagent" } & SubagentTask)
  | {
      /** All subagents one request started, shown together as a plan. */
      readonly kind: "subagents";
      readonly tasks: ReadonlyArray<SubagentTask>;
    }
  | {
      readonly kind: "approval";
      readonly threadId: string;
      readonly requestId: string;
      readonly source: string;
      readonly prompt: string;
      readonly decisions: ReadonlyArray<ProviderApprovalDecision>;
      readonly resolved: ProviderApprovalDecision | "expired" | null;
    }
  | {
      readonly kind: "question";
      readonly threadId: string;
      readonly requestId: string;
      readonly source: string;
      readonly questions: ReadonlyArray<Question>;
      readonly resolved: boolean;
    }
  | { readonly kind: "plan"; readonly markdown: string }
  | {
      readonly kind: "todo";
      readonly steps: ReadonlyArray<{
        readonly text: string;
        readonly status: "pending" | "running" | "completed";
      }>;
    }
  | {
      readonly kind: "html";
      readonly title: string;
      readonly html: ImageRef;
    }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "notice"; readonly markdown: string };

export interface AdapterHandlers {
  readonly onMessage: (message: InboundMessage) => Promise<void>;
  readonly onAction: (action: InboundAction) => Promise<void>;
  readonly onStatus: (status: AdapterStatus) => void;
}

export type AdapterStatus =
  | { readonly state: "connecting" }
  | { readonly state: "connected"; readonly identity: string }
  | { readonly state: "error"; readonly error: string };

/** A refusal from a chat platform; `permanent` ones (no access, message gone) are not retried. */
export class PlatformError extends Error {
  readonly status: number;
  readonly permanent: boolean;

  constructor(message: string, status: number, permanent: boolean) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

export interface ChatAdapter {
  start(handlers: AdapterHandlers): Promise<void>;
  stop(): Promise<void>;
  /** Posts a new message, or edits `existing` in place. Returns the ref to edit next time. */
  upsert(
    conversation: ConversationRef,
    post: OutboundPost,
    existing: MessageRef | null,
  ): Promise<MessageRef>;
  /** Shows a run's state on the chat message that started it, e.g. with a reaction. */
  setRunStatus(
    message: MessageRef,
    status: RunStatus,
    previous: RunStatus | null,
    /** The conversation thread the run belongs to, when replies are threaded. */
    sessionThreadTs?: string,
  ): Promise<void>;
  /** Tells the sender something without involving the agent. */
  reply(message: InboundMessage, text: string): Promise<void>;
  /** Names a chat thread, e.g. in Slack's list of agent conversations. */
  setThreadTitle?(conversation: ConversationRef, title: string): Promise<void>;
  /** Opens a direct conversation with a user, for posts before anyone has messaged the bot. */
  openDirect?(userId: string): Promise<ConversationRef>;
}
