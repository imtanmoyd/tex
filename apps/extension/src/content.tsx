import { createRoot } from "react-dom/client";
import { Widget, WidgetErrorBoundary } from "@tex/ui";
import widgetStyles from "../../../packages/ui/src/widget.css?inline";
import { extensionPlatform } from "./platform";

const HOST_ID = "tex-assistant-host";
const DISABLED_SITES_KEY = "assistant:settings";
let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let mountGeneration = 0;

async function startWidget(generation = mountGeneration): Promise<void> {
  if (generation !== mountGeneration || window.top !== window || host || document.getElementById(HOST_ID)) return;
  if (
    location.protocol === "chrome:" ||
    location.protocol === "chrome-extension:" ||
    location.protocol === "edge:" ||
    location.protocol === "about:" ||
    document.contentType === "application/pdf" ||
    location.hostname === "chromewebstore.google.com" ||
    (location.hostname === "chrome.google.com" && location.pathname.startsWith("/webstore")) ||
    /\.pdf$/i.test(location.pathname)
  ) return;

  const settings = await extensionPlatform.storage.get<{ disabledSites?: string[] }>(DISABLED_SITES_KEY);
  if (generation !== mountGeneration || host || document.getElementById(HOST_ID)) return;
  if (settings?.disabledSites?.includes(location.hostname)) return;

  const widgetHost = document.createElement("div");
  widgetHost.id = HOST_ID;
  widgetHost.setAttribute("aria-label", "Tex AI assistant");
  widgetHost.style.cssText = "all:initial;position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;contain:layout style;";
  document.documentElement.appendChild(widgetHost);
  host = widgetHost;

  const shadow = widgetHost.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = widgetStyles;
  shadow.appendChild(style);
  const mount = document.createElement("div");
  mount.id = "tex-widget-root";
  shadow.appendChild(mount);
  const widgetRoot = createRoot(mount);
  root = widgetRoot;

  widgetRoot.render(
    <WidgetErrorBoundary
      onError={(error) => {
        void extensionPlatform.messaging.send({
          type: "assistant:error-log",
          error: { message: error.message, stack: error.stack }
        });
      }}
    >
      <Widget platform={extensionPlatform} siteHost={location.hostname} />
    </WidgetErrorBoundary>
  );

}

function stopWidget(): void {
  mountGeneration += 1;
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
}

chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message.type === "assistant:widget-refresh") {
    stopWidget();
    void startWidget(mountGeneration).catch(logStartError);
  }
  if (message.type === "assistant:widget-open") {
    if (!host) void startWidget(mountGeneration).then(() => window.dispatchEvent(new CustomEvent("tex-widget-open"))).catch(logStartError);
    else window.dispatchEvent(new CustomEvent("tex-widget-open"));
  }
});

extensionPlatform.storage.watch<{ disabledSites?: string[] }>(DISABLED_SITES_KEY, (settings) => {
  if (settings?.disabledSites?.includes(location.hostname)) {
    stopWidget();
    return;
  }
  stopWidget();
  void startWidget(mountGeneration).catch(logStartError);
});

window.addEventListener("pagehide", stopWidget);
window.addEventListener("pageshow", () => {
  if (!host) void startWidget(mountGeneration).catch(logStartError);
});

function logStartError(error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  void extensionPlatform.messaging.send({
    type: "assistant:error-log",
    error: { message: normalized.message, stack: normalized.stack }
  });
}

void startWidget(mountGeneration).catch(logStartError);
