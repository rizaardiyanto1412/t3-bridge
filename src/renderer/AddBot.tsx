import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  CircleCheck,
  Cpu,
  Folder,
  Hand,
  Info,
  LoaderCircle,
  Pin,
  Plus,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { PLATFORM_NAMES, type Api, type ModelSelection, type Platform, type Status } from "./api.ts";
import {
  Checkbox,
  errorText,
  go,
  ManifestText,
  PlatformBadge,
  PlatformGlyph,
  SelectBox,
  slackCreateUrl,
  ThreadOptions,
  threadMeta,
  TopNav,
  useManifest,
  type Threads,
} from "./shared.tsx";

const STEPS: Record<Platform, ReadonlyArray<{ title: string; desc: string }>> = {
  slack: [
    { title: "Create app", desc: "Name it and install it in Slack" },
    { title: "Connect", desc: "Paste two tokens" },
    { title: "Thread", desc: "Pick the T3 thread it talks to" },
    { title: "Say hello", desc: "DM the bot to become its owner" },
  ],
  discord: [
    { title: "Create bot", desc: "Name it in the developer portal" },
    { title: "Connect", desc: "Paste the token, add to a server" },
    { title: "Thread", desc: "Pick the T3 thread it talks to" },
    { title: "Say hello", desc: "DM the bot to become its owner" },
  ],
  telegram: [
    { title: "Create bot", desc: "Get a token from @BotFather" },
    { title: "Connect", desc: "Paste the token" },
    { title: "Thread", desc: "Pick the T3 thread it talks to" },
    { title: "Say hello", desc: "Press Start to become its owner" },
  ],
};

/** A token pasted so far looks complete enough to check. */
function tokenReady(platform: Platform, botToken: string, appToken: string) {
  if (platform === "slack") return botToken.startsWith("xoxb-") && appToken.startsWith("xapp-");
  if (platform === "telegram") return /^\d+:[\w-]{30,}$/.test(botToken);
  return botToken.length >= 50 && !/\s/.test(botToken);
}

type Check = { state: "idle" | "checking" | "ok" | "bad"; text: string; link?: string; note?: string };

export function AddBot(props: {
  api: Api;
  platform: Platform;
  threads: Threads | null;
  reloadThreads: () => Promise<void>;
  status: Status;
  onCreated: () => void;
}) {
  const { api, platform } = props;
  const label = PLATFORM_NAMES[platform];
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [check, setCheck] = useState<Check>({ state: "idle", text: "" });
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [projectId, setProjectId] = useState("");
  const [models, setModels] = useState<ModelSelection[]>([]);
  const [model, setModel] = useState(0);
  const [threadId, setThreadId] = useState("");
  /** A thread this wizard already created, reused if adding the bot fails and is retried. */
  const [createdThreadId, setCreatedThreadId] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [sendInstructions, setSendInstructions] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [botId, setBotId] = useState<string | null>(null);
  const manifest = useManifest(api, platform === "slack" ? name.trim() : "");

  useEffect(() => {
    void api.defaults().then((defaults) => setInstructions(defaults.instructions));
  }, [api]);

  useEffect(() => {
    if (projectId === "" && props.threads?.projects[0]) setProjectId(props.threads.projects[0].id);
  }, [projectId, props.threads]);

  useEffect(() => {
    if (!projectId) return;
    setCreatedThreadId(null);
    void api.models(projectId).then((result) => {
      setModels(result.models);
      setModel(0);
    });
  }, [api, projectId]);

  // Tokens are checked as soon as they look complete, so a wrong paste shows at once.
  useEffect(() => {
    const tokens = { botToken: botToken.trim(), appToken: appToken.trim() };
    if (!tokenReady(platform, tokens.botToken, tokens.appToken)) {
      setCheck({ state: "idle", text: "" });
      return;
    }
    setCheck({ state: "checking", text: "Checking…" });
    let current = true;
    const test = async (): Promise<Check> => {
      if (platform === "slack") {
        const result = await api.testSlack(tokens);
        return { state: "ok", text: `Valid · @${result.botUser} in the ${result.team} workspace` };
      }
      if (platform === "discord") {
        const result = await api.testDiscord({ botToken: tokens.botToken });
        return {
          state: "ok",
          text: `Valid · ${result.botUser}`,
          link: result.inviteUrl,
          ...(result.messageContent
            ? {}
            : { note: "Optional: turn on Message Content Intent under Bot so the bot also reads replies that don't mention it." }),
        };
      }
      const result = await api.testTelegram({ botToken: tokens.botToken });
      return { state: "ok", text: `Valid · @${result.botUser}`, link: result.link };
    };
    const timer = setTimeout(() => {
      test()
        .then((result) => current && setCheck(result))
        .catch((cause: unknown) => current && setCheck({ state: "bad", text: errorText(cause) }));
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, platform, botToken, appToken]);

  const add = async () => {
    setSaving(true);
    setError(null);
    try {
      let target = threadId;
      if (mode === "new") {
        target = createdThreadId ?? "";
        if (!target) {
          const selection = models[model];
          const result = await api.createThread({
            projectId,
            title: name.trim() || "Orchestrator",
            instructions,
            ...(selection ? { modelSelection: selection } : {}),
          });
          target = result.threadId;
          setCreatedThreadId(target);
          void props.reloadThreads();
        }
      }
      const bot = await api.addBot({
        name: name.trim() || "T3 Bot",
        platform,
        ...(platform === "slack"
          ? { slack: { botToken: botToken.trim(), appToken: appToken.trim() } }
          : { [platform]: { botToken: botToken.trim() } }),
        threadId: target,
        instructions,
        reminder: true,
        sendInstructions: mode === "existing" && sendInstructions,
      });
      setBotId(bot.id);
      setStep(3);
      props.onCreated();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const created = botId === null ? undefined : props.status.bots.find((bot) => bot.id === botId);
  const claimed = created !== undefined && (created.allowedUserIds.length > 0 || created.activity.today > 0);
  const botName = name.trim() || "the bot";

  const card = (() => {
    if (step === 0) {
      const opener = {
        slack: { text: "Create Slack app", href: manifest && name.trim() ? slackCreateUrl(manifest.json) : undefined },
        discord: { text: "Open developer portal", href: "https://discord.com/developers/applications" },
        telegram: { text: "Open @BotFather", href: "https://t.me/BotFather" },
      }[platform];
      return (
        <StepCard
          step={0}
          title={{ slack: "Create the Slack app", discord: "Create the Discord bot", telegram: "Get a token from BotFather" }[platform]}
          note={platform === "slack" ? "Takes about a minute" : undefined}
          next={
            <button className="btn primary lg" disabled={!name.trim()} onClick={() => setStep(1)}>
              {{ slack: "I created it, next", discord: "I copied the token, next", telegram: "Next" }[platform]}
              <ArrowRight size={16} className="lime" />
            </button>
          }
        >
          <Field label="Bot name" hint={`how it appears in ${label}`} width={520}>
            <input
              className="input big"
              placeholder="e.g. WP Keeper"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </Field>
          <div className="row wrap">
            <a
              className={`btn brand ${platform}${opener.href && name.trim() ? "" : " disabled"}`}
              href={name.trim() ? opener.href : undefined}
              target="_blank"
              rel="noreferrer"
            >
              <PlatformGlyph platform={platform} size={16} />
              {opener.text}
              <ArrowUpRight size={16} />
            </a>
            {!name.trim() && <span className="hint-inline">Name the bot first</span>}
          </div>
          <ol className="numbered">
            {platform === "slack" && (
              <>
                <li>Slack opens with the app already filled in. Pick your workspace and choose Next, then Create.</li>
                <li>Under Install App, choose Install to Workspace, then Allow.</li>
              </>
            )}
            {platform === "discord" && (
              <>
                <li>Choose New Application and give it the same name.</li>
                <li>Under Bot, choose Reset Token and copy the token. You paste it in the next step.</li>
                <li>Optional: turn on Message Content Intent there too, so the bot also reads replies that don't mention it.</li>
              </>
            )}
            {platform === "telegram" && (
              <>
                <li>Send /newbot, then a display name{name.trim() ? ` such as ${name.trim()}` : ""}.</li>
                <li>Send a username ending in bot, such as {(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "") || "wpkeeper")}_bot.</li>
                <li>BotFather replies with a token like 123456:ABC… Copy it; you paste it in the next step.</li>
              </>
            )}
          </ol>
          {platform === "slack" && manifest && name.trim() && <ManifestText text={manifest.text} />}
        </StepCard>
      );
    }

    if (step === 1) {
      return (
        <StepCard
          step={1}
          title={{ slack: "Paste the two tokens", discord: "Paste the token, then add it to a server", telegram: "Paste the token" }[platform]}
          back={() => setStep(0)}
          next={
            <button className="btn primary lg" disabled={check.state !== "ok"} onClick={() => setStep(2)}>
              {platform === "slack" ? "Connect" : "Next"}
              <ArrowRight size={16} className="lime" />
            </button>
          }
        >
          {platform !== "discord" && (
            <p className="lead">
              {platform === "slack"
                ? "Both come from your app's page on api.slack.com. They're checked as you paste."
                : "Copy the whole token BotFather sent you. It's checked as you paste."}
            </p>
          )}
          {platform === "slack" ? (
            <>
              <Field label="Bot token" hint="Install App → Bot User OAuth Token" width={620}>
                <TokenInput value={botToken} onChange={setBotToken} placeholder="xoxb-…" check={check} autoFocus />
              </Field>
              <Field label="App-level token" hint="Basic Information → App-Level Tokens" width={620}>
                <TokenInput value={appToken} onChange={setAppToken} placeholder="xapp-…" check={check} />
                <CheckText check={check} />
              </Field>
              <div className="hint-box">
                <Info size={15} />
                <span>
                  The app-level token needs the <code>connections:write</code> scope.
                </span>
              </div>
            </>
          ) : (
            <Field label="Bot token" hint={platform === "discord" ? "Bot → Reset Token" : undefined} width={620}>
              <TokenInput
                value={botToken}
                onChange={setBotToken}
                placeholder={platform === "discord" ? "Paste the bot token" : "123456:ABC…"}
                check={check}
                autoFocus
              />
              <CheckText check={check} />
            </Field>
          )}
          {platform === "discord" && check.state === "ok" && check.link && (
            <div className="soft-box">
              <h3>Add it to a server you're in</h3>
              <p>Discord only lets people message a bot they share a server with.</p>
              {check.note && <p className="small">{check.note}</p>}
              <div>
                <a className="btn brand discord" href={check.link} target="_blank" rel="noreferrer">
                  <Plus size={16} />
                  Add to a server
                  <ArrowUpRight size={16} />
                </a>
              </div>
            </div>
          )}
        </StepCard>
      );
    }

    if (step === 2) {
      const projectTitle = props.threads?.projects.find((project) => project.id === projectId)?.title;
      const selection = models[model];
      const thread = props.threads?.threads.find((candidate) => candidate.id === threadId);
      const ready = mode === "new" ? projectId !== "" : threadId !== "";
      return (
        <StepCard
          step={2}
          title="Which T3 thread should it talk to?"
          back={() => setStep(1)}
          next={
            <button className="btn primary lg" disabled={!ready || saving} onClick={() => void add()}>
              {saving ? "Creating…" : "Create bot"}
              <ArrowRight size={16} className="lime" />
            </button>
          }
        >
          <div>
            <div className="segmented">
              <button className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>
                Create a new orchestrator thread
              </button>
              <button className={mode === "existing" ? "active" : ""} onClick={() => setMode("existing")}>
                Use a thread I have
              </button>
            </div>
          </div>
          {props.threads === null ? (
            <p className="muted">Loading threads from T3…</p>
          ) : mode === "new" ? (
            <div className="field-row">
              <Field label="Project">
                <SelectBox icon={<Folder size={16} />} title={projectTitle ?? "Choose a project"} mono value={projectId} onChange={setProjectId}>
                  {projectId === "" && <option value="">Choose a project…</option>}
                  {props.threads.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
                </SelectBox>
              </Field>
              <Field label="Model">
                <SelectBox
                  icon={<Cpu size={16} />}
                  title={selection?.model ?? "Project default"}
                  mono
                  disabled={models.length === 0}
                  value={String(model)}
                  onChange={(value) => setModel(Number(value))}
                >
                  {models.length === 0 && <option value="0">Project default</option>}
                  {models.map((choice, index) => (
                    <option key={`${choice.instanceId}/${choice.model}`} value={index}>
                      {choice.model} ({choice.instanceId})
                    </option>
                  ))}
                </SelectBox>
              </Field>
            </div>
          ) : (
            <Field label="Thread">
              <SelectBox
                icon={<Pin size={16} />}
                title={thread?.title ?? "Choose a thread"}
                meta={threadMeta(thread)}
                value={threadId}
                onChange={setThreadId}
              >
                {threadId === "" && <option value="">Choose a thread…</option>}
                <ThreadOptions threads={props.threads} />
              </SelectBox>
            </Field>
          )}
          <Field label="Orchestrator instructions" hint={mode === "new" ? "the thread starts with these" : "a new thread starts with these"}>
            <textarea className="input" rows={5} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
          </Field>
          {mode === "new" ? (
            <div className="note">
              <Pin size={14} />
              The new thread is pinned in T3 and runs with full access.
            </div>
          ) : (
            <Checkbox checked={sendInstructions} onChange={setSendInstructions}>
              Send the orchestrator instructions to this thread now
            </Checkbox>
          )}
          {error && <p className="error-text">{error}</p>}
        </StepCard>
      );
    }

    return (
      <StepCard
        step={3}
        next={
          <button className="btn primary lg" onClick={() => go({ page: "home" })}>
            Done, back to my bots
            <Check size={16} className="lime" />
          </button>
        }
      >
        <div className="hello">
          <span className="ring">{claimed ? <Check size={40} /> : <Hand size={40} />}</span>
          <div className="eyebrow">Step 4 of 4</div>
          {claimed ? (
            <>
              <h2 className="hello-title">{botName} is ready</h2>
              <p>It's yours: only you can send it work. Add teammates on its page under Who may use it.</p>
            </>
          ) : (
            <>
              <h2 className="hello-title">Now say hello to {botName}</h2>
              <p>
                {platform === "slack" && `In Slack, open ${botName} under Apps and send it a direct message.`}
                {platform === "discord" &&
                  "In Discord, open the bot's profile in the server you added it to, choose Message and send it something."}
                {platform === "telegram" && "Open the bot in Telegram and press Start."} The first person to do so becomes its
                owner.
              </p>
              <span className="waiting">
                <LoaderCircle size={16} className="spin" />
                Waiting for your first message…
              </span>
              <a
                className={`btn brand ${platform}`}
                href={
                  platform === "telegram"
                    ? (created?.chatLink ?? "https://web.telegram.org")
                    : platform === "discord"
                      ? "https://discord.com/channels/@me"
                      : "slack://open"
                }
                target="_blank"
                rel="noreferrer"
              >
                <PlatformGlyph platform={platform} size={16} />
                {platform === "slack" ? "Open Slack" : `Open ${botName} in ${label}`}
                <ArrowUpRight size={16} />
              </a>
            </>
          )}
        </div>
      </StepCard>
    );
  })();

  return (
    <div className="page">
      <TopNav crumbs={["Your bots", "Add"]} action={botId === null ? "cancel" : "back"} />
      <div className="title-block wide">
        <h1 className="title">Add a {label} bot</h1>
        <p className="subhead">One {label} {platform === "slack" ? "app" : "bot"} talking to one T3 thread. About two minutes.</p>
      </div>
      <div className="wizard">
        <aside className="rail">
          <span className="rail-platform">
            <PlatformBadge platform={platform} size={24} round />
            {label}
          </span>
          <ol className="rail-steps">
            {STEPS[platform].map((item, index) => {
              const state = index < step ? "done" : index === step ? "current" : "todo";
              const canGo = state === "done" && botId === null;
              return (
                <li key={item.title}>
                  <button className={`rail-step ${state}`} disabled={!canGo} onClick={() => setStep(index)}>
                    <span className="num">{state === "done" ? <Check size={14} /> : index + 1}</span>
                    <span className="text">
                      <span className="rail-title">{item.title}</span>
                      <span className="rail-desc">{item.desc}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="grow" />
          <div className="tip">
            <div className="eyebrow lime-text">Good to know</div>
            <p>The bot runs code on your Mac. Only people you allow can send it work.</p>
          </div>
        </aside>
        {card}
      </div>
    </div>
  );
}

function StepCard(props: {
  step: number;
  title?: string;
  note?: string | undefined;
  back?: () => void;
  next: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card step-card">
      {props.title && (
        <>
          <div className="eyebrow">Step {props.step + 1} of 4</div>
          <h2 className="card-title">{props.title}</h2>
        </>
      )}
      {props.children}
      <div className="grow" />
      <div className="step-foot">
        {props.back ? (
          <button className="btn outline lg" onClick={props.back}>
            <ArrowLeft size={16} />
            Back
          </button>
        ) : (
          <span className="eyebrow">{props.note ?? ""}</span>
        )}
        {props.next}
      </div>
    </section>
  );
}

function Field({ label, hint, width, children }: { label: string; hint?: string | undefined; width?: number; children: ReactNode }) {
  return (
    <label className="field" style={width ? { maxWidth: width } : undefined}>
      <span className="label">
        {label}
        {hint && <span className="hint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function TokenInput(props: { value: string; onChange: (value: string) => void; placeholder: string; check: Check; autoFocus?: boolean }) {
  const state = props.value.trim() === "" ? "idle" : props.check.state;
  return (
    <span className={`input token ${state}`}>
      <input
        className="mono"
        value={props.value}
        placeholder={props.placeholder}
        spellCheck={false}
        autoComplete="off"
        autoFocus={props.autoFocus}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {state === "ok" && <CircleCheck size={18} className="ok-text" />}
      {state === "bad" && <CircleAlert size={18} className="error-text" />}
      {state === "checking" && <LoaderCircle size={18} className="spin faint" />}
    </span>
  );
}

function CheckText({ check }: { check: Check }) {
  if (check.state === "idle") return null;
  return <span className={`check-text ${check.state}`}>{check.text}</span>;
}
