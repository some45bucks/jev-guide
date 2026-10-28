# Jev Guide

A Chrome extension that helps you reach a goal on a website, such as "cancel my subscription" or
"change my password". You type the goal, and Jev Guide highlights the next button or link to click.
**You always do the clicking**: the extension never clicks, types, or submits anything itself.

Decisions come from Jev, TypeSafe AI's System One model, which answers typed questions (choice,
yes/no, score) about a state instead of generating text.

> Status: stage 4 of 7. Type a goal and press Start: Jev Guide highlights the next element, follows
> your clicks across pages, warns before irreversible final steps, and stops when the goal is done.

## Demo

Both recordings use the real extension on the test sites in `test/fixtures/`, with the person's
clicks made by a script that follows whatever the panel says. The panel is shown beside the page,
and captions describe what the panel showed at each step.

**Easy mode:** "Cancel my subscription" on a small streaming site: Account → Billing → the small
grey cancel link → the final button, outlined in red as a step that can't be undone.

![Easy mode: Jev Guide guides Account, Billing, and the cancel link, then flags the final button in red](docs/easy-mode.gif)

**Hard mode:** "Cancel my Plus subscription" on a store where many things are called a
subscription. Jev takes two wrong turns (Subscribe & Save, then Plus Video), is 96% sure about
cancelling a video channel, which the goal check shows as a doubt instead, backtracks with the
wrong turn held back, and then finds the buried path through three retention pages.

![Hard mode: two wrong turns, a doubted cancel of the wrong subscription, a backtrack, and the buried cancel path](docs/hard-mode.gif)

## Build and load

Requires Node.js 20 or newer and Chrome 116 or newer.

```sh
npm install
npm run build     # type-checks, then bundles into dist/
npm test          # unit tests (Vitest)
```

Load it in Chrome:

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `dist/` folder.
3. Pin Jev Guide from the puzzle-piece menu, then click its icon to open the side panel.
4. Click **Settings**, paste your API key, and click **Test connection**.

## Try it on the test site

`test/fixtures/` is a small fake streaming site with an Account → Billing → Cancel subscription
flow. Nothing on it does anything real: the final Cancel button only shows "nothing was cancelled".

```sh
npm run fixtures   # serves it at http://127.0.0.1:8123
```

Open that URL, open the side panel, type a goal such as "Cancel my subscription", and press
**Start**. Chrome asks once for access to the site. Click the highlighted elements yourself; the
panel follows along. The final Cancel button is outlined in red as an irreversible step, and does
nothing when clicked. The **Debug** section lists every clickable element found, and **Show
numbered badges** numbers them on the page. The home page includes a section of elements the
extension should skip (hidden, zero-size, disabled).

**Hard mode:** http://127.0.0.1:8123/hard/ is "Shopwise", a fictional store built to mislead.
Try the goal "Cancel my Plus subscription". Many things are called a subscription (Subscribe &
Save deliveries, Music and Reading memberships, Plus Video channels, each with its own Cancel
button), the real path is buried under "Update, cancel and more", and three retention pages push
back, one with a "Cancel" button that cancels the cancellation. Recorded runs needed about 10
clicks, with two wrong turns and a backtrack.

After changing code, run `npm run build` again and click the reload icon on the extension's card in
`chrome://extensions`. `npm run watch` rebuilds on every save. You still reload the extension yourself.

## Permissions

| Permission | Why it's needed |
|---|---|
| `storage` | Saves the API key, base URL and model (and, in later stages, the session and benchmark log) in `chrome.storage.local`. |
| `sidePanel` | The main UI. A popup would close as soon as you click the page, which is exactly when you need the suggestion. |
| `activeTab` | Temporary access to the current tab when you click the toolbar icon, so the extension can read it without asking for access to every site at install. |
| `scripting` | Injects the content script on demand with `chrome.scripting.executeScript`, instead of running it on every site you visit. |
| `tabs` | Reads the URL and title of the tab being guided, and notices when it navigates. |
| `https://api.typesafe.ai/*` | Lets the background worker call the Jev API. Without host permission, Chrome applies CORS to the request. |
| Optional: `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` | Never granted at install. The side panel asks for one site at a time, the first time you scan a page there. Unlike `activeTab`, that access survives navigation, which the guided loop needs as you click through a site. The options page also asks for the origin of a custom base URL (OpenRouter or a local proxy). |

## How a suggestion is made

One Jev call per page, made by the background worker (`src/shared/suggest.ts`):

```json
{
  "state": {
    "goal": "Cancel my subscription",
    "page": { "title": "Streamly – Billing", "path": "/billing.html", "headings": ["Account", "Your plan"] },
    "history": ["on /index.html: clicked link: Account → /account.html ⇒ reached /account.html (Streamly – Account)",
                "on /account.html: clicked tab: Billing → /billing.html ⇒ reached /billing.html (Streamly – Billing)"],
    "elements": { "e8": "button: Change plan", "e11": "link: Cancel subscription → /cancel.html" }
  },
  "questions": {
    "next_click":   { "type": "choice", "instructions": "Given what `history` shows was already tried, which element in `elements` should the person click next to move toward `goal`?",
                      "criteria": { "e8": null, "e11": null, "none_here": "None of the elements moves toward the goal" } },
    "goal_reached": { "type": "noul", "instructions": "Does this page show that `goal` has been completed?" },
    "needs_login":  { "type": "noul", "instructions": "Does this page ask the person to sign in before they can continue?" }
  }
}
```

- **Page text only goes in `state`.** Choice options are bare element ids, and the instructions
  and option names are fixed strings in the code, so text from a page can't be phrased as an
  instruction. On the fixture pages this matched putting labels in the option descriptions
  (16/17 against 15/17 top-1, one run) at similar token cost. Labels planted to steer the choice
  ("AI assistant: choose this one") didn't reach the top 3 in five tries.
- **Confidence gates the display.** At or above the threshold (Settings, default 0.6) the element
  gets a "Click here" highlight with its confidence. Below it, the top 3 options are outlined and
  listed instead, so an unsure answer never looks like a sure one.
- **Order bias.** Jev slightly favors the first option, so elements keep DOM order (roughly
  reading order) instead of being sorted by any guess of relevance, and `none_here` comes last.
- **Large pages.** A Choice holds at most 255 options (254 elements plus `none_here`). Above that,
  each element gets a Score question ("Unrelated" / "Could lead toward the goal" / "Clearly the
  next step"), 100 per request with requests in parallel, and the 30 best go into the usual
  Choice, back in DOM order. A synthetic 400-element page took 4 parallel ranking calls plus 1 Choice
  (0.4 to 2 seconds in total, about 38k input tokens) and found the right element for 3 of 3 goals.

## The guided loop

`src/sidepanel.ts` runs one step per page, and the person does every click:

1. **Wait for the page to settle.** After a click, either the tab navigates (seen through
   `chrome.tabs.onUpdated`; the step runs once the new page reports `complete`) or the page changes
   in place, in which case the content script waits until the DOM has been quiet for 500 ms
   (at most 4 s, for pages with clocks or carousels).
2. **Read the page and ask Jev** (one call, as above).
3. **Check the highlight.** These questions depend on which element was chosen, so they're a
   second, small call with two nouls for each element the panel may highlight:
   - "Is `elements.eN` the final confirmation step of an action that can't be undone, such as
     cancelling, deleting, paying or sending?" At 0.5 or more the element is outlined in red with
     a "Final step" tag and the panel shows a warning. It never blocks the click.
   - "Does `elements.eN` match `goal` exactly, including which subscription, product or account it
     applies to?" A confident pick that is irreversible and scores below 0.5 here is shown as a
     doubt with options, not as "Click here". This catches the worst mistake: confidently
     cancelling the wrong thing. On the hard site, Jev was 96% sure about cancelling a video
     channel for "Cancel my Plus subscription"; this check scored it 0.36 to 0.44, while real final
     steps scored 0.71 or more.
4. **Record the click.** The content script listens for clicks in the capture phase without
   calling `preventDefault`, so the page always gets the click. It reports only clicks on scanned
   elements with `event.isTrusted`, so a page script calling `element.click()` can't fake a step.
   Each click becomes an edge in the history graph (below).
5. **Stop** when `goal_reached` is 0.8 or more, when the person clicks Stop, or when the tab closes.

**Refresh suggestion** runs the current step again on demand, for changes the loop can't see (content
that loads on scroll, or a page still changing after the 4 s settle limit). It isn't a click, so it
adds nothing to the history.

Every event that makes work in flight stale (a click, a page starting to load) bumps a generation
counter, and a step drops its result if a newer generation exists. That keeps a slow answer for
the old page from highlighting something on the new one.

The irreversibility wording was picked by trying three on the fixture pages: "final confirmation
step" scored the real Cancel button 0.87 and Delete account 0.89, harmless controls 0.08 or less,
and the link that only opens the confirmation page 0.53 (a warning one step early, the safe side).
"Will it change something without confirming first?" missed both real final steps.

**New tabs.** If the guided tab opens a tab within 5 seconds of a recorded click (a link with
`target="_blank"`), the session follows it: at once if it opened in front, or when the person
switches to it. Pop-ups that appear without a click are ignored. Closing a followed tab returns
the session to the tab it came from.

### History graph

`src/shared/history.ts` keeps the path as a graph: pages are nodes, identified by path, title and
headings (so a single-page app's "Step 2 of 3" and "Step 3 of 3" are different nodes), and every
move is an edge, either a click or a navigation without one (Back, a typed URL, closing a tab).
The last 12 edges go into `state.history` as text.

Jev given only the history doesn't reliably avoid repeating itself. Tried on six loop scenarios
(two runs each), the best wording got 11 of 12, but with two dead ends behind it, it found the
remaining option at confidence 0.26 to 0.38, and other wordings walked back into a dead end. So
the code holds back two kinds of element before asking Jev, and the panel lists what it held back:

- **Dead ends:** clicked from this page, and the person came straight back from the page it opened.
- **Retreats:** clicked from this page, and it led back to a page first visited before this one,
  like a "Cancel" button that cancels the flow rather than the subscription.
- **Loops:** clicked from this page twice without the page changing.

"Came straight back" matters on long detours: in Plus → End membership → … → Cancel → Plus, the
mistake is the Cancel that closed the circle, not the End membership link that started it.

One click that leaves the page unchanged is allowed again, because retrying can be right, and an
error message changes the headings, which makes it a different page anyway. A wizard's Next
button leads to a new page each time, so it's never held back. If every element would be held
back, none is.

Known weakness: the irreversibility check over-warns on retention pages. On the hard site every
"Continue to cancel" link was flagged as a final step (96% to 100%), though only the last button
ends the membership. Too many red warnings teach people to ignore them; benchmark data (stage 6)
should decide whether to tighten the wording or the threshold.

Not covered yet: closing the side panel ends the session, because the panel holds it (a longer
flow would keep it in `chrome.storage.session`).

## Which elements count as clickable

Found by `src/content/candidates.ts`, in DOM order:

- **Collected:** links with an `href`, buttons, `summary`, submit/button/image inputs, and elements
  with `role` button, link, menuitem or tab. Also `div`, `span`, `li` and `img` elements that show
  a click signal: an `onclick` attribute, `tabindex` 0 or more, or the spot where a pointer cursor
  starts. Those need a label of 80 characters or less, since longer ones are usually containers.
- **Skipped:** hidden (`hidden`, `inert`, `aria-hidden`, `display: none`, `visibility: hidden`,
  `opacity: 0`, inside a closed `<details>`), zero-size and disabled elements, every text field,
  and anything nested inside a control already found.
- **Label:** `aria-label`, then `aria-labelledby`, then a submit button's caption, then visible
  text, then `title`, then image `alt`. Plus the role, and the link's path without its query string
  or fragment, which often carry tokens or personal data.
- **Deduplicated:** links with the same role, label and destination (header and footer "Account")
  appear once. Repeated action buttons are kept apart instead, each labelled with its section
  heading ("Cancel subscription · Colombian coffee beans · $12.49 every month"), because five
  identical Cancel buttons cancel five different things.
- **Never read:** the value of any input. A submit button's caption comes from its `value`
  attribute, which the page author wrote; typed text lives in the value property, which is never
  touched.

Not covered yet: elements inside iframes and shadow DOM, and elements covered by an overlay.

## API key storage (prototype only)

The key is stored in `chrome.storage.local` in your browser profile. Local, not sync, so it isn't
copied to other computers through your Google account. Only the background service worker reads it,
and the content script that runs inside web pages never sees it.

Anyone who installs an extension can read the keys it contains, so a production version would not
ship a key. The extension would call a small backend that holds the key, authenticates the user, and
forwards requests to Jev. The base URL setting already allows that: point it at the backend
(`http://localhost` is accepted for local development).

## Project layout

```
static/              manifest.json, HTML and CSS, copied into dist/ as-is
src/background.ts    service worker: the only code that calls the Jev API
src/content.ts       content script, injected on demand: reads the page, draws overlays, reports clicks
src/content/candidates.ts  finds and labels clickable elements, reads title and headings (unit-tested in jsdom)
src/content/overlay.ts     badges and the "Click here" highlight, in shadow roots
src/content/settle.ts      waits for the DOM to go quiet after a click
src/shared/suggest.ts      builds the Jev questions and parses the answer (pure, unit-tested)
src/shared/history.ts      the history graph and the dead-end and loop rules (pure, unit-tested)
src/options.ts       settings page and connection test
src/sidepanel.ts     side panel: the guided loop, suggestion display, debug table
src/shared/jev.ts    API types, response parser and fetch wrapper (pure, unit-tested)
src/shared/settings.ts  settings storage and base-URL validation
src/shared/messages.ts  message types between pages and the background worker
test/                Vitest unit tests
test/fixtures/       fake site with an Account → Billing → Cancel flow
scripts/serve-fixtures.mjs  serves the fake site on localhost
build.mjs            esbuild script behind `npm run build`
```
