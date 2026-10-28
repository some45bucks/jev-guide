import { describe, expect, it } from "vitest";
import type { Candidate, PageSnapshot } from "../src/content/candidates";
import { type HistoryEdge, pageRef } from "../src/shared/history";
import type { JevResponse } from "../src/shared/jev";
import {
  applyRisk,
  buildRankRequests,
  buildRiskRequest,
  buildSuggestRequest,
  elementLine,
  MAX_DIRECT_CANDIDATES,
  highlightedIds,
  NONE_HERE,
  parseSuggestion,
  RANK_BATCH_SIZE,
  riskIds,
  shortlist,
  type Suggestion,
} from "../src/shared/suggest";

function candidate(n: number, label: string, href: string | null = null, role = "link"): Candidate {
  return { id: `e${n}`, role, label, href, rect: { x: 0, y: 0, width: 10, height: 10 } };
}

const billing: PageSnapshot = {
  title: "Streamly – Billing",
  path: "/billing.html",
  headings: ["Account", "Your plan"],
  candidates: [
    candidate(1, "Streamly home", "/index.html"),
    candidate(2, "Change plan", null, "button"),
    candidate(3, "Cancel subscription", "/cancel.html"),
  ],
};

function bigPage(count: number): PageSnapshot {
  return { ...billing, candidates: Array.from({ length: count }, (_, i) => candidate(i + 1, `Product ${i + 1}`, `/p/${i + 1}`)) };
}

describe("elementLine", () => {
  it("describes an element in one compact line", () => {
    expect(elementLine(candidate(3, "Cancel subscription", "/cancel.html"))).toBe("link: Cancel subscription → /cancel.html");
    expect(elementLine(candidate(2, "", null, "button"))).toBe("button: (no label)");
  });
});

describe("buildSuggestRequest", () => {
  const home = { path: "/index.html", title: "Streamly – Home", headings: ["Welcome back"] };
  const account = { path: "/account.html", title: "Streamly – Account", headings: ["Account"] };
  const history: HistoryEdge[] = [
    { from: home, element: { role: "link", label: "Account", href: "/account.html" }, to: account },
    { from: account, element: { role: "tab", label: "Billing", href: "/billing.html" }, to: pageRef(billing) },
  ];
  const request = buildSuggestRequest("jev-latest", "Cancel my subscription", billing, history);

  it("points the choice at the history", () => {
    expect(request.questions.next_click?.instructions).toContain("`history`");
  });

  it("puts all page text in state, keyed by element id", () => {
    expect(request.state).toEqual({
      goal: "Cancel my subscription",
      page: { title: "Streamly – Billing", path: "/billing.html", headings: ["Account", "Your plan"] },
      history: [
        "on /index.html: clicked link: Account → /account.html ⇒ reached /account.html (Streamly – Account)",
        "on /account.html: clicked tab: Billing → /billing.html ⇒ reached /billing.html (Streamly – Billing)",
      ],
      elements: {
        e1: "link: Streamly home → /index.html",
        e2: "button: Change plan",
        e3: "link: Cancel subscription → /cancel.html",
      },
    });
  });

  it("asks three questions in one request", () => {
    expect(Object.keys(request.questions)).toEqual(["next_click", "goal_reached", "needs_login"]);
    expect(request.questions.goal_reached?.type).toBe("noul");
    expect(request.questions.needs_login?.type).toBe("noul");
  });

  it("offers bare element ids in DOM order, then none_here", () => {
    const next = request.questions.next_click;
    if (next?.type !== "choice") throw new Error("next_click should be a choice");
    expect(Object.keys(next.criteria)).toEqual(["e1", "e2", "e3", NONE_HERE]);
    // Option values never contain page text.
    expect(next.criteria.e3).toBeNull();
  });

  it("refuses more candidates than one Choice can hold", () => {
    expect(() => buildSuggestRequest("m", "g", bigPage(MAX_DIRECT_CANDIDATES + 1), [])).toThrow(/rank/);
    expect(() => buildSuggestRequest("m", "g", bigPage(MAX_DIRECT_CANDIDATES), [])).not.toThrow();
  });
});

describe("buildRankRequests", () => {
  it("splits candidates into batches with one Score question each", () => {
    const requests = buildRankRequests("jev-latest", "g", bigPage(250), []);
    expect(requests.map((r) => Object.keys(r.questions).length)).toEqual([RANK_BATCH_SIZE, RANK_BATCH_SIZE, 50]);
    const q = requests[2]!.questions.e201;
    expect(q?.type).toBe("score");
    expect(q?.instructions).toContain("`elements.e201`");
  });

  it("sends each batch only its own elements", () => {
    const requests = buildRankRequests("jev-latest", "g", bigPage(150), []);
    const elements = (requests[1]!.state as { elements: Record<string, string> }).elements;
    expect(Object.keys(elements)).toHaveLength(50);
    expect(elements.e101).toBe("link: Product 101 → /p/101");
    expect(elements.e1).toBeUndefined();
  });
});

describe("shortlist", () => {
  const page = bigPage(6);
  function scored(scores: number[]): JevResponse {
    return {
      model: "jev-1.14.0",
      inputTokens: 100,
      answers: Object.fromEntries(
        scores.map((score, i) => [`e${i + 1}`, { type: "score" as const, score, confidence: 0.9, probabilities: {} }]),
      ),
    };
  }

  it("keeps the best-scoring candidates, in DOM order", () => {
    const best = shortlist(page.candidates, [scored([0.1, 1.9, 0.2, 1.5, 0, 1.7])], 3);
    expect(best.map((c) => c.id)).toEqual(["e2", "e4", "e6"]);
  });

  it("breaks ties by DOM order", () => {
    expect(shortlist(page.candidates, [scored([1, 1, 1, 1, 1, 1])], 2).map((c) => c.id)).toEqual(["e1", "e2"]);
  });

  it("fails when a batch left elements out", () => {
    expect(() => shortlist(page.candidates, [scored([1, 1, 1])], 2)).toThrow(/left out 3/);
  });
});

describe("parseSuggestion", () => {
  function response(choice: string, confidence: number | null, probabilities: Record<string, number>): JevResponse {
    return {
      model: "jev-1.14.0",
      inputTokens: 640,
      answers: {
        next_click: { type: "choice", choice, confidence, probabilities },
        goal_reached: { type: "noul", noul: 0.01 },
        needs_login: { type: "noul", noul: 0.02 },
      },
    };
  }

  it("returns a confident choice with the flags", () => {
    const s = parseSuggestion(response("e3", 0.98, { e1: 0.01, e2: 0.01, e3: 0.98, none_here: 0 }), billing.candidates, 0.6);
    expect(s).toMatchObject({ choice: "e3", confidence: 0.98, confident: true, goalReached: 0.01, needsLogin: 0.02 });
    expect(s.alternatives[0]).toEqual({ id: "e3", probability: 0.98 });
  });

  it("marks a low-confidence answer and lists the top 3 elements without none_here", () => {
    // Shaped like the live "Book a flight" answer on the billing page.
    const s = parseSuggestion(
      response("e1", 0.45, { e1: 0.49, e2: 0.2, none_here: 0.25, e3: 0.06 }),
      billing.candidates,
      0.6,
    );
    expect(s.confident).toBe(false);
    expect(s.alternatives.map((a) => a.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("accepts none_here as the choice", () => {
    const s = parseSuggestion(response(NONE_HERE, 0.91, { e1: 0.04, e2: 0.03, e3: 0.01, none_here: 0.92 }), billing.candidates, 0.6);
    expect(s).toMatchObject({ choice: NONE_HERE, confident: true });
  });

  it("falls back to the chosen probability when confidence is missing", () => {
    expect(parseSuggestion(response("e2", null, { e2: 0.7, e1: 0.3 }), billing.candidates, 0.6).confidence).toBe(0.7);
  });

  it("rejects a choice that wasn't offered", () => {
    expect(() => parseSuggestion(response("e99", 0.9, { e99: 0.9 }), billing.candidates, 0.6)).toThrow(/isn't one of the options/);
  });

  it("rejects an answer missing a question", () => {
    const partial = response("e1", 0.9, { e1: 0.9 });
    delete partial.answers.needs_login;
    expect(() => parseSuggestion(partial, billing.candidates, 0.6)).toThrow(/not all three/);
  });
});

describe("highlightedIds", () => {
  const base = { confidence: 0.9, goalReached: 0, needsLogin: 0, irreversible: {}, matchesGoal: {}, doubted: false };
  const alternatives = [
    { id: "e1", probability: 0.45 },
    { id: "e2", probability: 0.3 },
    { id: "e3", probability: 0.02 },
  ];

  it("is the choice when confident", () => {
    expect(highlightedIds({ ...base, choice: "e2", confident: true, alternatives })).toEqual(["e2"]);
  });
  it("is nothing when confidently none_here", () => {
    expect(highlightedIds({ ...base, choice: NONE_HERE, confident: true, alternatives })).toEqual([]);
  });
  it("is the likely alternatives when unsure, dropping near-zero ones", () => {
    expect(highlightedIds({ ...base, choice: "e1", confident: false, alternatives })).toEqual(["e1", "e2"]);
  });
});

describe("buildRiskRequest", () => {
  const request = buildRiskRequest("jev-latest", "Cancel my subscription", billing, [], billing.candidates, ["e3", "e2"]);

  it("asks two nouls per element: irreversible final step, and whether it matches the goal", () => {
    expect(Object.keys(request.questions)).toEqual(["irreversible_e3", "matches_goal_e3", "irreversible_e2", "matches_goal_e2"]);
    expect(request.questions.irreversible_e3?.instructions).toContain("final confirmation step");
    expect(request.questions.matches_goal_e3?.instructions).toContain("`goal` exactly");
  });

  it("keeps the same state as the suggestion, so the page context is there", () => {
    expect((request.state as { elements: object }).elements).toHaveProperty("e3", "link: Cancel subscription → /cancel.html");
  });
});

describe("riskIds and applyRisk", () => {
  const confidentPick: Suggestion = {
    choice: "e3",
    confidence: 0.96,
    confident: true,
    alternatives: [
      { id: "e3", probability: 0.96 },
      { id: "e1", probability: 0.03 },
      { id: "e2", probability: 0.01 },
    ],
    goalReached: 0,
    needsLogin: 0,
    irreversible: {},
    matchesGoal: {},
    doubted: false,
  };
  function risk(irreversible: number, matches: number): JevResponse {
    return {
      model: "jev-1.14.0",
      inputTokens: 600,
      answers: { irreversible_e3: { type: "noul", noul: irreversible }, matches_goal_e3: { type: "noul", noul: matches } },
    };
  }

  it("checks the choice and the alternatives the panel could fall back to", () => {
    expect(riskIds(confidentPick)).toEqual(["e3"]);
    expect(riskIds({ ...confidentPick, alternatives: [{ id: "e3", probability: 0.7 }, { id: "e1", probability: 0.2 }] })).toEqual(["e3", "e1"]);
    expect(riskIds({ ...confidentPick, choice: NONE_HERE, alternatives: [{ id: "e1", probability: 0.3 }] })).toEqual(["e1"]);
  });

  it("keeps a confident final step that matches the goal", () => {
    const s = applyRisk(confidentPick, risk(0.87, 0.97), ["e3"]);
    expect(s).toMatchObject({ confident: true, doubted: false, irreversible: { e3: 0.87 }, matchesGoal: { e3: 0.97 } });
  });

  it("doubts a confident final step on the wrong thing, like cancelling a different subscription", () => {
    // Shaped like the hard fixture's channel trap: irreversible, but 0.36 match for "Cancel my Plus subscription".
    const s = applyRisk(confidentPick, risk(0.96, 0.36), ["e3"]);
    expect(s).toMatchObject({ confident: false, doubted: true });
  });

  it("doesn't doubt a reversible click, even if it doesn't match", () => {
    expect(applyRisk(confidentPick, risk(0.1, 0.2), ["e3"])).toMatchObject({ confident: true, doubted: false });
  });

  it("fails loudly when an answer is missing", () => {
    expect(() => applyRisk(confidentPick, risk(0.9, 0.9), ["e3", "e1"])).toThrow(/irreversible_e1/);
  });
});
