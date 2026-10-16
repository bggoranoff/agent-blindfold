// The browser half of agent-blindfold: finds the login boxes in a tab and fills them. signin.mjs runs it over a DevTools
// port, and the companion extension runs its page functions in the user's own Chrome with chrome.scripting.

export const POLL_MS = 100;
const SETTLE_MS = 10000;
export const LOAD_MS = 15000;
// Sites check a box when it loses focus and hold back a submit until that check is done, so a submit waits for the
// page's requests to go quiet, for at most as long as a person's pause.
export const PAUSE_MS = 1000;
const QUIET_MS = 150;

// Finds the boxes to ask for, when the user is asked, and keeps them in globalThis.wired for the fill to reach.
export const DETECT = (how, wanted, positions, key) => {
  // Password managers' and sites' helper fields render but are aria-hidden; no person can see or reach them.
  const shown = (e) => e.getClientRects().length && !e.disabled && !e.readOnly && !e.closest("[aria-hidden=true]")
    && getComputedStyle(e).visibility !== "hidden" && !["hidden", "submit", "button", "checkbox", "radio"].includes(e.type);
  const inputs = [...document.querySelectorAll("input")].filter(shown);
  const hint = (e) => [e.name, e.id, e.placeholder, e.getAttribute("aria-label"), e.autocomplete].join(" ").toLowerCase();
  const label = (e) => (e.labels?.[0]?.innerText || e.getAttribute("aria-label") || e.placeholder || "").trim().slice(0, 80);
  const find = () => {
    const passwords = inputs.filter((e) => e.type === "password");
    if (passwords.length > 1) return { reason: "The page shows more than one password box. Click into the right one and ask with --focused." };
    const [password] = passwords;
    const boxes = inputs.filter((e) => e.maxLength === 1);
    const code = inputs.find((e) => e.autocomplete === "one-time-code")
      || inputs.find((e) => e !== password && /otp|code|pin|verif|2fa|mfa|token/.test(hint(e)));
    const beforePassword = inputs.slice(0, Math.max(inputs.indexOf(password), 0))
      .filter((e) => ["text", "email", "tel"].includes(e.type));
    const username = inputs.find((e) => /username|email/.test(e.autocomplete)) || inputs.find((e) => e.type === "email")
      || inputs.find((e) => e !== code && e !== password && /user|email|login|account|identifier/.test(hint(e)))
      || beforePassword.pop();
    const all = { username: username && [username], password: password && [password], code: boxes.length >= 4 ? boxes : code && [code] };
    // A code box only counts on its own page, so a sign-in form with a stray "code" box asks for no code.
    const kinds = wanted.length ? wanted : username || password ? ["username", "password"] : ["code"];
    const missing = wanted.filter((kind) => !all[kind]);
    if (missing.length) return { reason: `No ${missing.join(" or ")} box shows on this page.` };
    const fields = kinds.filter((kind) => all[kind]).map((kind) => ({ kind, boxes: all[kind] }));
    return fields.length ? fields : { reason: "No login box shows on this page. Click into the box and ask with --focused." };
  };
  const focused = () => {
    const box = document.activeElement;
    if (!inputs.includes(box)) return { reason: "No box is selected. Click into the box, then ask again." };
    if (wanted[0] === "password" && box.type !== "password") return { reason: "The selected box is not a password box." };
    return [{ kind: wanted[0], boxes: [box] }];
  };
  const characters = () => {
    // A password's characters go only into boxes that hide them; a memorable word's may go into boxes that show.
    const fit = wanted[0] === "password" ? inputs.filter((e) => e.type === "password") : inputs;
    const boxes = [fit.filter((e) => e.maxLength === 1), fit.filter((e) => e.type === "password")]
      .find((list) => list.length === positions.length);
    return boxes ? [{ kind: wanted[0], boxes }] : { reason: `No ${positions.length} boxes for the characters show on this page.` };
  };
  const picked = { find, focused, characters }[how]();
  if (picked.reason) return picked;
  globalThis.wired = picked.flatMap((field) => field.boxes);
  // The companion extension keeps only its latest find's boxes, for that find's one fill.
  if (key) globalThis.kept = { [key]: globalThis.wired };
  const fields = picked.map(({ kind, boxes }) => ({ kind, count: boxes.length, label: boxes.length > 1 ? "" : label(boxes[0]) }));
  return { origin: location.origin, fields };
};
// Types into the boxes found when the user was asked, only if the frame is still on that site and every box is still in
// the page; a password goes only into a box that still hides it.
export function TYPE(origin, texts, kinds, ...boxes) {
  if (location.origin !== origin) return { moved: location.origin };
  // The companion extension cannot pass boxes in, so its own world in the frame holds the ones the find picked.
  if (!boxes.length) boxes = globalThis.wired;
  if (!boxes.every((e) => e.isConnected)) return { reason: "The page changed after you were asked, so nothing was typed." };
  if (boxes.some((e, i) => kinds[i] === "password" && e.type !== "password")) {
    return { reason: "The password box no longer hides what is typed, so nothing was typed." };
  }
  const set = (e, text) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, text);
  for (const [i, e] of boxes.entries()) {
    e.focus();
    e.select();
    // The page's own focus handlers have run by now, and could have moved the cursor or revealed the box.
    const safe = e.isConnected && document.activeElement === e && (kinds[i] !== "password" || e.type === "password");
    if (!safe) {
      boxes.slice(0, i).forEach((typed) => set(typed, ""));
      return { reason: "The page moved the cursor while typing, so what was typed was taken out again." };
    }
    if (document.execCommand("insertText", false, texts[i])) continue;
    set(e, texts[i]);
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return {};
}
// Clicks the submit button of the box's form, as some sites ignore a synthetic Enter; false when there is none to click.
export function SUBMIT(origin, box = globalThis.wired.at(-1)) {
  if (location.origin !== origin) return true;
  const button = box.form && [...box.form.elements].find((e) => e.type === "submit" && !e.disabled);
  button?.click();
  return Boolean(button);
}
// Finds inputs still holding a typed secret, and empties them when asked.
export const HELD = (origin, secrets, empty) => {
  if (location.origin !== origin) return 0;
  const held = [...document.querySelectorAll("input")].filter((e) => secrets.includes(e.value));
  if (empty) held.forEach((e) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, ""));
  return held.length;
};
export const PROBE = () => ({ active: document.activeElement?.tagName === "INPUT", focus: document.hasFocus() });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const failed = (reason) => ({ status: "failed", reason, filled: [] });

// What each kind of ask fills: the boxes the page shows, a link to open, or the browser's own login dialog.
export const TARGETS = {
  link: async (browser, tab) => ({ frame: tab.id, origin: new URL(tab.url).origin, fields: [{ kind: "link" }] }),
  dialog: async (browser, tab, wanted, options) => ({
    frame: tab.id, origin: new URL(options.dialog).origin, fields: [{ kind: "username" }, { kind: "password" }],
  }),
  boxes: wire,
};

// Finds the boxes to fill now, in the tab or in the frame the agent clicked into, and keeps DevTools references to
// them, so the fill types into these boxes and nowhere else.
async function wire(browser, tab, wanted, options) {
  const frame = options.focused ? await focusedFrame(browser) : { id: tab.id };
  if (frame.reason) return frame;
  const contextId = await world(browser, frame);
  const how = options.characters ? "characters" : options.focused ? "focused" : "find";
  const positions = options.characters?.split(",").map(Number);
  const args = [how, wanted, positions].map((arg) => JSON.stringify(arg)).join(", ");
  const found = await run(browser, frame, contextId, `(${DETECT})(${args})`);
  if (!found) return { reason: "The page did not answer. Try again once it has loaded." };
  if (found.reason) return found;
  const total = found.fields.reduce((sum, field) => sum + field.count, 0);
  const nodes = await Promise.all(Array.from({ length: total }, (_, i) => backendNode(browser, frame, contextId, i)));
  let next = 0;
  const fields = found.fields.map(({ kind, count, label }) => {
    const boxes = nodes.slice(next, next + count);
    next += count;
    return { kind, label: (kind === "secret" && options.label) || label, boxes };
  });
  return { frame: frame.id, origin: found.origin, fields };
}

// The frame where the agent left the cursor: the tab itself, or a frame inside it, even one from another site.
async function focusedFrame(browser) {
  const all = await frames(browser);
  return pickFocused(await Promise.all(all.map(async (frame) => ({ ...frame, ...(await evaluate(browser, frame, PROBE)) }))));
}

// Of each frame's answer to PROBE, the one frame with a box holding the cursor.
export function pickFocused(probes) {
  const typing = probes.filter((probe) => probe.active);
  const picked = typing.length > 1 ? typing.filter((probe) => probe.focus) : typing;
  if (picked.length !== 1) return { reason: "No box is selected. Click into the box, then ask again with --focused." };
  return picked[0];
}

// Every frame in the tab, with the DevTools session that can reach it; frames from other sites live in their own.
async function frames(browser) {
  const sessions = [undefined];
  browser.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => targetInfo.type === "iframe" && sessions.push(sessionId));
  await browser.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const trees = await Promise.all(sessions.map(async (sessionId) => {
    const { frameTree } = await browser.send("Page.getFrameTree", {}, sessionId);
    return flatten(frameTree).map((frame) => [frame.id, { id: frame.id, sessionId }]);
  }));
  // A frame from another site shows up in its parent's tree too, but only its own session can run code in it.
  return [...new Map(trees.flat()).values()];
}

const flatten = (tree) => (tree ? [tree.frame, ...(tree.childFrames ?? []).flatMap(flatten)] : []);

// A fresh isolated world in the frame, where the page's own scripts cannot see or change what runs.
async function world(browser, frame) {
  const params = { frameId: frame.id, worldName: "agent-blindfold" };
  return (await browser.send("Page.createIsolatedWorld", params, frame.sessionId)).executionContextId;
}

async function run(browser, frame, contextId, expression) {
  if (!contextId) return undefined;
  const { result } = await browser.send("Runtime.evaluate", { expression, contextId, returnByValue: true }, frame.sessionId);
  return result?.value;
}

async function evaluate(browser, frame, source, ...args) {
  const contextId = await world(browser, frame);
  return run(browser, frame, contextId, `(${source})(${args.map((arg) => JSON.stringify(arg)).join(", ")})`);
}

// A reference to a wired box that stays valid across DevTools connections for as long as the box exists.
async function backendNode(browser, frame, contextId, index) {
  const { result } = await browser.send("Runtime.evaluate", { expression: `globalThis.wired[${index}]`, contextId }, frame.sessionId);
  const { node } = await browser.send("DOM.describeNode", { objectId: result.objectId }, frame.sessionId);
  return node.backendNodeId;
}

async function resolve(browser, frame, contextId, backendNodeId) {
  const { object } = await browser.send("DOM.resolveNode", { backendNodeId, executionContextId: contextId }, frame.sessionId);
  return object?.objectId;
}

// Types, opens or answers what the user entered, in the tab the ask was for.
export function fill(browser, config, values) {
  const mode = config.dialog ? answerDialog : values.link ? openLink : typeWired;
  return mode(browser, config, values);
}

// What goes into one box of a field: the whole answer, one digit of a split code, or one picked character.
export function piece(count, text, index, positions) {
  if (positions) return text[positions[index] - 1];
  return count > 1 ? text[index] : text;
}

async function typeWired(browser, config, values) {
  const frame = (await frames(browser)).find((candidate) => candidate.id === config.frame);
  if (!frame) return failed("The frame with the boxes is gone.");
  const here = await evaluate(browser, frame, "() => location.origin");
  if (here !== config.origin) return failed(`The page left ${config.origin} for ${here}.`);
  const plan = config.fields.flatMap((field) => field.boxes.map((node, i) => ({
    node, kind: field.kind, text: piece(field.boxes.length, values[field.kind], i, config.characters),
  })));
  if (plan.some((box) => box.text === undefined)) return failed("The answer is shorter than the boxes it has to fill.");
  const quiet = await requests(browser);
  const contextId = await world(browser, frame);
  const boxes = await Promise.all(plan.map((box) => resolve(browser, frame, contextId, box.node)));
  if (boxes.includes(undefined)) return failed("The page changed after you were asked, so nothing was typed.");
  const args = [config.origin, plan.map((box) => box.text), plan.map((box) => box.kind)].map((value) => ({ value }));
  const params = { functionDeclaration: String(TYPE), executionContextId: contextId, returnByValue: true };
  const { result } = await browser.send("Runtime.callFunctionOn", {
    ...params, arguments: [...args, ...boxes.map((objectId) => ({ objectId }))],
  }, frame.sessionId);
  const outcome = result?.value;
  if (!outcome) return failed("The page changed after you were asked, so nothing was typed.");
  if (outcome.moved) return failed(`The page left ${config.origin} for ${outcome.moved}.`);
  if (outcome.reason) return failed(outcome.reason);
  if (config.fields.length > 1) await quiet();
  await submit(browser, frame, config.origin, boxes.at(-1));
  const secrets = plan.filter((box) => box.kind !== "username").map((box) => box.text);
  const cleared = await settle((empty) => evaluate(browser, frame, HELD, config.origin, secrets, empty));
  return { status: "filled", filled: config.fields.map((field) => field.kind), ...(cleared && { cleared: true }) };
}

// Tracks the page's requests in flight; the function it returns waits until none has run for a moment.
async function requests(browser) {
  const open = new Set();
  browser.on("Network.requestWillBeSent", ({ requestId }) => open.add(requestId));
  browser.on("Network.loadingFinished", ({ requestId }) => open.delete(requestId));
  browser.on("Network.loadingFailed", ({ requestId }) => open.delete(requestId));
  await browser.send("Network.enable", {});
  return async () => {
    let calm = Date.now();
    for (const deadline = calm + PAUSE_MS; Date.now() < deadline && Date.now() - calm < QUIET_MS; await sleep(25)) {
      if (open.size) calm = Date.now();
    }
  };
}

// Page snapshots show what a password box holds, so nothing typed may still sit in the page when the agent looks; held
// runs HELD in the frame.
export async function settle(held) {
  for (const deadline = Date.now() + SETTLE_MS; Date.now() < deadline; await sleep(POLL_MS)) {
    if (!((await held(false)) ?? 1)) return false;
  }
  return Boolean(await held(true));
}

// Presses Enter only when the box's form has no button to click; a page that already moved on gets nothing.
async function submit(browser, frame, origin, box) {
  const args = [{ value: origin }, { objectId: box }];
  const params = { functionDeclaration: String(SUBMIT), objectId: box, arguments: args, returnByValue: true };
  const { result } = await browser.send("Runtime.callFunctionOn", params, frame.sessionId);
  if (result?.value !== false) return;
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

// Opens the link the site emailed in the agent's tab; it signs the tab in, wherever the link's tracking redirects go.
async function openLink(browser, config, values) {
  const url = URL.parse(values.link);
  if (!["http:", "https:"].includes(url?.protocol)) return failed("That is not a web link.");
  const { frameId, errorText } = await browser.send("Page.navigate", { url: url.href });
  if (!frameId || errorText) return failed(errorText ?? "The link did not open.");
  return { status: "filled", filled: ["link"] };
}

// Answers the browser's own login dialog (HTTP authentication), only for the origin the page named.
async function answerDialog(browser, config, values) {
  let asked = 0;
  const ignore = () => {};
  browser.on("Fetch.requestPaused", ({ requestId }) => browser.send("Fetch.continueRequest", { requestId }).catch(ignore));
  browser.on("Fetch.authRequired", ({ requestId, request, authChallenge }) => {
    const ours = authChallenge.source === "Server" && new URL(request.url).origin === config.origin;
    // A second challenge means the site turned the first answer down, so it is not sent again.
    const answer = ours && asked++ === 0;
    const credentials = { response: "ProvideCredentials", username: values.username, password: values.password };
    const authChallengeResponse = answer ? credentials : { response: "CancelAuth" };
    browser.send("Fetch.continueWithAuth", { requestId, authChallengeResponse }).catch(ignore);
  });
  await browser.send("Fetch.enable", { handleAuthRequests: true });
  await browser.send("Page.enable");
  const loaded = new Promise((resolve) => browser.on("Page.loadEventFired", resolve));
  await browser.send("Page.navigate", { url: config.dialog });
  await Promise.race([loaded, sleep(LOAD_MS)]);
  await browser.send("Fetch.disable");
  if (asked === 1) return { status: "filled", filled: ["username", "password"] };
  return failed(asked ? "The site turned that username and password down." : `${config.dialog} did not ask for a login.`);
}
