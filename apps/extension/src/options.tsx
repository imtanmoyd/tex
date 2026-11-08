import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { AssistantSettings } from "@tex/core";
import { API_PRESETS } from "@tex/core";
import { WidgetErrorBoundary } from "@tex/ui";
import { extensionPlatform } from "./platform";
import "./options.css";

interface Response<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

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

interface ErrorLog {
  message: string;
  stack?: string;
  timestamp: number;
}

interface EngineStatus {
  connected: boolean;
  configured: boolean;
  providers: string[];
  message: string;
}

interface MemoryItem {
  id: string;
  kind: "fact" | "site_note";
  content: string;
  site_host: string | null;
}

function SettingsPage() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [keyInput, setKeyInput] = useState("");
  const [siteList, setSiteList] = useState("");
  const [errors, setErrors] = useState<ErrorLog[]>([]);
  const [status, setStatus] = useState("Loading settings…");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      const response = await extensionPlatform.messaging.send<Response<AssistantSettings>>({ type: "assistant:settings-get" });
      if (!response.ok || !response.value) {
        setStatus(response.error || "Settings could not be loaded.");
        return;
      }
      const value = { ...DEFAULT_SETTINGS, ...response.value };
      setSettings(value);
      setKeyInput(value.apiKey);
      setSiteList(value.disabledSites.join("\n"));
      setStatus(value.hasApiKey ? "Your provider key is saved on this browser." : "Add a provider key to enable AI replies.");
      const storedErrors = await extensionPlatform.storage.get<ErrorLog[]>("assistant:errors");
      setErrors(Array.isArray(storedErrors) ? storedErrors.slice(-20).reverse() : []);
    })().catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error)));
  }, []);

  const update = <K extends keyof AssistantSettings>(key: K, value: AssistantSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const selectProvider = (next: AssistantSettings["apiProvider"]) => {
    setSettings((current) => {
      const preset = API_PRESETS[next];
      return {
        ...current,
        apiProvider: next,
        provider: preset.provider,
        baseUrl: next === "custom" ? current.baseUrl : preset.baseUrl,
        model: next === "custom" ? current.model : preset.model
      };
    });
    setSaved(false);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("Saving…");
    const next = {
      ...settings,
      apiKey: keyInput,
      disabledSites: siteList.split(/\r?\n/).map((site) => site.trim()).filter(Boolean)
    };
    try {
      const response = await extensionPlatform.messaging.send<Response<AssistantSettings>>({
        type: "assistant:settings-save",
        settings: next
      });
      if (!response.ok || !response.value) {
        setStatus(response.error || "Settings could not be saved.");
        setSaved(false);
        return;
      }
      setSettings({ ...DEFAULT_SETTINGS, ...response.value });
      setKeyInput(response.value.apiKey);
      setSaved(true);
      setStatus("Settings saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setSaved(false);
    }
  };

  const clearData = async () => {
    if (!window.confirm("Clear all Tex settings, API keys, conversations, position, and error logs? This cannot be undone.")) return;
    try {
      const response = await extensionPlatform.messaging.send<Response<null>>({ type: "assistant:clear-data" });
      if (!response.ok) {
        setStatus(response.error || "Could not clear data.");
        return;
      }
      setSettings(DEFAULT_SETTINGS);
      setKeyInput("");
      setSiteList("");
      setErrors([]);
      setStatus("All Tex data has been cleared.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const resetPosition = async () => {
    try {
      await extensionPlatform.storage.remove("assistant:position");
      setStatus("Widget position reset. Reload open tabs to apply.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const refreshErrors = async () => {
    try {
      const storedErrors = await extensionPlatform.storage.get<ErrorLog[]>("assistant:errors");
      setErrors(Array.isArray(storedErrors) ? storedErrors.slice(-20).reverse() : []);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return <main className="options-page">
    <header className="options-header">
      <span className="options-orb" />
      <div><p className="options-eyebrow">PERSONAL AI COMPANION</p><h1>Tex settings</h1></div>
    </header>
    <p className="options-intro">Tune your assistant. Your provider key stays in extension storage and is used only by the background service worker.</p>
    <form onSubmit={(event) => void save(event)}>
      <section className="settings-card">
        <div className="card-heading"><div><h2>AI provider</h2><p>Connect an API-compatible model. Ollama works with its local OpenAI-compatible endpoint and needs no key.</p></div><span className={settings.hasApiKey ? "status-dot connected" : "status-dot"} /></div>
        <label>API provider
          <select value={settings.apiProvider} onChange={(event) => selectProvider(event.target.value as AssistantSettings["apiProvider"])}>
            <option value="gemini">Gemini</option>
            <option value="openrouter">OpenRouter</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label>Model
          <input value={settings.model} onChange={(event) => update("model", event.target.value)} placeholder={settings.provider === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4o-mini"} required />
        </label>
        <label>API base URL
          <input value={settings.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder={settings.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"} type="url" required />
        </label>
        <label>API key
          <input value={keyInput} onChange={(event) => { setKeyInput(event.target.value); setSaved(false); }} type="password" autoComplete="new-password" placeholder={settings.hasApiKey ? "Key saved — enter a replacement or clear it" : "Paste your provider key"} />
        </label>
        <p className="field-note">Keys are never sent to websites. Local extension storage is not encrypted by Chrome; use a device you trust.</p>
        <p className="field-note free-provider-links">
          Free chat options: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a> · <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">GroqCloud</a> · <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer">OpenRouter models</a> · <a href="https://ollama.com/download" target="_blank" rel="noreferrer">Ollama (local)</a>. Cloud quotas change; Google’s free tier may use prompts to improve its products. Avoid sensitive data.
        </p>
      </section>
      <section className="settings-card">
        <div className="card-heading"><div><h2>Appearance & voice</h2><p>Choose the assistant’s visual style and in-page voice shortcut.</p></div></div>
        <div className="field-grid">
          <label>Theme
            <select value={settings.theme} onChange={(event) => update("theme", event.target.value as AssistantSettings["theme"])}>
              <option value="dark">Dark</option><option value="light">Light</option>
            </select>
          </label>
          <label>Character
            <select value={settings.skin} onChange={(event) => update("skin", event.target.value as AssistantSettings["skin"])}>
              <option value="nova">Nova</option><option value="mika">Mika</option><option value="orbit">Orbit</option><option value="echo">Echo</option>
            </select>
          </label>
        </div>
        <label>In-page push-to-talk shortcut
          <input value={settings.hotkey} onChange={(event) => update("hotkey", event.target.value)} placeholder="Alt+Shift+F" />
        </label>
        <p className="field-note">The extension-wide shortcut can be changed at <a href="chrome://extensions/shortcuts" target="_blank" rel="noreferrer">chrome://extensions/shortcuts</a>.</p>
      </section>
      <section className="settings-card">
        <div className="card-heading"><div><h2>Per-site access</h2><p>One hostname per line. The widget will not mount on disabled sites.</p></div></div>
        <label>Disabled sites
          <textarea value={siteList} onChange={(event) => { setSiteList(event.target.value); setSaved(false); }} rows={4} placeholder={"example.com\nprivate.example"} />
        </label>
        <button className="subtle-button" type="button" onClick={() => void resetPosition()}>Reset widget position</button>
      </section>
      <div className="save-row"><p role="status">{status}</p><button className="save-button" type="submit">{saved ? "Saved ✓" : "Save settings"}</button></div>
    </form>
    <MemoryPanel />
    <section className="settings-card error-card">
      <div className="card-heading"><div><h2>Local error log</h2><p>Recent extension errors stored on this device.</p></div><button type="button" className="subtle-button" onClick={() => void refreshErrors()}>Refresh</button></div>
      {errors.length === 0 ? <p className="empty-errors">No errors recorded.</p> : <ul>{errors.map((error, index) => <li key={`${error.timestamp}-${index}`}><time>{new Date(error.timestamp).toLocaleString()}</time><pre>{error.message}{error.stack ? `\n${error.stack}` : ""}</pre></li>)}</ul>}
      <button className="danger-button" type="button" onClick={() => void clearData()}>Clear all assistant data</button>
    </section>
    <footer className="options-footer">Tex · Runs locally in your browser</footer>
  </main>;
}

function MemoryPanel() {
  const [connected, setConnected] = useState(false);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [status, setStatus] = useState("Checking local engine…");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MemoryItem["kind"]>("fact");
  const [content, setContent] = useState("");
  const [siteHost, setSiteHost] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editSiteHost, setEditSiteHost] = useState("");

  const refresh = async (search = query) => {
    setBusy(true);
    try {
      const engine = await extensionPlatform.messaging.send<Response<EngineStatus>>({
        type: "assistant:engine-status"
      });
      if (!engine.ok || !engine.value) throw new Error(engine.error || "Engine status is unavailable.");
      setStatus(engine.value.message);
      setConnected(engine.value.connected);
      if (!engine.value.connected) {
        setItems([]);
        return;
      }

      const result = await extensionPlatform.messaging.send<Response<{ items: MemoryItem[] }>>({
        type: "assistant:memory-list",
        query: search.trim() || undefined
      });
      if (!result.ok || !result.value) throw new Error(result.error || "Local memory could not be loaded.");
      setItems(result.value.items);
      setStatus(`${engine.value.message} ${result.value.items.length} memory items loaded.`);
    } catch (error) {
      setItems([]);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const createMemory = async () => {
    setBusy(true);
    try {
      const result = await extensionPlatform.messaging.send<Response<MemoryItem>>({
        type: "assistant:memory-create",
        kind,
        content,
        ...(kind === "site_note" ? { siteHost } : {})
      });
      if (!result.ok || !result.value) throw new Error(result.error || "Memory could not be saved.");
      setContent("");
      setStatus("Saved on this device.");
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const beginEdit = (item: MemoryItem) => {
    setEditingId(item.id);
    setEditContent(item.content);
    setEditSiteHost(item.site_host ?? "");
  };

  const saveEdit = async (item: MemoryItem) => {
    setBusy(true);
    try {
      const result = await extensionPlatform.messaging.send<Response<MemoryItem>>({
        type: "assistant:memory-update",
        id: item.id,
        content: editContent,
        ...(item.kind === "site_note" ? { siteHost: editSiteHost } : {})
      });
      if (!result.ok) throw new Error(result.error || "Memory could not be updated.");
      setEditingId(null);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteMemory = async (item: MemoryItem) => {
    if (!window.confirm("Delete this saved memory?")) return;
    setBusy(true);
    try {
      const result = await extensionPlatform.messaging.send<Response<null>>({
        type: "assistant:memory-delete",
        id: item.id
      });
      if (!result.ok) throw new Error(result.error || "Memory could not be deleted.");
      setStatus("Memory deleted.");
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const exportMemory = async () => {
    setBusy(true);
    try {
      const result = await extensionPlatform.messaging.send<Response<unknown>>({
        type: "assistant:memory-export"
      });
      if (!result.ok || result.value === undefined) throw new Error(result.error || "Memory export failed.");
      const blob = new Blob([JSON.stringify(result.value, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "tex-memory-export.json";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus("Local memory export downloaded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const forgetEverything = async () => {
    if (!window.confirm("Forget all local engine chats, facts, and site notes? This cannot be undone.")) return;
    setBusy(true);
    try {
      const result = await extensionPlatform.messaging.send<Response<{ deleted: boolean }>>({
        type: "assistant:memory-forget"
      });
      if (!result.ok) throw new Error(result.error || "Local memory could not be cleared.");
      setItems([]);
      setStatus("All local engine memory was deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return <section className="settings-card memory-card">
    <div className="card-heading">
      <div><h2>Local engine memory</h2><p>Chats, facts, and site notes stay in the local SQLite database. Search currently uses local keywords.</p></div>
      <span className={`status-dot ${connected ? "connected" : ""}`} />
    </div>
    <p className="memory-status" role="status">{status}</p>
    <div className="memory-create">
      <label>Memory type
        <select value={kind} onChange={(event) => setKind(event.target.value as MemoryItem["kind"])}>
          <option value="fact">Personal fact</option>
          <option value="site_note">Site note</option>
        </select>
      </label>
      {kind === "site_note" && <label>Site hostname
        <input value={siteHost} onChange={(event) => setSiteHost(event.target.value)} placeholder="docs.example.com" />
      </label>}
      <label>Saved information
        <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={2} maxLength={2000} />
      </label>
      <button className="subtle-button" type="button" disabled={!connected || busy || !content.trim() || (kind === "site_note" && !siteHost.trim())} onClick={() => void createMemory()}>
        Save locally
      </button>
    </div>
    <div className="memory-search">
      <label>Search saved memory
        <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void refresh();
          }
        }} />
      </label>
      <button className="subtle-button" type="button" disabled={!connected || busy} onClick={() => void refresh()}>Search / refresh</button>
    </div>
    {items.length === 0
      ? <p className="memory-empty">{connected ? "No matching saved memories." : "Start the local engine to view device memory."}</p>
      : <ul className="memory-list">{items.map((item) => <li key={item.id}>
        {editingId === item.id
          ? <div className="memory-edit">
            {item.kind === "site_note" && <label>Site hostname
              <input value={editSiteHost} onChange={(event) => setEditSiteHost(event.target.value)} />
            </label>}
            <label>Saved information
              <textarea value={editContent} onChange={(event) => setEditContent(event.target.value)} rows={2} maxLength={2000} />
            </label>
            <button type="button" className="subtle-button" disabled={busy || !editContent.trim()} onClick={() => void saveEdit(item)}>Save</button>
            <button type="button" className="subtle-button" onClick={() => setEditingId(null)}>Cancel</button>
          </div>
          : <div className="memory-item">
            <div><strong>{item.kind === "fact" ? "Fact" : `Site note · ${item.site_host ?? "unknown site"}`}</strong><p>{item.content}</p></div>
            <div className="memory-item-actions">
              <button type="button" className="subtle-button" disabled={busy} onClick={() => beginEdit(item)}>Edit</button>
              <button type="button" className="danger-button" disabled={busy} onClick={() => void deleteMemory(item)}>Delete</button>
            </div>
          </div>}
      </li>)}</ul>}
    <div className="memory-footer">
      <button className="subtle-button" type="button" disabled={!connected || busy} onClick={() => void exportMemory()}>Export JSON</button>
      <button className="danger-button" type="button" disabled={!connected || busy} onClick={() => void forgetEverything()}>Forget everything</button>
    </div>
  </section>;
}

function VoicePage() {
  const [status, setStatus] = useState("Microphone is off.");
  const [active, setActive] = useState(false);
  const bars = useRef<HTMLDivElement>(null);
  const audioRef = useRef<{ stream: MediaStream; context: AudioContext; frame: number } | null>(null);
  const starting = useRef(false);

  const releaseAudio = () => {
    const audio = audioRef.current;
    if (!audio) return;
    cancelAnimationFrame(audio.frame);
    audio.stream.getTracks().forEach((track) => track.stop());
    void audio.context.close();
    audioRef.current = null;
  };

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden" && audioRef.current) {
        releaseAudio();
        setActive(false);
        setStatus("Microphone stopped because the voice window was hidden.");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      releaseAudio();
    };
  }, []);

  const start = async () => {
    if (starting.current || audioRef.current) return;
    starting.current = true;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is not available in this browser context.");
      context = new AudioContext();
      await context.resume();
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (document.visibilityState === "hidden") throw new Error("The voice window became hidden before microphone access was granted.");
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);
      const audio = { stream, context, frame: 0 };
      audioRef.current = audio;
      setActive(true);
      setStatus("Microphone is on. Audio levels are processed locally.");
      const draw = () => {
        analyser.getByteFrequencyData(samples);
        if (bars.current) {
          Array.from(bars.current.children).forEach((bar, index) => {
            const level = samples[index % samples.length] / 255;
            (bar as HTMLElement).style.transform = `scaleY(${0.35 + level * 1.5})`;
          });
        }
        audio.frame = requestAnimationFrame(draw);
      };
      draw();
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (context) void context.close();
      const normalized = error instanceof Error ? error : new Error(String(error));
      setStatus(`Microphone unavailable: ${normalized.message}`);
      setActive(false);
    } finally {
      starting.current = false;
    }
  };

  const stop = () => {
    releaseAudio();
    setActive(false);
    setStatus("Microphone is off.");
  };

  return <main className="voice-page">
    <header className="voice-header"><span className="options-orb" /><div><p className="options-eyebrow">TEX VOICE</p><h1>Talk it out</h1></div></header>
    <p className="voice-copy">Microphone access is requested only after you press start. Audio levels stay in this extension page; speech recognition can be connected as a separate engine.</p>
    <div className={`voice-orb ${active ? "is-active" : ""}`} aria-hidden="true"><div className="voice-bars" ref={bars}>{Array.from({ length: 24 }, (_, index) => <i key={index} />)}</div></div>
    <p className="voice-status" role="status">{status}</p>
    <div className="voice-controls">
      {!active ? <button className="save-button" type="button" onClick={() => void start()}>Enable microphone</button> : <button className="danger-button" type="button" onClick={stop}>Stop listening</button>}
      <button className="subtle-button" type="button" onClick={() => window.close()}>Close</button>
    </div>
    <p className="voice-note">Voice transcription and response audio are not enabled in this UI milestone.</p>
  </main>;
}

function OptionsApp() {
  return location.hash === "#voice" ? <VoicePage /> : <SettingsPage />;
}

createRoot(document.getElementById("root")!).render(
  <WidgetErrorBoundary onError={(error) => {
    void extensionPlatform.messaging.send({
      type: "assistant:error-log",
      error: { message: error.message, stack: error.stack }
    });
  }}>
    <OptionsApp />
  </WidgetErrorBoundary>
);
