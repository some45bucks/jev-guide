// Side panel. Stage 3: type a goal, get one suggestion for the current page, highlighted on
// the page. The Debug section lists the clickable elements found, with optional badges.
// Recording clicks and suggesting again after each page change comes in stage 4.

import type { Candidate, PageSnapshot } from "./content/candidates";
import type { ContentMessage, HighlightReply, Message, ScanReply, SuggestReply } from "./shared/messages";
import { loadSettings, pagePattern, TYPESAFE_BASE_URL } from "./shared/settings";
import { FLAG_THRESHOLD, MIN_SHOWN_PROBABILITY, NONE_HERE, type Suggestion } from "./shared/suggest";

const setup = document.querySelector<HTMLParagraphElement>("#setup")!;
const openOptions = document.querySelector<HTMLButtonElement>("#open-options")!;
const goalInput = document.querySelector<HTMLTextAreaElement>("#goal")!;
const pageLine = document.querySelector<HTMLParagraphElement>("#page")!;
const suggestButton = document.querySelector<HTMLButtonElement>("#suggest")!;
const result = document.querySelector<HTMLDivElement>("#result")!;
const usageLine = document.querySelector<HTMLParagraphElement>("#usage")!;
const scanButton = document.querySelector<HTMLButtonElement>("#scan")!;
const badgesToggle = document.querySelector<HTMLInputElement>("#badges")!;
const scanStatus = document.querySelector<HTMLParagraphElement>("#scan-status")!;
const tableWrap = document.querySelector<HTMLDivElement>("#table-wrap")!;
const tbody = document.querySelector<HTMLTableSectionElement>("#candidates")!;

// The tab the panel acts on. Tracked ahead of time, not looked up on click, because
// chrome.permissions.request must be the first await after the click (see ensureAccess).
let activeTab: chrome.tabs.Tab | undefined;

type Kind = "ok" | "error" | "info";

function showStatus(target: HTMLElement, text: string, kind: Kind): void {
  target.textContent = text;
  target.dataset.kind = kind;
}

/** Builds an element whose text is set with textContent, the only way page text enters this panel. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function percent(p: number): string {
  return `${Math.round(p * 100)}%`;
}

async function renderSetup(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.apiKey) {
    showStatus(setup, "Add your Jev API key in Settings to get started.", "error");
    return;
  }
  const where = settings.baseUrl === TYPESAFE_BASE_URL ? "TypeSafe" : new URL(settings.baseUrl).host;
  showStatus(setup, `Ready: ${settings.model} via ${where}.`, "ok");
}

async function refreshActiveTab(): Promise<void> {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = activeTab?.url;
  pageLine.textContent = url ? `On ${new URL(url).host}${new URL(url).pathname}` : "No page";
  // Results describe the page they came from; once it changes they're stale.
  tableWrap.hidden = true;
  tbody.replaceChildren();
  showStatus(scanStatus, "", "info");
  result.replaceChildren();
  usageLine.textContent = "";
}

/**
 * Makes sure the extension may script the active tab and returns its id, or shows why not.
 * Must be the first await in a click handler: Chrome only shows the permission prompt while
 * the click still counts as a user gesture. It asks once per site, and answers straight away
 * when access was already granted.
 */
async function ensureAccess(status: HTMLElement): Promise<number | null> {
  const tab = activeTab;
  const pattern = pagePattern(tab?.url);
  if (tab?.id === undefined || !pattern) {
    showStatus(status, "Jev Guide works on https pages and on local servers (localhost).", "error");
    return null;
  }
  if (!(await chrome.permissions.request({ origins: [pattern] }))) {
    showStatus(status, "Access to this site was declined, so the page can't be read.", "error");
    return null;
  }
  return tab.id;
}

async function sendToPage<T>(tabId: number, message: ContentMessage): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
}

/** Injects the content script (a no-op if it's already there) and reads the page. */
async function scanPage(tabId: number): Promise<PageSnapshot> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  const reply = await sendToPage<ScanReply | undefined>(tabId, { type: "scan", badges: badgesToggle.checked });
  if (!reply) throw new Error("The page didn't answer. Reload it and try again.");
  renderCandidates(reply.page.candidates);
  showStatus(scanStatus, `Found ${reply.page.candidates.length} clickable elements in ${reply.ms} ms.`, "ok");
  return reply.page;
}

function renderCandidates(candidates: Candidate[]): void {
  tbody.replaceChildren(
    ...candidates.map((c) => {
      const row = el("tr");
      for (const text of [c.id.slice(1), c.label || "(no label)", c.role, c.href ?? ""]) row.append(el("td", text));
      return row;
    }),
  );
  tableWrap.hidden = candidates.length === 0;
}

async function scan(): Promise<void> {
  const tabId = await ensureAccess(scanStatus);
  if (tabId === null) return;
  scanButton.disabled = true;
  try {
    await scanPage(tabId);
  } catch (err) {
    // Chrome refuses to script some https pages too, such as the Chrome Web Store.
    showStatus(scanStatus, `Couldn't read this page: ${(err as Error).message}`, "error");
  } finally {
    scanButton.disabled = false;
  }
}

/** What to show and highlight for one suggestion. */
function renderSuggestion(s: Suggestion, page: PageSnapshot): ContentMessage & { type: "highlight" } {
  const labelOf = (id: string) => page.candidates.find((c) => c.id === id)?.label || "(no label)";
  const parts: HTMLElement[] = [];
  const marks: (ContentMessage & { type: "highlight" })["marks"] = [];

  if (s.goalReached >= FLAG_THRESHOLD) {
    parts.push(el("p", `This page looks like your goal is done (${percent(s.goalReached)} sure).`, "flag ok"));
  }
  if (s.needsLogin >= FLAG_THRESHOLD) {
    parts.push(el("p", `This page asks you to sign in first (${percent(s.needsLogin)} sure).`, "flag"));
  }

  if (s.confident && s.choice === NONE_HERE) {
    parts.push(el("p", `Nothing on this page looks like the next step (${percent(s.confidence)} sure). Try scrolling, or go back.`));
  } else if (s.confident) {
    const line = el("p", "Click ", "answer");
    line.append(el("strong", labelOf(s.choice)), ` (${percent(s.confidence)} confident)`);
    parts.push(line);
    marks.push({ id: s.choice, text: `Click here · ${percent(s.confidence)}`, tone: "main" });
  } else {
    const intro = s.choice === NONE_HERE ? "The next step may not be on this page." : "Not sure which is next.";
    parts.push(el("p", `${intro} Confidence ${percent(s.confidence)}. The likeliest options:`));
    const list = el("ol", "", "options");
    const shown = s.alternatives.filter((a, i) => i === 0 || a.probability >= MIN_SHOWN_PROBABILITY);
    shown.forEach((a, i) => {
      const item = el("li");
      item.append(el("strong", labelOf(a.id)), ` · ${percent(a.probability)}`);
      list.append(item);
      marks.push({ id: a.id, text: `Option ${i + 1} · ${percent(a.probability)}`, tone: "alt" });
    });
    parts.push(list);
  }
  result.replaceChildren(...parts);
  return { type: "highlight", marks };
}

async function suggestNext(): Promise<void> {
  const goal = goalInput.value.trim();
  if (!goal) return showStatus(result, "Type what you want to do first.", "error");
  const tabId = await ensureAccess(result);
  if (tabId === null) return;

  suggestButton.disabled = true;
  usageLine.textContent = "";
  showStatus(result, "Reading the page and asking Jev…", "info");
  try {
    const page = await scanPage(tabId);
    if (page.candidates.length === 0) return showStatus(result, "No clickable elements found on this page.", "error");

    const message: Message = { type: "suggest", goal, page, previousSteps: [] };
    const reply: SuggestReply | undefined = await chrome.runtime.sendMessage(message);
    if (!reply) return showStatus(result, "The background worker didn't respond. Reload the extension.", "error");
    if (!reply.ok) return showStatus(result, reply.error, "error");

    result.dataset.kind = "";
    const highlight = renderSuggestion(reply.suggestion, page);
    const { calls, inputTokens, latencyMs } = reply.usage;
    usageLine.textContent = `${reply.model} · ${calls} ${calls === 1 ? "call" : "calls"} · ${inputTokens} input tokens · ${latencyMs} ms`;

    if (highlight.marks.length > 0) {
      const drawn = await sendToPage<HighlightReply | undefined>(tabId, highlight);
      if (drawn && drawn.missing.length > 0) {
        result.append(el("p", "The page changed before the highlight was drawn. Suggest again.", "flag"));
      }
    }
  } catch (err) {
    showStatus(result, `Couldn't read this page: ${(err as Error).message}`, "error");
  } finally {
    suggestButton.disabled = false;
  }
}

openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
suggestButton.addEventListener("click", () => suggestNext());
// Enter submits; Shift+Enter adds a line.
goalInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    suggestButton.click();
  }
});
scanButton.addEventListener("click", () => scan());
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
