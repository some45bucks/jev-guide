// Turns a page snapshot into Jev questions and Jev's answers into a suggestion. Pure functions
// only; the background worker does the network calls.
//
// Everything that comes from the page (title, headings, element labels) goes in `state`, and
// the Choice options are bare element ids. Instructions and option names are written by us,
// so page text can only ever be data. On the fixture pages this placement also matched
// putting labels in the option descriptions (16/17 top-1 against 15/17) at a similar cost.

import type { Candidate, PageSnapshot } from "../content/candidates";
import { edgeText, elementLine, type HistoryEdge, MAX_HISTORY_IN_STATE } from "./history";
import { JevError, type JevRequest, type JevResponse } from "./jev";

export { elementLine };

export const NONE_HERE = "none_here";
/** Choice accepts at most 255 options, and none_here takes one of them. */
export const MAX_DIRECT_CANDIDATES = 254;
/** How many top-ranked candidates go into the final Choice on large pages. */
export const SHORTLIST_SIZE = 30;
/** Score questions per ranking request. Several requests run in parallel. */
export const RANK_BATCH_SIZE = 100;
/**
 * goal_reached and needs_login are shown from this probability. On the fixture pages both
 * were 0.99 or more when true and at most 0.2 when false, so the exact cut matters little.
 */
export const FLAG_THRESHOLD = 0.5;
/**
 * Alternatives below this probability aren't shown (a "0%" option is noise, not a choice).
 * The parsed suggestion still keeps the raw top 3 for the benchmark log.
 */
export const MIN_SHOWN_PROBABILITY = 0.05;
/** From this probability a highlighted element is shown in red as a final, irreversible step. */
export const IRREVERSIBLE_THRESHOLD = 0.5;
/** Below this, an irreversible step is judged not to act on the thing the goal names. */
export const MATCH_THRESHOLD = 0.5;
/**
 * The guided loop stops once goal_reached is this high. Stricter than FLAG_THRESHOLD because
 * stopping too early leaves the person without guidance, while one extra suggestion costs little.
 */
export const GOAL_DONE_THRESHOLD = 0.8;

function baseState(goal: string, page: PageSnapshot, history: HistoryEdge[], candidates: Candidate[]) {
  return {
    goal,
    page: { title: page.title, path: page.path, headings: page.headings },
    // The recent moves and where they led, oldest first: "on /: clicked link: Account → /account ⇒ reached /account (Account)".
    history: history.slice(-MAX_HISTORY_IN_STATE).map(edgeText),
    elements: Object.fromEntries(candidates.map((c) => [c.id, elementLine(c)])),
  };
}

/**
 * The one request per page: which element next, plus two yes/no checks batched into the same
 * call because they read the same state. `candidates` defaults to the whole page; on large
 * pages it's the shortlist from ranking, still in DOM order.
 */
export function buildSuggestRequest(
  model: string,
  goal: string,
  page: PageSnapshot,
  history: HistoryEdge[],
  candidates: Candidate[] = page.candidates,
): JevRequest {
  if (candidates.length > MAX_DIRECT_CANDIDATES) {
    throw new Error(`At most ${MAX_DIRECT_CANDIDATES} candidates fit in one Choice; rank them first.`);
  }
  // Ids only: the labels are in state.elements, which the instructions point to.
  const criteria: Record<string, string | null> = Object.fromEntries(candidates.map((c) => [c.id, null]));
  criteria[NONE_HERE] = "None of the elements moves toward the goal";
  return {
    model,
    state: baseState(goal, page, history, candidates),
    questions: {
      next_click: {
        type: "choice",
        // Pointing at `history` helped in tests: with two dead ends behind it, Jev found the
        // remaining option only with this wording (dead ends are also removed in code).
        instructions: "Given what `history` shows was already tried, which element in `elements` should the person click next to move toward `goal`?",
        criteria,
      },
      goal_reached: { type: "noul", instructions: "Does this page show that `goal` has been completed?" },
      needs_login: { type: "noul", instructions: "Does this page ask the person to sign in before they can continue?" },
    },
  };
}

const RANK_LEVELS = [
  "Unrelated to the goal",
  "Could lead toward the goal",
  "Clearly the next step toward the goal",
];

/**
 * For pages with more candidates than one Choice can hold: one Score question per element,
 * in batches. Each batch's state holds only its own elements, so no request repeats the
 * whole page.
 */
export function buildRankRequests(
  model: string,
  goal: string,
  page: PageSnapshot,
  history: HistoryEdge[],
  candidates: Candidate[] = page.candidates,
): JevRequest[] {
  const requests: JevRequest[] = [];
  for (let i = 0; i < candidates.length; i += RANK_BATCH_SIZE) {
    const batch = candidates.slice(i, i + RANK_BATCH_SIZE);
    requests.push({
      model,
      state: baseState(goal, page, history, batch),
      questions: Object.fromEntries(
        batch.map((c) => [
          c.id,
          {
            type: "score" as const,
            instructions: `How well does clicking \`elements.${c.id}\` move the person toward \`goal\`?`,
            criteria: RANK_LEVELS,
          },
        ]),
      ),
    });
  }
  return requests;
}

/** The best-scoring candidates, returned in DOM order so the final Choice keeps its neutral order. */
export function shortlist(candidates: Candidate[], rankResponses: JevResponse[], size = SHORTLIST_SIZE): Candidate[] {
  const scores = new Map<string, number>();
  for (const response of rankResponses) {
    for (const [id, answer] of Object.entries(response.answers)) {
      if (answer.type === "score") scores.set(id, answer.score);
    }
  }
  const missing = candidates.filter((c) => !scores.has(c.id));
  if (missing.length > 0) throw new JevError(`The ranking answer left out ${missing.length} elements.`);
  // Sort is stable, so equal scores keep DOM order.
  const best = new Set(
    [...candidates]
      .sort((a, b) => scores.get(b.id)! - scores.get(a.id)!)
      .slice(0, size)
      .map((c) => c.id),
  );
  return candidates.filter((c) => best.has(c.id));
}

export interface Suggestion {
  /** A candidate id, or NONE_HERE. */
  choice: string;
  confidence: number;
  /** True when confidence clears the threshold; otherwise the panel shows the alternatives. */
  confident: boolean;
  /** The three likeliest elements (none_here left out), most likely first. */
  alternatives: { id: string; probability: number }[];
  /** Probability that the page shows the goal is done. */
  goalReached: number;
  /** Probability that the page asks the person to sign in. */
  needsLogin: number;
  /**
   * For each element the panel may highlight: probability that clicking it is the final step
   * of something that can't be undone. Filled in by a second request (see buildRiskRequest).
   */
  irreversible: Record<string, number>;
  /** For the same elements: probability that the element acts on exactly what the goal names. */
  matchesGoal: Record<string, number>;
  /**
   * True when a confident pick was turned into "not sure" because it's irreversible and
   * doesn't seem to act on what the goal names (say, cancelling a different subscription).
   */
  doubted: boolean;
}

export function parseSuggestion(response: JevResponse, candidates: Candidate[], threshold: number): Suggestion {
  const next = response.answers.next_click;
  const reached = response.answers.goal_reached;
  const login = response.answers.needs_login;
  if (next?.type !== "choice" || reached?.type !== "noul" || login?.type !== "noul") {
    throw new JevError("The API answered, but not all three questions came back.");
  }
  const ids = new Set(candidates.map((c) => c.id));
  if (next.choice !== NONE_HERE && !ids.has(next.choice)) {
    throw new JevError(`The API chose "${next.choice}", which isn't one of the options.`);
  }
  // Confidence summarizes the whole distribution; fall back to the chosen option's probability.
  const confidence = next.confidence ?? next.probabilities[next.choice] ?? 0;
  const alternatives = Object.entries(next.probabilities)
    .filter(([id]) => ids.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, probability]) => ({ id, probability }));
  return {
    choice: next.choice,
    confidence,
    confident: confidence >= threshold,
    alternatives,
    goalReached: reached.noul,
    needsLogin: login.noul,
    irreversible: {},
    matchesGoal: {},
    doubted: false,
  };
}

/** The elements the panel highlights: the choice when confident, otherwise the likely alternatives. */
export function highlightedIds(s: Suggestion): string[] {
  if (s.confident) return s.choice === NONE_HERE ? [] : [s.choice];
  return s.alternatives.filter((a, i) => i === 0 || a.probability >= MIN_SHOWN_PROBABILITY).map((a) => a.id);
}

/**
 * Elements to check in the second request: every element the panel might highlight, the choice
 * and the likely alternatives, so a confident pick can still fall back to the alternatives.
 */
export function riskIds(s: Suggestion): string[] {
  const ids = highlightedIds({ ...s, confident: false });
  return s.choice !== NONE_HERE && !ids.includes(s.choice) ? [s.choice, ...ids] : ids;
}

/**
 * The second request: two nouls per element that may be highlighted. They depend on which
 * elements were chosen, so they can't share the first request. Asking about every element up
 * front would avoid the wait but cost questions per element.
 *
 * Irreversibility asks about the *final confirmation* step. Tried on the fixture pages, it scored
 * the real Cancel button 0.87 and Delete account 0.89, harmless controls 0.08 or less, and the
 * link that only opens the confirmation page 0.53 (a warning one step early, the safe side).
 * Asking "will it change something without confirming first" missed both real final steps.
 *
 * The goal match catches the worst mistake: a confident, irreversible click on the wrong thing,
 * such as cancelling a video channel when the goal was the store membership. On the hard
 * fixture, this wording scored those traps 0.36 or less and real final steps 0.71 or more; a
 * looser "is it the same thing the goal is about?" put the channel trap at 0.49.
 *
 * The wording asks about the *final confirmation* step. Tried on the fixture pages, it scored
 * the real Cancel button 0.87 and Delete account 0.89, harmless controls 0.08 or less, and the
 * link that only opens the confirmation page 0.53 (a warning one step early, the safe side).
 * Asking "will it change something without confirming first" missed both real final steps.
 */
export function buildRiskRequest(
  model: string,
  goal: string,
  page: PageSnapshot,
  history: HistoryEdge[],
  candidates: Candidate[],
  ids: string[],
): JevRequest {
  return {
    model,
    state: baseState(goal, page, history, candidates),
    questions: Object.fromEntries(
      ids.flatMap((id) => [
        [
          `irreversible_${id}`,
          {
            type: "noul" as const,
            instructions: `Is \`elements.${id}\` the final confirmation step of an action that can't be undone, such as cancelling, deleting, paying or sending?`,
          },
        ],
        [
          `matches_goal_${id}`,
          {
            type: "noul" as const,
            instructions: `Does \`elements.${id}\` match \`goal\` exactly, including which subscription, product or account it applies to?`,
          },
        ],
      ]),
    ),
  };
}

/** Reads the second request's answers into the suggestion, and doubts a confident pick if needed. */
export function applyRisk(s: Suggestion, response: JevResponse, ids: string[]): Suggestion {
  const read = (key: string) => {
    const answer = response.answers[key];
    if (answer?.type !== "noul") throw new JevError(`The answer "${key}" is missing.`);
    return answer.noul;
  };
  const irreversible = Object.fromEntries(ids.map((id) => [id, read(`irreversible_${id}`)]));
  const matchesGoal = Object.fromEntries(ids.map((id) => [id, read(`matches_goal_${id}`)]));
  const doubted =
    s.confident &&
    s.choice !== NONE_HERE &&
    (irreversible[s.choice] ?? 0) >= IRREVERSIBLE_THRESHOLD &&
    (matchesGoal[s.choice] ?? 1) < MATCH_THRESHOLD;
  return { ...s, irreversible, matchesGoal, doubted, confident: s.confident && !doubted };
}
