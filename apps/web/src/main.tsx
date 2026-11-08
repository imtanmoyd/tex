import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { Widget, WidgetErrorBoundary } from "@tex/ui";
import widgetStyles from "../../../packages/ui/src/widget.css?inline";
import shellStyles from "./widget-shell.css?inline";
import { WebSettings } from "./WebSettings";
import { setWebAccountNamespace, webPlatform } from "./platform";
import { authStore, useAuth } from "./auth";
import { AuthPanel } from "./AuthPanel";
import "./landing.css";

const AUTH_BAR_ID = "tex-auth-bar-host";

function ensureAuthBarHost(): HTMLDivElement {
  let host = document.getElementById(AUTH_BAR_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = AUTH_BAR_ID;
    document.body.insertBefore(host, document.body.firstChild);
  }
  return host as HTMLDivElement;
}

function App() {
  const { session } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authPanelOpen, setAuthPanelOpen] = useState(false);

  const openSettings = () => {
    if (session) setSettingsOpen(true);
    else setAuthPanelOpen(true);
  };

  useEffect(() => {
    setWebAccountNamespace(session?.user.username ?? null);
  }, [session?.user.username]);

  useEffect(() => {
    const onSettings = () => openSettings();
    window.addEventListener("tex:web-settings", onSettings);
    return () => window.removeEventListener("tex:web-settings", onSettings);
  }, [session]);

  return (
    <>
      <WidgetErrorBoundary onError={(error) => {
        void webPlatform.messaging.send({
          type: "assistant:error-log",
          error: { message: error.message, stack: error.stack }
        });
      }}>
        <Widget
          platform={webPlatform}
          siteHost={window.location.hostname}
          enableVoice={false}
          isAuthenticated={Boolean(session)}
          onSignIn={openSettings}
          offlineMessage="I’m here. Sign in and add a provider in Settings to start a private chat from this browser."
        />
      </WidgetErrorBoundary>
      {session && settingsOpen && (
        <WebSettings platform={webPlatform} onClose={() => setSettingsOpen(false)} />
      )}
      {!session && authPanelOpen && (
        <AuthPanel onClose={() => setAuthPanelOpen(false)} onAuthenticated={() => setAuthPanelOpen(false)} />
      )}
    </>
  );
}

const host = document.createElement("div");
host.id = "tex-web-widget-host";
document.documentElement.appendChild(host);
const shadow = host.attachShadow({ mode: "open" });
const style = document.createElement("style");
style.textContent = `${widgetStyles}\n${shellStyles}`;
shadow.appendChild(style);
const mount = document.createElement("div");
shadow.appendChild(mount);

createRoot(mount).render(
  <WidgetErrorBoundary onError={(error) => {
    void webPlatform.messaging.send({
      type: "assistant:error-log",
      error: { message: error.message, stack: error.stack }
    });
  }}>
    <App />
  </WidgetErrorBoundary>
);

const authRoot = createRoot(ensureAuthBarHost());
function renderAuthBar() {
  const current = authStore.getState().session;
  authRoot.render(
    <div className="tex-auth-bar">
      {current ? (
        <>
          <span className="tex-auth-bar-user">Signed in as {current.user.username} ({current.user.email})</span>
          <button type="button" className="tex-auth-bar-signout" onClick={() => {
            void authStore.getState().logout().catch((error: unknown) => {
              console.error("Tex sign out failed", error);
            });
          }}>Sign out</button>
        </>
      ) : (
        <>
          <button type="button" className="tex-auth-bar-button" onClick={() => {
            window.dispatchEvent(new Event("tex:web-settings"));
          }}>Sign in</button>
          <button type="button" className="tex-auth-bar-button tex-auth-bar-button--secondary" onClick={() => {
            window.dispatchEvent(new Event("tex:web-settings"));
          }}>Sign up</button>
        </>
      )}
  </div>
);
}
void authStore.getState().initialize();
renderAuthBar();
authStore.subscribe(renderAuthBar);

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest<HTMLAnchorElement>("[data-open-chat]");
  if (!link) return;
  event.preventDefault();
  window.dispatchEvent(new Event("tex-widget-open"));
});
