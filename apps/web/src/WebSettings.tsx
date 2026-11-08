import { useEffect, useState, type FormEvent } from "react";
import type { ApiProvider, AssistantSettings, PlatformAdapter } from "@tex/core";
import { API_PRESETS, defaultSettingsForApiProvider } from "@tex/core";
import { useAuth } from "./auth";

const SETTINGS_KEY = "assistant:settings";

export function WebSettings({ platform, onClose }: { platform: PlatformAdapter; onClose: () => void }) {
  const { isAuthenticated } = useAuth();
  const [settings, setSettings] = useState<AssistantSettings>(defaultSettingsForApiProvider("gemini"));
  const [apiProvider, setApiProvider] = useState<ApiProvider>("gemini");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let mounted = true;
    void platform.storage.get<AssistantSettings>(SETTINGS_KEY).then((saved) => {
      if (!mounted || !saved) return;
      const next: AssistantSettings = { ...defaultSettingsForApiProvider(saved.apiProvider), ...saved };
      setSettings(next);
      setApiProvider(saved.apiProvider);
    }).catch((error: unknown) => {
      if (mounted) setStatus(error instanceof Error ? error.message : String(error));
    });
    return () => { mounted = false; };
  }, [platform]);

  const updateSetting = <K extends keyof AssistantSettings>(key: K, value: AssistantSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const selectProvider = (next: ApiProvider) => {
    setApiProvider(next);
    if (next === "custom") return;
    setSettings((current) => ({
      ...current,
      ...API_PRESETS[next],
      apiProvider: next
    }));
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setStatus("");
    try {
      const base = new URL(settings.baseUrl);
      if ((base.protocol !== "https:" && base.protocol !== "http:") || base.username || base.password || base.search || base.hash) {
        throw new Error("Use an HTTP(S) provider URL without embedded credentials or query parameters.");
      }
      if (base.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
        throw new Error("Cleartext HTTP provider URLs are only allowed for loopback addresses.");
      }
      if (settings.apiKey.length > 8192 || settings.model.length > 200) {
        throw new Error("A settings value exceeds the supported length.");
      }
      const payload: unknown = {
        ...settings,
        disabledSites: [] // web has no per-site blocklist yet
      };
      const response = await platform.messaging.send<{ ok: boolean; value?: AssistantSettings; error?: string }>({
        type: "assistant:settings-save",
        settings: payload
      });
      if (!response.ok || !response.value) throw new Error(response.error || "Settings could not be saved.");
      setSettings(response.value);
      setApiProvider(response.value.apiProvider);
      setStatus("Settings saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const clearData = async () => {
    if (!window.confirm("Clear this account's Tex chats, settings, and saved API key from this browser?")) return;
    try {
      await platform.storage.clear();
      const defaults = defaultSettingsForApiProvider("gemini");
      await platform.storage.set(SETTINGS_KEY, defaults);
      await platform.storage.set("assistant:threads", []);
      await platform.storage.set("assistant:position", {
        x: Math.max(12, window.innerWidth - 86),
        y: Math.max(12, window.innerHeight - 96)
      });
      setSettings(defaults);
      setApiProvider("gemini");
      setStatus("Local Tex data cleared.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const openAuth = () => {
    onClose();
    setTimeout(() => window.dispatchEvent(new Event("tex:web-settings")), 0);
  };

  if (!isAuthenticated) {
    return (
      <div className="tex-web-settings-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}>
        <section className="tex-web-settings" role="dialog" aria-modal="true" aria-labelledby="tex-web-settings-title">
          <header>
            <div><p>YOUR DEVICE, YOUR CHOICE</p><h2 id="tex-web-settings-title">Sign in to Tex</h2></div>
            <button type="button" className="tex-web-settings-close" aria-label="Close settings" onClick={onClose}>×</button>
          </header>
          <p className="tex-web-privacy">
            Sign in to unlock personal memory and deeper chats. Provider keys, conversations, and settings stay in this browser.
          </p>
          <div className="tex-web-settings-actions" style={{ display: "grid", gap: 10, marginTop: 16 }}>
            <button type="button" className="tex-web-save" onClick={() => void openAuth()}>Sign in</button>
            <button type="button" className="tex-web-clear" onClick={() => void onClose()}>Not now</button>
          </div>
        </section>
      </div>
    );
  }

  const custom = apiProvider === "custom";

  return (
    <div className="tex-web-settings-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="tex-web-settings" role="dialog" aria-modal="true" aria-labelledby="tex-web-settings-title">
        <header>
          <div><p>YOUR DEVICE, YOUR CHOICE</p><h2 id="tex-web-settings-title">Chat settings</h2></div>
          <button type="button" className="tex-web-settings-close" aria-label="Close settings" onClick={onClose}>×</button>
        </header>
        <p className="tex-web-privacy">
          This website has no Tex chat server. Chats and your key are stored in this browser (not encrypted); requests go directly from your browser to the provider you choose. Don’t save a key on a shared device.
        </p>
        <form onSubmit={(event) => void save(event)}>
          <label>
            API provider
            <select value={apiProvider} onChange={(event) => selectProvider(event.target.value as ApiProvider)}>
              <option value="gemini">Gemini</option>
              <option value="openrouter">OpenRouter</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label>
            Model
            <input
              value={settings.model}
              onChange={(event) => updateSetting("model", event.target.value)}
              autoComplete="off"
              required
              disabled={!custom}
            />
            {!custom && <span className="tex-web-optional">Preset for {apiProvider}</span>}
          </label>
          <label>
            Provider API URL
            <input
              value={settings.baseUrl}
              onChange={(event) => updateSetting("baseUrl", event.target.value)}
              autoComplete="url"
              required
              disabled={!custom}
            />
            {!custom && <span className="tex-web-optional">Preset for {apiProvider}</span>}
          </label>
          <label>
            API key <span className="tex-web-optional">saved only in this browser</span>
            <input
              type="password"
              value={settings.apiKey}
              onChange={(event) => updateSetting("apiKey", event.target.value)}
              autoComplete="new-password"
              spellCheck={false}
            />
          </label>
          <p className="tex-web-provider-note">
            Free-tier access and browser CORS support depend on your provider. Requests go directly from your browser to the provider; Tex does not proxy or receive your messages or key.
          </p>
          {status && <p className="tex-web-settings-status" role="status">{status}</p>}
          <div className="tex-web-settings-actions">
            <button type="button" className="tex-web-clear" onClick={() => void clearData()}>Clear local data</button>
            <button type="submit" className="tex-web-save" disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
