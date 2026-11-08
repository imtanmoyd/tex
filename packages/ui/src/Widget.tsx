import { Component, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ErrorInfo, type FormEvent, type PointerEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import { createChatStore, prepareChatMessages } from "@tex/core";
import type { AssistantSettings, ChatMessage, ChatThread, LLMStreamContentPart, PlatformAdapter, WidgetPosition } from "@tex/core";

const SETTINGS_KEY = "assistant:settings";
const THREADS_KEY = "assistant:threads";
const POSITION_KEY = "assistant:position";
const DEFAULT_SETTINGS: AssistantSettings = {
  apiProvider: "gemini",
  provider: "openai",
  apiKey: "",
  hasApiKey: false,
  model: "gemini-2.5-flash",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  theme: "dark",
  skin: "nova",
  hotkey: "Alt+Shift+F",
  disabledSites: []
};
const PET_ACTIONS = [
  { id: "idle", name: "Idle", icon: "✧", message: "Just floating by, keeping you company." },
  { id: "dance", name: "Dance", icon: "♫", message: "A tiny dance break. You deserve it!" },
  { id: "sleeping", name: "Sleep", icon: "☾", message: "Power nap mode. Tap me whenever you need me." },
  { id: "poking", name: "Poke", icon: "☝", message: "Boop! I’m awake and ready." },
  { id: "plugged", name: "Recharge", icon: "ϟ", message: "Recharging with a little extra sparkle." },
  { id: "low-battery", name: "Low battery", icon: "▰", message: "Running low on stardust. Let’s take it easy." }
] as const;
type PetAction = typeof PET_ACTIONS[number]["id"];

interface WidgetProps {
  platform: PlatformAdapter;
  siteHost: string;
  enableVoice?: boolean;
  offlineMessage?: string;
  isAuthenticated?: boolean;
  onSignIn?: () => void;
}

interface PendingImage {
  name: string;
  dataUrl: string;
}

interface WidgetErrorBoundaryProps {
  children: ReactNode;
  onError: (error: Error, info?: ErrorInfo) => void;
}

interface WidgetErrorBoundaryState {
  hasError: boolean;
}

export class WidgetErrorBoundary extends Component<WidgetErrorBoundaryProps, WidgetErrorBoundaryState> {
  state: WidgetErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): WidgetErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError(error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) return <div className="tex-crash" role="alert">The assistant stopped unexpectedly. Your conversations remain saved.</div>;
    return this.props.children;
  }
}

function createMessage(role: ChatMessage["role"], content: string, status?: ChatMessage["status"]): ChatMessage {
  return { id: crypto.randomUUID(), role, content, createdAt: Date.now(), status };
}

function formatTitle(title: string): string {
  return title.length > 38 ? `${title.slice(0, 38)}…` : title;
}

function canConnect(settings: AssistantSettings): boolean {
  if (settings.hasApiKey) return true;
  if (settings.provider !== "openai") return false;
  try {
    const hostname = new URL(settings.baseUrl).hostname;
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return <>{parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    return <span key={index}>{part}</span>;
  })}</>;
}

function MarkdownLines({ text }: { text: string }) {
  return <span className="tex-markdown">
    {text.split("\n").map((line, index) => {
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) return <strong className="tex-md-heading" key={index}><InlineMarkdown text={heading[2]} /></strong>;
      const unordered = /^[-*]\s+(.+)$/.exec(line);
      if (unordered) return <span className="tex-md-list" key={index}>• <InlineMarkdown text={unordered[1]} /></span>;
      const ordered = /^\d+\.\s+(.+)$/.exec(line);
      if (ordered) return <span className="tex-md-list" key={index}>{line.slice(0, line.indexOf(".") + 1)} <InlineMarkdown text={ordered[1]} /></span>;
      const quote = /^>\s?(.*)$/.exec(line);
      if (quote) return <span className="tex-md-quote" key={index}><InlineMarkdown text={quote[1]} /></span>;
      return <span className="tex-md-line" key={index}>{line ? <InlineMarkdown text={line} /> : "\u00a0"}<br /></span>;
    })}
  </span>;
}

function MessageContent({ content, onCopy }: { content: string; onCopy: (text: string) => void }) {
  const blocks = content.split(/```([^\n]*)\n([\s\S]*?)```/g);
  const nodes: ReactNode[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    if (index % 3 === 0) {
      nodes.push(<MarkdownLines text={blocks[index]} key={`text-${index}`} />);
    } else if (index % 3 === 2) {
      const code = blocks[index];
      nodes.push(
        <div className="tex-code" key={`code-${index}`}>
          <div className="tex-code-header">
            <span>{blocks[index - 1] || "code"}</span>
            <button type="button" onClick={() => onCopy(code)} aria-label="Copy code">Copy</button>
          </div>
          <pre><code>{code}</code></pre>
        </div>
      );
    }
  }
  return <>{nodes}</>;
}

function AssistantIcon({ skin }: { skin: AssistantSettings["skin"] }) {
  const gradientId = useId().replace(/:/g, "");
  const shell = skin === "mika"
    ? ["#d0fff0", "#69cbb1"]
    : skin === "orbit"
      ? ["#d8f3ff", "#7198ed"]
      : skin === "echo"
        ? ["#ffe0d8", "#dd83a8"]
        : ["#d7ccff", "#9385f5"];
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={`tex-bot-illustration skin-${skin}`}>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor={shell[0]} />
          <stop offset="1" stopColor={shell[1]} />
        </linearGradient>
      </defs>
      <ellipse className="tex-bot-orbit" cx="32" cy="36" rx="28" ry="13" transform="rotate(-28 32 36)" />
      <path className="tex-bot-sparkle sparkle-one" d="M8 11l1.5 3.5L13 16l-3.5 1.5L8 21l-1.5-3.5L3 16l3.5-1.5z" />
      <path className="tex-bot-sparkle sparkle-two" d="M54 43l1.2 2.8L58 47l-2.8 1.2L54 51l-1.2-2.8L50 47l2.8-1.2z" />
      <path className="tex-bot-sparkle sparkle-three" d="M48 9l1 2.2 2.2 1-2.2 1L48 15l-1-2.2-2.2-1 2.2-1z" />
      <circle className="tex-bot-star" cx="54" cy="14" r="2" />
      <path d="M32 6a3 3 0 0 1 3 3v5" fill="none" stroke="#b6a8ff" strokeWidth="3" strokeLinecap="round" />
      <circle cx="35" cy="9" r="3" fill="#c6bcff" />
      <rect x="11" y="15" width="42" height="39" rx="15" fill={`url(#${gradientId})`} />
      <rect x="16" y="22" width="32" height="23" rx="10" fill="#1b1930" />
      <ellipse className="tex-eye" cx="25" cy="33" rx="2.6" ry="3.7" fill="#bff8ff" />
      <ellipse className="tex-eye" cx="39" cy="33" rx="2.6" ry="3.7" fill="#bff8ff" />
      <path d="M26 50h12" stroke="#6251c8" strokeWidth="2" strokeLinecap="round" />
      <circle cx="10" cy="32" r="3" fill={shell[0]} />
      <circle cx="54" cy="32" r="3" fill={shell[1]} />
    </svg>
  );
}

function ChatItem({
  thread,
  active,
  onSelect,
  onRename,
  onPin,
  onDelete
}: {
  thread: ChatThread;
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className={`tex-thread ${active ? "is-active" : ""}`}>
      <button className="tex-thread-select" type="button" onClick={onSelect} title={thread.title}>
        <span>{thread.pinned ? "◆" : "◦"}</span>
        <span>{formatTitle(thread.title)}</span>
      </button>
      <div className="tex-thread-menu-wrap">
        <button className="tex-icon-button tex-thread-menu-button" type="button" aria-label="Conversation options" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>•••</button>
        {menuOpen && <div className="tex-thread-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { onRename(); setMenuOpen(false); }}>Rename</button>
          <button type="button" role="menuitem" onClick={() => { onPin(); setMenuOpen(false); }}>{thread.pinned ? "Unpin" : "Pin"}</button>
          <button type="button" role="menuitem" onClick={() => { onDelete(); setMenuOpen(false); }}>Delete</button>
        </div>}
      </div>
    </div>
  );
}

export function Widget({
  platform,
  siteHost,
  enableVoice = true,
  offlineMessage = "Connect a provider in Settings, or start your local engine. I’ll be right here when you’re ready.",
  isAuthenticated = true,
  onSignIn
}: WidgetProps) {
  const store = useMemo(() => createChatStore(), []);
  const threads = useStore(store, (state) => state.threads);
  const activeThreadId = useStore(store, (state) => state.activeThreadId);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [position, setPosition] = useState<WidgetPosition>({ x: Math.max(12, window.innerWidth - 86), y: Math.max(12, window.innerHeight - 96) });
  const [open, setOpen] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [botState, setBotState] = useState<"idle" | "hover" | "listening" | "thinking" | "speaking" | "sleeping" | "notification">("idle");
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [bubbleDismissed, setBubbleDismissed] = useState(false);
  const [quickMenuState, setQuickMenuState] = useState<"closed" | "open" | "closing">("closed");
  const [petAction, setPetAction] = useState<PetAction>("idle");
  const [petNotice, setPetNotice] = useState("");
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [wasDragged, setWasDragged] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const dragStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const cancelStream = useRef<(() => void) | null>(null);
  const streamingMessage = useRef<{ threadId: string; messageId: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const quickMenuTimer = useRef<number | undefined>(undefined);
  const actionTimer = useRef<number | undefined>(undefined);
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const messages = activeThread?.messages ?? [];

  useEffect(() => () => {
    window.clearTimeout(quickMenuTimer.current);
    window.clearTimeout(actionTimer.current);
  }, []);

  const reportError = (error: Error) => {
    void platform.messaging.send({ type: "assistant:error-log", error: { message: error.message, stack: error.stack } });
  };

  useEffect(() => {
    let alive = true;
    void Promise.all([
      platform.storage.get<AssistantSettings>(SETTINGS_KEY),
      platform.storage.get<ChatThread[]>(THREADS_KEY),
      platform.storage.get<WidgetPosition>(POSITION_KEY)
    ]).then(([savedSettings, savedThreads, savedPosition]) => {
      if (!alive) return;
      if (savedSettings) setSettings({ ...DEFAULT_SETTINGS, ...savedSettings });
      if (savedThreads) store.getState().setThreads(savedThreads.map((thread) => ({
        ...thread,
        messages: thread.messages.map((message) => message.status === "streaming" ? { ...message, status: undefined } : message)
      })));
      if (savedPosition) setPosition({
        x: Math.max(12, Math.min(savedPosition.x, window.innerWidth - 76)),
        y: Math.max(12, Math.min(savedPosition.y, window.innerHeight - 76))
      });
      if (!canConnect({ ...DEFAULT_SETTINGS, ...savedSettings })) setBotState("notification");
    }).catch((error: unknown) => reportError(error instanceof Error ? error : new Error(String(error))));
    let persistTimer: number | undefined;
    let latestThreads = store.getState().threads;
    const persistThreads = () => {
      void platform.storage.set(THREADS_KEY, latestThreads)
        .catch((error: unknown) => reportError(error instanceof Error ? error : new Error(String(error))));
    };
    const unsubscribe = store.subscribe((state) => {
      latestThreads = state.threads;
      window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(persistThreads, 300);
    });
    const unwatchSettings = platform.storage.watch<AssistantSettings>(SETTINGS_KEY, (next) => {
      if (next) setSettings({ ...DEFAULT_SETTINGS, ...next });
    });
    const unwatchThreads = platform.storage.watch<ChatThread[]>(THREADS_KEY, (next) => {
      if (next) store.getState().setThreads(next);
    });
    const unwatchPosition = platform.storage.watch<WidgetPosition>(POSITION_KEY, (next) => {
      if (next) setPosition(next);
    });
    const onVisibilityChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    const onOpen = () => setOpen(true);
    window.addEventListener("tex-widget-open", onOpen);
    const removeHotkey = enableVoice ? platform.hotkeys.onPushToTalk(() => {
      setVoiceMode(true);
      setOpen(true);
      setBotState("listening");
    }, settings.hotkey) : () => undefined;
    return () => {
      alive = false;
      cancelStream.current?.();
      const activeStream = streamingMessage.current;
      if (activeStream) store.getState().updateMessage(activeStream.threadId, activeStream.messageId, { status: undefined });
      streamingMessage.current = null;
      unsubscribe();
      window.clearTimeout(persistTimer);
      persistThreads();
      unwatchSettings();
      unwatchThreads();
      unwatchPosition();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("tex-widget-open", onOpen);
      removeHotkey();
    };
  }, [platform, store, settings.hotkey]);

  useEffect(() => {
    let timer: number;
    const resetIdle = () => {
      window.clearTimeout(timer);
      if (!open && botState !== "notification") timer = window.setTimeout(() => setBotState("sleeping"), 120_000);
    };
    resetIdle();
    window.addEventListener("pointermove", resetIdle, { passive: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", resetIdle);
    };
  }, [open, botState]);

  useEffect(() => {
    const onResize = () => setPosition((previous) => ({
      x: Math.min(previous.x, window.innerWidth - 76),
      y: Math.min(previous.y, window.innerHeight - 76)
    }));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const persistPosition = (next: WidgetPosition) => {
    setPosition(next);
    void platform.storage.set(POSITION_KEY, next).catch((error: unknown) => reportError(error instanceof Error ? error : new Error(String(error))));
  };

  const beginDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    setWasDragged(false);
    dragStart.current = { x: event.clientX, y: event.clientY, left: position.x, top: position.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!dragStart.current) return;
    if (Math.abs(event.clientX - dragStart.current.x) + Math.abs(event.clientY - dragStart.current.y) > 5) setWasDragged(true);
    setPosition({
      x: Math.max(8, Math.min(window.innerWidth - 72, dragStart.current.left + event.clientX - dragStart.current.x)),
      y: Math.max(8, Math.min(window.innerHeight - 72, dragStart.current.top + event.clientY - dragStart.current.y))
    });
  };

  const endDrag = () => {
    if (!dragStart.current) return;
    dragStart.current = null;
    const x = position.x < window.innerWidth / 2 ? 12 : Math.max(12, window.innerWidth - 76);
    persistPosition({ x, y: Math.max(12, Math.min(position.y, window.innerHeight - 76)) });
  };

  const startStream = (prompt: string, addUserMessage = true, images: PendingImage[] = []) => {
    let threadId = store.getState().activeThreadId;
    if (!threadId) threadId = store.getState().createThread();
    const currentThread = store.getState().threads.find((thread) => thread.id === threadId);
    if (!currentThread) return;
    const updatedMessages = [...currentThread.messages];
    let newUserMessage: ChatMessage | undefined;
    if (addUserMessage) {
      const attachmentText = images.map((image) => `[Image attached: ${image.name}]`).join(" ");
      newUserMessage = createMessage("user", [prompt, attachmentText].filter(Boolean).join(" "));
      store.getState().appendMessage(threadId, newUserMessage);
      updatedMessages.push(newUserMessage);
    }
    const assistantMessage = createMessage("assistant", "", "streaming");
    store.getState().appendMessage(threadId, assistantMessage);
    streamingMessage.current = { threadId, messageId: assistantMessage.id };
    setBusy(true);
    setBotState("thinking");
    const history = updatedMessages.map(({ role, content, id }) => {
      if (newUserMessage?.id !== id || images.length === 0) return { role, content };
      const parts: LLMStreamContentPart[] = [
        { type: "text", text: content || "Please describe the attached image." },
        ...images.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))
      ];
      return { role, content: parts };
    });
    const targetThreadId = threadId;
    cancelStream.current = platform.messaging.stream(
      { type: "assistant:stream", conversationId: targetThreadId, messages: prepareChatMessages(history) },
      {
        onChunk: (text) => {
          const current = store.getState().threads.find((thread) => thread.id === targetThreadId)?.messages.find((message) => message.id === assistantMessage.id);
          store.getState().updateMessage(targetThreadId, assistantMessage.id, { content: (current?.content ?? "") + text });
          setBotState("speaking");
        },
        onDone: () => {
          store.getState().updateMessage(targetThreadId, assistantMessage.id, { status: undefined });
          setBusy(false);
          setBotState("idle");
          cancelStream.current = null;
          streamingMessage.current = null;
        },
        onError: (error) => {
          store.getState().updateMessage(targetThreadId, assistantMessage.id, {
            content: `I couldn't complete that request: ${error.message}`,
            status: "error"
          });
          reportError(error);
          setBusy(false);
          setBotState("notification");
          cancelStream.current = null;
          streamingMessage.current = null;
        }
      }
    );
  };

  const sendMessage = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || busy) return;
    setInput("");
    const images = pendingImages;
    setPendingImages([]);
    startStream(text, true, images);
  };

  const handleAttachment = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.type.startsWith("text/") || /\.(md|json|csv|log|ts|tsx|js|py|html|css)$/i.test(file.name)) {
      try {
        const content = await file.text();
        setInput((value) => `${value}${value ? "\n\n" : ""}File: ${file.name}\n\`\`\`\n${content.slice(0, 20_000)}\n\`\`\``);
      } catch (error) {
        reportError(error instanceof Error ? error : new Error(String(error)));
        setNotice("That file could not be read.");
      }
    } else if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) {
      if (file.size > 1_000_000) {
        setNotice("Images must be 1 MB or smaller to keep local chat storage lightweight.");
        return;
      }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("The image could not be read."));
          reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("The image format is not supported."));
          reader.readAsDataURL(file);
        });
        setPendingImages((current) => [...current, { name: file.name, dataUrl }]);
        setNotice("Image attached. Vision support depends on your selected model.");
      } catch (error) {
        reportError(error instanceof Error ? error : new Error(String(error)));
        setNotice("That image could not be read.");
      }
    } else {
      setNotice("Attach an image or text file.");
    }
  };

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Copied to clipboard.");
    } catch (error) {
      reportError(error instanceof Error ? error : new Error(String(error)));
      setNotice("Clipboard access was denied by the browser.");
    }
  };

  const regenerate = () => {
    if (!activeThread || busy) return;
    const lastUserIndex = activeThread.messages.map((message) => message.role).lastIndexOf("user");
    if (lastUserIndex < 0) return;
    const previous = activeThread.messages.slice(0, lastUserIndex + 1);
    store.getState().setThreads(threads.map((thread) => thread.id === activeThread.id ? { ...thread, messages: previous } : thread));
    const prompt = previous[previous.length - 1].content;
    store.getState().setActiveThread(activeThread.id);
    startStream(prompt, false);
  };

  const setThreadTitle = (threadId: string) => {
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return;
    setRenameId(threadId);
    setRenameValue(thread.title);
  };

  const openSettings = () => {
    void platform.messaging.send({ type: "assistant:settings-open" }).catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      reportError(normalized);
      setNotice(normalized.message);
    });
  };

  const openVoicePage = () => {
    void platform.messaging.send({ type: "assistant:open-voice" }).catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      reportError(normalized);
      setNotice(normalized.message);
    });
  };

  const closeQuickMenu = () => {
    if (quickMenuState === "closed") return;
    window.clearTimeout(quickMenuTimer.current);
    setQuickMenuState("closing");
    quickMenuTimer.current = window.setTimeout(() => setQuickMenuState("closed"), 180);
  };

  const toggleQuickMenu = () => {
    if (quickMenuState === "open") {
      closeQuickMenu();
      return;
    }
    window.clearTimeout(quickMenuTimer.current);
    setQuickMenuState("open");
  };

  const selectPetAction = (action: PetAction) => {
    const selected = PET_ACTIONS.find((item) => item.id === action);
    if (!selected) return;
    window.clearTimeout(actionTimer.current);
    setPetAction(action);
    setBotState("idle");
    setPetNotice(selected.message);
    setBubbleDismissed(false);
    setBubbleOpen(true);
    if (action !== "idle" && action !== "sleeping") {
      actionTimer.current = window.setTimeout(() => setPetAction("idle"), 2600);
    }
    closeQuickMenu();
  };

  const surprisePet = () => {
    const choices = PET_ACTIONS.filter((action) => action.id !== petAction);
    const selected = choices[Math.floor(Math.random() * choices.length)];
    selectPetAction(selected.id);
  };

  const stopResponse = () => {
    cancelStream.current?.();
    cancelStream.current = null;
    const activeStream = streamingMessage.current;
    if (activeStream) store.getState().updateMessage(activeStream.threadId, activeStream.messageId, { status: undefined });
    streamingMessage.current = null;
    setBusy(false);
    setBotState("idle");
  };

  const saveThreadTitle = (event: FormEvent) => {
    event.preventDefault();
    if (renameId) store.getState().renameThread(renameId, renameValue);
    setRenameId(null);
  };

  const petSide = position.x < window.innerWidth / 2 ? "left" : "right";
  const bubbleLeft = petSide === "left"
    ? Math.max(10, Math.min(position.x + 74, window.innerWidth - 234))
    : Math.max(10, Math.min(position.x - 154, window.innerWidth - 234));
  const bubbleTop = position.y < 142
    ? Math.min(position.y + 78, window.innerHeight - 132)
    : position.y - 132;
  const swapLeft = petSide === "left"
    ? Math.max(10, Math.min(position.x + 72, window.innerWidth - 262))
    : Math.max(10, position.x - 262);
  const swapTop = Math.max(10, Math.min(position.y + 12, window.innerHeight - 222));
  const showBubble = !open && quickMenuState === "closed" && !bubbleDismissed && (botState === "notification" || bubbleOpen);

  return (
    <div className="tex-widget" data-theme={settings.theme} data-visible={visible} data-open={open}>
      <div
        className={`tex-pet-cluster is-${petSide}`}
        style={{ left: position.x, top: position.y }}
        onPointerEnter={() => {
          if (!open) {
            setBotState((current) => current === "notification" ? current : "hover");
            setBubbleOpen(true);
          }
        }}
        onPointerLeave={() => {
          if (!open && botState === "hover") setBotState("idle");
        }}
      >
        <button
          className={`tex-bot-button state-${botState} action-${petAction}`}
          type="button"
          aria-label={open ? "Close Tex assistant" : "Open Tex assistant"}
          aria-expanded={open}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClick={() => {
            if (wasDragged) {
              setWasDragged(false);
              return;
            }
            setOpen(!open);
            setBubbleOpen(false);
            setQuickMenuState("closed");
            window.clearTimeout(quickMenuTimer.current);
            setVoiceMode(false);
            setBotState("idle");
          }}
        >
          <AssistantIcon skin={settings.skin} />
        </button>
        <button
          className={`tex-swap-trigger ${quickMenuState === "open" ? "is-active" : ""}`}
          type="button"
          aria-label="Open pet actions"
          aria-expanded={quickMenuState === "open"}
          title="Pet actions"
          onClick={toggleQuickMenu}
        >
          <span aria-hidden="true">✦</span>
        </button>
      </div>
      {showBubble && <section
        className={`tex-bubble is-${petSide}`}
        style={{ left: bubbleLeft, top: bubbleTop }}
        aria-label="Tex companion message"
        role="status"
        aria-live="polite"
      >
        <div className="tex-bubble-heading">
          <span className="tex-bubble-status" />
          <span>{botState === "notification" ? "READY WHEN YOU ARE" : "YOUR BROWSER SIDEKICK"}</span>
          <button type="button" aria-label="Dismiss companion message" onClick={() => {
            setBubbleOpen(false);
            setBubbleDismissed(true);
            if (botState === "notification") setBotState("idle");
          }}>×</button>
        </div>
        <p>{petNotice || (botState === "notification"
          ? offlineMessage
          : "Hey! Need a hand with something? I’m just a tap away.")}</p>
        <button className="tex-bubble-chat" type="button" onClick={() => {
          setOpen(true);
          setBubbleOpen(false);
          setBotState("idle");
        }}>Let’s chat <span aria-hidden="true">↗</span></button>
      </section>}
      {quickMenuState !== "closed" && !open && <section
        className={`tex-swap-menu is-${petSide} ${quickMenuState === "closing" ? "is-closing" : "is-opening"}`}
        style={{ left: swapLeft, top: swapTop }}
        aria-label="Pet actions"
        aria-hidden={quickMenuState === "closing"}
      >
        <header><span>MOOD & MOMENTS</span><button type="button" aria-label="Close pet actions" onClick={closeQuickMenu}>×</button></header>
        <div className="tex-action-options">
          {PET_ACTIONS.map((action) => <button
            key={action.id}
            className={petAction === action.id ? "is-selected" : ""}
            type="button"
            aria-label={`Make Tex ${action.name.toLowerCase()}`}
            aria-pressed={petAction === action.id}
            onClick={() => selectPetAction(action.id)}
          >
            <span className={`tex-action-icon action-${action.id}`} aria-hidden="true">{action.icon}</span>
            <span className="tex-action-name">{action.name}</span>
          </button>)}
        </div>
        <button className="tex-surprise-action" type="button" onClick={surprisePet}>
          <span aria-hidden="true">✦</span> Surprise me <span className="tex-surprise-hint">random action</span>
        </button>
      </section>}
      {open && <section className="tex-panel" role="dialog" aria-label="Tex AI assistant">
        <header className="tex-header">
          <div className="tex-brand">
            <span className="tex-brand-orb" aria-hidden="true" />
            <div><strong>tex</strong><small>{siteHost}</small></div>
          </div>
          <div className="tex-header-actions">
            <button className="tex-icon-button" type="button" aria-label="Open settings" title="Settings" onClick={openSettings}>⚙</button>
            <button className="tex-icon-button" type="button" aria-label="Close assistant" onClick={() => setOpen(false)}>×</button>
          </div>
        </header>
        <div className="tex-chat-layout">
          <aside className="tex-sidebar" aria-label="Conversations">
            <button className="tex-new-chat" type="button" onClick={() => store.getState().createThread()}>＋ <span>New chat</span></button>
            <div className="tex-thread-list">
              {threads.map((thread) => renameId === thread.id
                ? <form key={thread.id} className="tex-rename-form" onSubmit={saveThreadTitle}>
                    <input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} aria-label="Conversation name" />
                    <button type="submit" aria-label="Save name">✓</button>
                  </form>
                : <ChatItem
                    key={thread.id}
                    thread={thread}
                    active={thread.id === activeThreadId}
                    onSelect={() => store.getState().setActiveThread(thread.id)}
                    onRename={() => setThreadTitle(thread.id)}
                    onPin={() => store.getState().togglePinned(thread.id)}
                    onDelete={() => store.getState().deleteThread(thread.id)}
                  />)}
            </div>
            <button className="tex-sidebar-settings" type="button" onClick={openSettings}>Settings</button>
          </aside>
          <main className="tex-conversation">
            {voiceMode && enableVoice ? <div className="tex-voice-view">
              <button className="tex-voice-back" type="button" onClick={() => { setVoiceMode(false); setBotState("idle"); }}>← Back to chat</button>
              <div className={`tex-voice-orb ${botState === "thinking" ? "is-active" : ""}`} aria-hidden="true"><span /><span /><span /></div>
              <h2>Voice mode</h2>
              <p>Talk naturally with Tex. Your microphone is requested only in the extension voice window.</p>
              <button className="tex-primary-button" type="button" onClick={openVoicePage}>Open voice window</button>
              <small>Shortcut: {settings.hotkey}</small>
            </div> : <>
              <div className="tex-messages" aria-live="polite">
                {isAuthenticated === false ? (
                  <div className="tex-auth-required">
                    <p className="tex-eyebrow">SIGN IN TO TEX</p>
                    <h2>Unlock memory and deep chats</h2>
                    <p>Create an account to save conversations, your provider settings, and assistant memory.</p>
                    <button type="button" className="tex-primary-button" onClick={() => void onSignIn?.()}>Sign in</button>
                  </div>
                ) : messages.length === 0 ? (
                  <div className="tex-welcome">
                    <div className="tex-welcome-mark"><AssistantIcon skin={settings.skin} /></div>
                    <p className="tex-eyebrow">YOUR AI COMPANION</p>
                    <h1>What’s on your mind?</h1>
                    <p className="tex-subtitle">{canConnect(settings) ? "Ask a question, explore an idea, or get something done." : offlineMessage}</p>
                    <div className="tex-suggestions">
                      {["Help me brainstorm", "Explain something simply", "Write a quick draft"].map((item) => <button key={item} type="button" onClick={() => startStream(item)}>{item}<span>↗</span></button>)}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => <article className={`tex-message ${message.role} ${message.status === "error" ? "has-error" : ""}`} key={message.id}>
                    <div className="tex-message-avatar">{message.role === "assistant" ? <span className="tex-mini-orb" /> : "Y"}</div>
                    <div className="tex-message-body">
                      <div className="tex-message-label">{message.role === "assistant" ? "Tex" : "You"}{message.status === "streaming" && <span className="tex-typing">thinking…</span>}</div>
                      <div className="tex-message-content"><MessageContent content={message.content} onCopy={(value) => void copyText(value)} />{message.status === "streaming" && <span className="tex-cursor" aria-label="Generating response" />}</div>
                    </div>
                  </article>)
                )}
                {messages.length > 0 && !busy && messages[messages.length - 1]?.role === "assistant" && <button className="tex-regenerate" type="button" onClick={regenerate}>↻ Regenerate</button>}
              </div>
              {notice && <div className="tex-notice" role="status">{notice}<button type="button" aria-label="Dismiss" onClick={() => setNotice("")}>×</button></div>}
              <form className="tex-composer" onSubmit={sendMessage}>
                <input ref={fileInput} type="file" accept="image/*,text/*,.md,.json,.csv,.log,.ts,.tsx,.js,.py,.html,.css" hidden onChange={(event) => void handleAttachment(event)} />
                {pendingImages.length > 0 && <div className="tex-attachments" aria-label="Attached images">{pendingImages.map((image, index) => <span className="tex-attachment" key={`${image.name}-${index}`}>{image.name}<button type="button" aria-label={`Remove ${image.name}`} onClick={() => setPendingImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></span>)}</div>}
                <button className="tex-compose-tool" type="button" aria-label="Attach image or text file" disabled={busy} onClick={() => fileInput.current?.click()}>＋</button>
                <input
                  className="tex-message-input"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Message Tex…"
                  aria-label="Message Tex"
                  disabled={busy}
                />
                {busy
                  ? <button className="tex-send-button is-stop" type="button" aria-label="Stop response" onClick={stopResponse}>■</button>
                  : <button className="tex-send-button" type="submit" disabled={!input.trim() && pendingImages.length === 0} aria-label="Send message">↑</button>}
                {enableVoice && <button className="tex-voice-button" type="button" aria-label="Open voice mode" onClick={() => { setVoiceMode(true); setBotState("listening"); }}>◉</button>}
              </form>
            </>}
          </main>
        </div>
        <footer className="tex-footer"><span>Tex AI · responses may be inaccurate</span>{enableVoice && <button type="button" onClick={openVoicePage}>Voice settings</button>}</footer>
      </section>}
    </div>
  );
}
