// Background service worker. It is the only part of the extension that calls the Jev API.
// Keeping network access here means the API key is read in one place, and content
// scripts, which run inside untrusted pages, never handle it.

import { pageRef, withoutTried } from "./shared/history";
import { buildTestRequest, callJev, JevError, type JevRequest, type JevResult } from "./shared/jev";
import { isFromExtensionPage, type Message, type SuggestReply, type TestConnectionReply } from "./shared/messages";
import { loadSettings, originPattern } from "./shared/settings";
import {
  applyRisk,
  buildRankRequests,
  buildRiskRequest,
  buildSuggestRequest,
  MAX_DIRECT_CANDIDATES,
  parseSuggestion,
  riskIds,
  shortlist,
} from "./shared/suggest";

// Clicking the toolbar icon opens the side panel. Called at startup, not only on install,
// as the chrome.sidePanel docs recommend.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  // Only the extension's own pages may trigger API calls. Content scripts (added in
  // stage 2) run inside web pages, so their sender URL is the page's, not ours.
  if (sender.id !== chrome.runtime.id || !isFromExtensionPage(sender.url, chrome.runtime.getURL(""))) {
    return false;
  }

  if (message.type === "testConnection") {
    testConnection(message).then(sendResponse);
    return true; // keeps sendResponse valid until the promise resolves
  }
  if (message.type === "suggest") {
    suggest(message).then(sendResponse);
    return true;
  }
  return false;
});

async function testConnection({ settings }: Extract<Message, { type: "testConnection" }>): Promise<TestConnectionReply> {
  if (!settings.apiKey.trim()) return { ok: false, error: "Enter an API key first." };

  // Without host permission for the API origin, Chrome applies CORS and the call fails
  // with an unhelpful network error. Checking first gives a message the person can act on.
  const pattern = originPattern(settings.baseUrl);
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { ok: false, error: `The extension doesn't have permission to call ${new URL(settings.baseUrl).origin} yet.` };
  }

  try {
    const result = await callJev(
      { apiKey: settings.apiKey.trim(), baseUrl: settings.baseUrl },
      buildTestRequest(settings.model),
    );
    const answer = result.answers.is_greeting;
    if (answer?.type !== "noul") return { ok: false, error: "The API answered, but without the expected noul answer." };
    return { ok: true, model: result.model, noul: answer.noul, latencyMs: result.latencyMs, inputTokens: result.inputTokens };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof JevError ? err.message : `Unexpected error: ${String(err)}`;
}

/**
 * One suggestion for one page: the Choice and its two yes/no checks in one call, then a small
 * second call asking whether the elements it may highlight are irreversible final steps, and
 * whether they act on what the goal names. Pages with
 * more candidates than a Choice can hold are ranked first with batches of Score questions,
 * sent in parallel, and the top of that ranking goes into the usual Choice.
 */
async function suggest({ goal, page, history }: Extract<Message, { type: "suggest" }>): Promise<SuggestReply> {
  // The key is read here, not passed in, so it never travels through other parts of the extension.
  const settings = await loadSettings();
  if (!settings.apiKey) return { ok: false, error: "Add your Jev API key in Settings first." };
  const conn = { apiKey: settings.apiKey, baseUrl: settings.baseUrl };

  const started = performance.now();
  let calls = 0;
  let inputTokens = 0;
  async function ask(request: JevRequest): Promise<JevResult> {
    const result = await callJev(conn, request);
    calls += 1;
    inputTokens += result.inputTokens ?? 0;
    return result;
  }

  try {
    // Clicks that already led nowhere aren't offered again; see shared/history.ts for why
    // this is done in code rather than left to Jev.
    const { usable, skipped } = withoutTried(page.candidates, history, pageRef(page));
    let options = usable;
    if (options.length > MAX_DIRECT_CANDIDATES) {
      const ranked = await Promise.all(buildRankRequests(settings.model, goal, page, history, usable).map(ask));
      options = shortlist(usable, ranked);
    }
    const result = await ask(buildSuggestRequest(settings.model, goal, page, history, options));
    let suggestion = parseSuggestion(result, options, settings.threshold);
    const ids = riskIds(suggestion);
    if (ids.length > 0) {
      const risk = await ask(buildRiskRequest(settings.model, goal, page, history, options, ids));
      suggestion = applyRisk(suggestion, risk, ids);
    }
    return {
      ok: true,
      model: result.model,
      suggestion,
      usage: { calls, inputTokens, latencyMs: Math.round(performance.now() - started) },
      skipped: skipped.map((c) => c.label || "(no label)"),
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
