# Jev Guide

A Chrome extension that helps you reach a goal on a website, such as "cancel my subscription" or
"change my password". You type the goal, and Jev Guide highlights the next button or link to click.
**You always do the clicking**: the extension never clicks, types, or submits anything itself.

Decisions come from Jev, TypeSafe AI's System One model, which answers typed questions (choice,
yes/no, score) about a state instead of generating text.

> Status: stage 3 of 7. Type a goal, and Jev Guide highlights the next element to click on the
> current page. Following you across pages comes in stage 4.

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

Open that URL, open the side panel, type a goal such as "Cancel my subscription", and click
**Suggest next step**. Chrome asks once for access to the site. The **Debug** section lists every
clickable element found, and **Show numbered badges** numbers them on the page. The home page
includes a section of elements the extension should skip (hidden, zero-size, disabled).

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
    "previous_steps": ["Account", "Billing"],
    "elements": { "e8": "button: Change plan", "e11": "link: Cancel subscription → /cancel.html" }
  },
  "questions": {
    "next_click":   { "type": "choice", "instructions": "Which element in `elements` should the person click next to move toward `goal`?",
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
- **Deduplicated:** controls with the same role, label and link (header and footer "Account")
  appear once.
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
src/content.ts       content script, injected on demand: reads the page and draws overlays
src/content/candidates.ts  finds and labels clickable elements, reads title and headings (unit-tested in jsdom)
src/content/overlay.ts     badges and the "Click here" highlight, in shadow roots
src/shared/suggest.ts      builds the Jev questions and parses the answer (pure, unit-tested)
src/options.ts       settings page and connection test
src/sidepanel.ts     side panel: goal, suggestion, debug table
src/shared/jev.ts    API types, response parser and fetch wrapper (pure, unit-tested)
src/shared/settings.ts  settings storage and base-URL validation
src/shared/messages.ts  message types between pages and the background worker
test/                Vitest unit tests
test/fixtures/       fake site with an Account → Billing → Cancel flow
scripts/serve-fixtures.mjs  serves the fake site on localhost
build.mjs            esbuild script behind `npm run build`
```
