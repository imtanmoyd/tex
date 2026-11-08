import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WidgetErrorBoundary } from "@tex/ui";
import { extensionPlatform } from "./platform";
import "./popup.css";

interface Response<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

interface EngineStatus {
  connected: boolean;
  configured: boolean;
  providers: string[];
  message: string;
}

function Popup() {
  const [hostname, setHostname] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [message, setMessage] = useState("Loading current site…");
  const [engineMessage, setEngineMessage] = useState("Checking local engine…");
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    void extensionPlatform.messaging.send<Response<EngineStatus>>({ type: "assistant:engine-status" })
      .then((response) => {
        setEngineMessage(response.ok && response.value
          ? response.value.message
          : response.error || "Local engine status is unavailable.");
      })
      .catch((error: unknown) => setEngineMessage(error instanceof Error ? error.message : String(error)));

    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) {
          setMessage("This page is not available to the assistant.");
          return;
        }
        const url = new URL(tab.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          setMessage("The assistant cannot run on this browser page.");
          return;
        }
        setHostname(url.hostname);
        setAvailable(true);
        const settings = await extensionPlatform.storage.get<{ disabledSites?: string[] }>("assistant:settings");
        const isEnabled = !settings?.disabledSites?.includes(url.hostname);
        setEnabled(isEnabled);
        setMessage(isEnabled ? "Assistant is available on this site." : "Assistant is paused on this site.");
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        setMessage(normalized.message);
      }
    })();
  }, []);

  const toggleSite = async () => {
    if (!hostname) return;
    setMessage("Updating site access…");
    try {
      const result = await extensionPlatform.messaging.send<Response<unknown>>({ type: "assistant:site-toggle", hostname });
      if (!result.ok) {
        setMessage(result.error || "Could not update this site.");
        return;
      }
      setEnabled(!enabled);
      setMessage(!enabled ? "Assistant enabled on this site." : "Assistant paused on this site.");
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: "assistant:widget-refresh" });
        } catch {
          setMessage("Site preference saved. This page cannot host the assistant.");
        }
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const openChat = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) {
        setMessage("No active page is available.");
        return;
      }
      await chrome.tabs.sendMessage(tab.id, { type: "assistant:widget-open" });
      window.close();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The assistant cannot open on this browser page.");
    }
  };

  const openSettings = async () => {
    try {
      await extensionPlatform.messaging.send({ type: "assistant:settings-open" });
      window.close();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return <main className="popup">
    <header className="popup-header"><span className="popup-orb" /><div><strong>tex</strong><small>AI companion</small></div></header>
    <p className="popup-site" title={hostname}>{hostname || "Current tab"}</p>
    <p className="popup-message" role="status">{message}</p>
    <p className="popup-engine-status" role="status">{engineMessage}</p>
    <button className={`popup-toggle ${enabled ? "is-enabled" : ""}`} type="button" disabled={!available} onClick={() => void toggleSite()}>
      <span className="popup-toggle-dot" />{enabled ? "Enabled on this site" : "Paused on this site"}
    </button>
    <button className="popup-primary" type="button" disabled={!available || !enabled} onClick={() => void openChat()}>Open chat <span>↗</span></button>
    <button className="popup-settings" type="button" onClick={() => void openSettings()}>Settings <span>⚙</span></button>
  </main>;
}

createRoot(document.getElementById("root")!).render(
  <WidgetErrorBoundary onError={(error) => {
    void extensionPlatform.messaging.send({
      type: "assistant:error-log",
      error: { message: error.message, stack: error.stack }
    });
  }}>
    <Popup />
  </WidgetErrorBoundary>
);
