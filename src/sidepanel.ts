// Side panel. Stage 4: a guided loop. Start suggests the next click; when the person clicks
// an element, the panel records it, waits for the page to settle (a navigation, or the DOM
// going quiet), and suggests again, until Jev says the goal is reached or the person stops.
// It follows the flow into a new tab the guided tab opens, and keeps a history graph so
// clicks that led nowhere aren't suggested again. The person does every click.

import type { Candidate, PageSnapshot } from "./content/candidates";
import { type ElementRef, type HistoryEdge, pageRef, type PageRef, recordArrival } from "./shared/history";
import type { ContentMessage, HighlightReply, Message, PageEvent, ScanReply, SuggestReply } from "./shared/messages";
import { loadSettings, pagePattern, TYPESAFE_BASE_URL } from "./shared/settings";
import {
  FLAG_THRESHOLD,
  GOAL_DONE_THRESHOLD,
  highlightedIds,
  IRREVERSIBLE_THRESHOLD,
  MATCH_THRESHOLD,
  NONE_HERE,
  type Suggestion,
} from "./shared/suggest";

const setup = document.querySelector<HTMLParagraphElement>("#setup")!;
const openOptions = document.querySelector<HTMLButtonElement>("#open-options")!;
const goalInput = document.querySelector<HTMLTextAreaElement>("#goal")!;
const pageLine = document.querySelector<HTMLParagraphElement>("#page")!;
const startButton = document.querySelector<HTMLButtonElement>("#start")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
const allowButton = document.querySelector<HTMLButtonElement>("#allow")!;
const statusLine = document.querySelector<HTMLParagraphElement>("#status")!;
const result = document.querySelector<HTMLDivElement>("#result")!;
const usageLine = document.querySelector<HTMLParagraphElement>("#usage")!;
const stepsWrap = document.querySelector<HTMLDivElement>("#steps-wrap")!;
const stepsList = document.querySelector<HTMLOListElement>("#steps")!;
const scanButton = document.querySelector<HTMLButtonElement>("#scan")!;
const badgesToggle = document.querySelector<HTMLInputElement>("#badges")!;
const scanStatus = document.querySelector<HTMLParagraphElement>("#scan-status")!;
const tableWrap = document.querySelector<HTMLDivElement>("#table-wrap")!;
const tbody = document.querySelector<HTMLTableSectionElement>("#candidates")!;

// The tab the panel acts on when no session is running. Tracked ahead of time, not looked up
// on click, because chrome.permissions.request must be the first await after the click.
let activeTab: chrome.tabs.Tab | undefined;

/** A tab the guided tab opens within this long after a click is where the flow continues. */
const NEW_TAB_WINDOW_MS = 5000;

interface Session {
  goal: string;
  /**
   * The guided tab. Set at Start and changed only by following a tab it opened, so switching
   * tabs to look something up doesn't derail the session.
   */
  tabId: number;
  /** Tabs the session came from, newest last, to go back to if a followed tab is closed. */
  openerTabs: number[];
  /** Tabs opened in the background after a click; followed once the person switches to one. */
  childTabs: Set<number>;
  /** Every move so far, as edges between pages. Sent to Jev and used to hold back dead ends. */
  history: HistoryEdge[];
  /** The page the last step read; the next arrival is recorded from it. */
  lastPage: PageRef | null;
  /** The click that hasn't reached its next page yet. */
  pendingClick: ElementRef | null;
  lastClickAt: number;
  /**
   * Bumped by every event that makes in-flight work stale (a click, a page load). Each step
   * remembers the generation it started in and drops its result if a newer one exists.
   */
  generation: number;
}

// Held in the panel, so closing the panel ends the session. Fine for a prototype; a longer
// flow would keep it in chrome.storage.session.
let session: Session | null = null;

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

function describeUrl(url: string | undefined): string {
  if (!url) return "No page";
  const { host, pathname } = new URL(url);
  return host + pathname;
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

function clearSuggestion(): void {
  result.replaceChildren();
  usageLine.textContent = "";
}

async function refreshActiveTab(): Promise<void> {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // While guiding, the panel stays on the guided tab; the debug table still follows the active tab.
  tableWrap.hidden = true;
  tbody.replaceChildren();
  showStatus(scanStatus, "", "info");
  if (session) return;
  pageLine.textContent = `On ${describeUrl(activeTab?.url)}`;
  clearSuggestion();
}

function setRunning(running: boolean): void {
  startButton.hidden = running;
  stopButton.hidden = !running;
  refreshButton.hidden = !running;
  goalInput.disabled = running;
  allowButton.hidden = true;
}

/** The clicks so far, including one still waiting for its page to load. */
function renderSteps(s: Session): void {
  const clicks = s.history.flatMap((edge) => (edge.element ? [edge.element] : []));
  if (s.pendingClick) clicks.push(s.pendingClick);
  stepsList.replaceChildren(...clicks.map((e) => el("li", e.label || "(no label)")));
  stepsWrap.hidden = clicks.length === 0;
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

/** Shows one suggestion in the panel and returns the highlight to draw on the page. */
function renderSuggestion(s: Suggestion, page: PageSnapshot): ContentMessage & { type: "highlight" } {
  const labelOf = (id: string) => page.candidates.find((c) => c.id === id)?.label || "(no label)";
  const isFinal = (id: string) => (s.irreversible[id] ?? 0) >= IRREVERSIBLE_THRESHOLD;
  // Only asked to matter for final steps: a reversible click on the wrong thing is cheap to undo.
  const isOffGoal = (id: string) => isFinal(id) && (s.matchesGoal[id] ?? 1) < MATCH_THRESHOLD;
  const note = (id: string) => (isOffGoal(id) ? " · final step · not your goal?" : isFinal(id) ? " · final step" : "");
  const parts: HTMLElement[] = [];
  const marks: (ContentMessage & { type: "highlight" })["marks"] = [];

  if (s.goalReached >= FLAG_THRESHOLD) {
    parts.push(el("p", `This page looks like your goal is done (${percent(s.goalReached)} sure).`, "flag ok"));
  }
  // The loop stops here, so a next step would only contradict the "done" message.
  if (s.goalReached >= GOAL_DONE_THRESHOLD) {
    result.replaceChildren(...parts);
    return { type: "highlight", marks: [] };
  }
  if (s.needsLogin >= FLAG_THRESHOLD) {
    parts.push(el("p", `This page asks you to sign in first (${percent(s.needsLogin)} sure). Sign in, and Jev Guide will continue.`, "flag"));
  }

  const ids = highlightedIds(s);
  if (s.confident && s.choice === NONE_HERE) {
    parts.push(el("p", `Nothing on this page looks like the next step (${percent(s.confidence)} sure). Try scrolling, or go back.`));
  } else if (s.confident) {
    const line = el("p", "Click ", "answer");
    line.append(el("strong", labelOf(s.choice)), ` (${percent(s.confidence)} confident)`);
    parts.push(line);
    const final = isFinal(s.choice);
    marks.push({ id: s.choice, text: `${final ? "Final step · " : ""}Click here · ${percent(s.confidence)}`, tone: final ? "danger" : "main" });
  } else {
    if (s.doubted) {
      // Jev was confident, but the second check says the click can't be undone and may act on
      // something other than the goal (a different subscription, say), so it's not shown as the answer.
      const doubt = el("p", "Jev's top pick, ", "flag danger");
      doubt.append(
        el("strong", labelOf(s.choice)),
        `, can't be undone and may not be the one you mean (${percent(s.matchesGoal[s.choice] ?? 0)} match). Check it against your goal before clicking anything final.`,
      );
      parts.push(doubt);
    }
    const intro = s.doubted ? "Jev Guide isn't sure." : s.choice === NONE_HERE ? "The next step may not be on this page." : "Not sure which is next.";
    parts.push(el("p", `${intro} Confidence ${percent(s.confidence)}. The likeliest options:`));
    const list = el("ol", "", "options");
    ids.forEach((id, i) => {
      const probability = s.alternatives.find((a) => a.id === id)?.probability ?? 0;
      const item = el("li");
      item.append(el("strong", labelOf(id)), ` · ${percent(probability)}${note(id)}`);
      list.append(item);
      marks.push({ id, text: `Option ${i + 1} · ${percent(probability)}${note(id)}`, tone: isFinal(id) ? "danger" : "alt" });
    });
    parts.push(list);
  }

  // A warning, never a block: the page keeps working, and the person decides.
  const finals = ids.filter(isFinal);
  if (finals.length > 0 && !s.doubted) {
    const worst = Math.max(...finals.map((id) => s.irreversible[id]!));
    parts.push(
      el(
        "p",
        `Careful: ${finals.length === 1 && s.confident ? "this looks like" : "an option here looks like"} the final step of something that can't be undone (${percent(worst)} sure). Check the details on the page before you click.`,
        "flag danger",
      ),
    );
  }
  result.replaceChildren(...parts);
  return { type: "highlight", marks };
}

function startSession(goal: string, tabId: number): void {
  session = {
    goal,
    tabId,
    openerTabs: [],
    childTabs: new Set(),
    history: [],
    lastPage: null,
    pendingClick: null,
    lastClickAt: 0,
    generation: 0,
  };
  setRunning(true);
  renderSteps(session);
  requestStep();
}

/** Moves the session to another tab: one the guided tab opened, or (opened = false) one it came from. */
function followTab(tabId: number, opened = true): void {
  const s = session;
  if (!s || s.tabId === tabId) return;
  sendToPage(s.tabId, { type: "clearHighlight" }).catch(() => {});
  if (opened) s.openerTabs.push(s.tabId);
  s.childTabs.delete(tabId);
  s.tabId = tabId;
  clearSuggestion();
  showStatus(statusLine, opened ? "Following the new tab…" : "Back on the previous tab…", "info");
  requestStep();
}

function stopSession(message: string, kind: Kind): void {
  const s = session;
  session = null;
  setRunning(false);
  showStatus(statusLine, message, kind);
  if (s) sendToPage(s.tabId, { type: "clearHighlight" }).catch(() => {});
}

/** Starts a new step and makes any step still in flight stale. */
function requestStep(): void {
  if (!session) return;
  session.generation += 1;
  runStep(session, session.generation);
}

/** One step of the loop: wait for the page to settle, read it, ask Jev, highlight. */
async function runStep(s: Session, generation: number): Promise<void> {
  const stale = () => session !== s || s.generation !== generation;
  allowButton.hidden = true;
  try {
    const tab = await chrome.tabs.get(s.tabId);
    pageLine.textContent = `Guiding on ${describeUrl(tab.url || tab.pendingUrl)}`;
    // Its "complete" event starts the next step.
    if (tab.status === "loading") return showStatus(statusLine, "Waiting for the page to load…", "info");
    const pattern = pagePattern(tab.url);
    if (!pattern) {
      return showStatus(statusLine, "Jev Guide can't read this page. Go back, or Stop.", "error");
    }
    // A link can lead to a site the person hasn't allowed yet. Asking needs a click (a user
    // gesture), so the panel offers a button rather than prompting by itself.
    if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
      if (stale()) return;
      allowButton.textContent = `Allow ${new URL(tab.url!).host}`;
      allowButton.dataset.pattern = pattern;
      allowButton.hidden = false;
      return showStatus(statusLine, "This page is on a new site. Allow access so Jev Guide can keep going.", "info");
    }

    showStatus(statusLine, "Waiting for the page to settle…", "info");
    await chrome.scripting.executeScript({ target: { tabId: s.tabId }, files: ["content.js"] });
    await sendToPage(s.tabId, { type: "waitForQuiet" });
    if (stale()) return;

    showStatus(statusLine, "Reading the page and asking Jev…", "info");
    const page = await scanPage(s.tabId);
    if (stale()) return;
    const here = pageRef(page);
    const history = recordArrival(s.history, s.lastPage, s.pendingClick, here);
    // Committed only once the step is known to be current: a step that went stale may have
    // read the old page just before a slow navigation replaced it.
    const commit = () => {
      s.history = history;
      s.lastPage = here;
      s.pendingClick = null;
      renderSteps(s);
    };
    if (page.candidates.length === 0) {
      // Still a page in the history, so coming back from it counts as a dead end.
      commit();
      return showStatus(statusLine, "No clickable elements found on this page. Go back, or Stop.", "error");
    }

    const message: Message = { type: "suggest", goal: s.goal, page, history };
    const reply: SuggestReply | undefined = await chrome.runtime.sendMessage(message);
    if (stale()) return;
    commit();
    if (!reply) return showStatus(statusLine, "The background worker didn't respond. Reload the extension.", "error");
    if (!reply.ok) return showStatus(statusLine, reply.error, "error");

    const highlight = renderSuggestion(reply.suggestion, page);
    if (reply.skipped.length > 0) {
      result.append(el("p", `Not suggesting again (tried before without getting closer): ${reply.skipped.join(", ")}.`, "muted small"));
    }
    const { calls, inputTokens, latencyMs } = reply.usage;
    usageLine.textContent = `${reply.model} · ${calls} ${calls === 1 ? "call" : "calls"} · ${inputTokens} input tokens · ${latencyMs} ms`;

    if (reply.suggestion.goalReached >= GOAL_DONE_THRESHOLD) {
      return stopSession(`Done: this page shows your goal is complete (${percent(reply.suggestion.goalReached)} sure).`, "ok");
    }
    if (highlight.marks.length > 0) {
      const drawn = await sendToPage<HighlightReply | undefined>(s.tabId, highlight);
      if (stale()) return;
      if (drawn && drawn.missing.length > 0) {
        return showStatus(statusLine, "The page changed before the highlight was drawn. Click Stop and Start to retry.", "error");
      }
    }
    showStatus(statusLine, "Your turn: click on the page. Jev Guide follows along.", "ok");
  } catch (err) {
    // A navigation replaces the page mid-step, which makes messages to it fail. The new
    // page's load starts a fresh step, so only errors from the current step are shown.
    if (stale()) return;
    showStatus(statusLine, `Couldn't read this page: ${(err as Error).message}`, "error");
  }
}

startButton.addEventListener("click", async () => {
  const goal = goalInput.value.trim();
  if (!goal) return showStatus(statusLine, "Type what you want to do first.", "error");
  const tabId = await ensureAccess(statusLine);
  if (tabId === null) return;
  clearSuggestion();
  startSession(goal, tabId);
});
stopButton.addEventListener("click", () => stopSession("Stopped.", "info"));
// For changes the loop can't see, such as content that loads on scroll or a page that kept
// changing past the settle limit. Not a click, so it adds nothing to the history.
refreshButton.addEventListener("click", () => {
  clearSuggestion();
  requestStep();
});
allowButton.addEventListener("click", async () => {
  const pattern = allowButton.dataset.pattern;
  if (!pattern) return;
  if (await chrome.permissions.request({ origins: [pattern] })) requestStep();
  else showStatus(statusLine, "Access declined. Go back to the previous site, or Stop.", "error");
});
openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
// Enter starts; Shift+Enter adds a line.
goalInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    startButton.click();
  }
});
scanButton.addEventListener("click", () => scan());
badgesToggle.addEventListener("change", () => scan());

// Clicks reported by the content script in the guided tab.
chrome.runtime.onMessage.addListener((message: PageEvent, sender) => {
  if (!session || sender.id !== chrome.runtime.id || sender.tab?.id !== session.tabId || sender.frameId !== 0) return false;
  if (message.type === "clicked") {
    session.pendingClick = message.element;
    session.lastClickAt = Date.now();
    renderSteps(session);
    clearSuggestion();
    showStatus(statusLine, "Got your click. Waiting for the page to settle…", "info");
    // If the click navigates, the load events below take over from this step.
    requestStep();
  }
  return false;
});

// Re-render when settings are saved, so the panel doesn't need reopening.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") renderSetup();
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (session?.childTabs.has(tabId)) followTab(tabId);
  refreshActiveTab();
});
// A link with target="_blank" (or a script reacting to the click) opens the next page in a
// new tab. Only tabs opened by the guided tab shortly after a click count, so pop-ups that
// appear on their own don't take over the session.
chrome.tabs.onCreated.addListener((tab) => {
  if (!session || tab.id === undefined || tab.openerTabId !== session.tabId) return;
  if (Date.now() - session.lastClickAt > NEW_TAB_WINDOW_MS) return;
  if (tab.active) followTab(tab.id);
  else session.childTabs.add(tab.id);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (session && tabId === session.tabId) {
    if (change.status === "loading") {
      // The old page is going away: anything in flight is stale until the new one loads.
      session.generation += 1;
      clearSuggestion();
      showStatus(statusLine, "Waiting for the page to load…", "info");
    } else if (change.status === "complete" || change.url) {
      // "complete" after a full load; a url change alone is a single-page-app route change.
      requestStep();
    }
    return;
  }
  // url covers single-page-app route changes; status "loading" covers reloads of the same URL.
  if (tabId === activeTab?.id && (change.url || change.status === "loading")) refreshActiveTab();
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!session || tabId !== session.tabId) return;
  // Back to the tab this one was opened from, if it's still open.
  const s = session;
  for (let back = s.openerTabs.pop(); back !== undefined; back = s.openerTabs.pop()) {
    const exists = await chrome.tabs.get(back).then(() => true, () => false);
    if (session !== s) return;
    if (exists) return followTab(back, false);
  }
  stopSession("The guided tab was closed.", "info");
});

renderSetup();
refreshActiveTab();
