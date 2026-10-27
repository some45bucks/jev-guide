// Side panel. Stage 2: shows the setup status and lists the clickable elements found on the
// current page, with optional numbered badges. The goal input and suggestions come in stage 3.

import type { Candidate } from "./content/candidates";
import type { ContentMessage, ScanReply } from "./shared/messages";
import { loadSettings, pagePattern, TYPESAFE_BASE_URL } from "./shared/settings";

const setup = document.querySelector<HTMLParagraphElement>("#setup")!;
const openOptions = document.querySelector<HTMLButtonElement>("#open-options")!;
const pageLine = document.querySelector<HTMLParagraphElement>("#page")!;
const scanButton = document.querySelector<HTMLButtonElement>("#scan")!;
const badgesToggle = document.querySelector<HTMLInputElement>("#badges")!;
const scanStatus = document.querySelector<HTMLParagraphElement>("#scan-status")!;
const tableWrap = document.querySelector<HTMLDivElement>("#table-wrap")!;
const tbody = document.querySelector<HTMLTableSectionElement>("#candidates")!;

// The tab the panel acts on. Tracked ahead of time, not looked up on click, because
// chrome.permissions.request must be the first await after the click (see scan()).
let activeTab: chrome.tabs.Tab | undefined;

function showScanStatus(text: string, kind: "ok" | "error" | "info"): void {
  scanStatus.textContent = text;
  scanStatus.dataset.kind = kind;
}

async function renderSetup(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.apiKey) {
    setup.textContent = "Add your Jev API key in Settings to get started.";
    setup.dataset.kind = "error";
    return;
  }
  const where = settings.baseUrl === TYPESAFE_BASE_URL ? "TypeSafe" : new URL(settings.baseUrl).host;
  setup.textContent = `Ready: ${settings.model} via ${where}.`;
  setup.dataset.kind = "ok";
}

async function refreshActiveTab(): Promise<void> {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = activeTab?.url;
  pageLine.textContent = url ? new URL(url).host + new URL(url).pathname : "No page";
  // Results describe the page they came from; once it changes they're stale.
  tableWrap.hidden = true;
  tbody.replaceChildren();
  showScanStatus("", "info");
}

function renderCandidates(candidates: Candidate[]): void {
  // Labels are text from the web page, so they go in with textContent, never innerHTML:
  // this page has extension privileges, and page text must not become markup here.
  tbody.replaceChildren(
    ...candidates.map((c) => {
      const row = document.createElement("tr");
      for (const text of [c.id.slice(1), c.label || "(no label)", c.role, c.href ?? ""]) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.append(cell);
      }
      return row;
    }),
  );
  tableWrap.hidden = candidates.length === 0;
}

async function scan(): Promise<void> {
  const tab = activeTab;
  const pattern = pagePattern(tab?.url);
  if (tab?.id === undefined || !pattern) {
    return showScanStatus("Jev Guide works on https pages and on local servers (localhost).", "error");
  }
  // Asks once per site; Chrome answers true straight away if access was already granted.
  // Must be the first await: Chrome only shows the prompt while the click counts as a user gesture.
  if (!(await chrome.permissions.request({ origins: [pattern] }))) {
    return showScanStatus("Access to this site was declined, so the page can't be read.", "error");
  }

  scanButton.disabled = true;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const message: ContentMessage = { type: "scan", badges: badgesToggle.checked };
    const reply: ScanReply | undefined = await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
    if (!reply) return showScanStatus("The page didn't answer. Reload it and try again.", "error");
    renderCandidates(reply.candidates);
    showScanStatus(`Found ${reply.candidates.length} clickable elements in ${reply.ms} ms.`, "ok");
  } catch (err) {
    // Chrome refuses to script some https pages too, such as the Chrome Web Store.
    showScanStatus(`Couldn't read this page: ${(err as Error).message}`, "error");
  } finally {
    scanButton.disabled = false;
  }
}

openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
scanButton.addEventListener("click", () => scan());
// Rescanning draws or clears the badges, so they always match the table.
badgesToggle.addEventListener("change", () => scan());

// Re-render when settings are saved, so the panel doesn't need reopening.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") renderSetup();
});
chrome.tabs.onActivated.addListener(() => refreshActiveTab());
chrome.tabs.onUpdated.addListener((tabId, change) => {
  // url covers single-page-app route changes; status "loading" covers reloads of the same URL.
  if (tabId === activeTab?.id && (change.url || change.status === "loading")) refreshActiveTab();
});

renderSetup();
refreshActiveTab();
