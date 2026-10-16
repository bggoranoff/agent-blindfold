// Finds and fills login boxes in a tab of this Chrome for signin.mjs, which reaches this worker through the host.
//
// It works through chrome.scripting rather than chrome.debugger: Chrome refuses a debugger, and drops one already
// attached, in any tab that holds another extension's frame, and password managers put one in most login pages.
import {
  DETECT, failed, HELD, LOAD_MS, PAUSE_MS, pickFocused, piece, PROBE, settle, sleep, SUBMIT, TARGETS, TYPE,
} from "./browser.mjs";

const HOST = "io.github.bggoranoff.agent_blindfold";
// What each find chose, kept here so a fill types only into boxes a find picked, and only once.
const asks = new Map();

// The listener is what starts this worker when Chrome starts.
chrome.runtime.onStartup.addListener(() => {});

const bare = (url) => url.split(/[?#]/)[0];

// The boxes a find picked stay in the frame, in this extension's own world, under the find's handle.
const KEEP = (handle) => {
  (globalThis.kept ??= {})[handle] = globalThis.wired;
};
const TAKE = (handle) => {
  globalThis.wired = globalThis.kept?.[handle];
  delete globalThis.kept?.[handle];
  return Boolean(globalThis.wired);
};
// Submits a form that has no button to click; a box outside any form gets the Enter key a person would press.
const ENTER = (origin) => {
  const box = globalThis.wired.at(-1);
  if (location.origin !== origin) return;
  if (box.form) return box.form.requestSubmit();
  for (const type of ["keydown", "keypress", "keyup"]) {
    box.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
  }
};

// Runs one of the page functions in a frame, in this extension's own world, which the page's scripts cannot reach;
// undefined when the frame is gone or refuses it.
async function run(tab, frame, func, ...args) {
  const results = await chrome.scripting.executeScript({ target: { tabId: tab, frameIds: [frame] }, func, args }).catch(() => []);
  return results[0]?.result;
}

// Finds the boxes to fill now, in the tab or in the frame the agent clicked into.
async function wire(tab, wanted, options) {
  const frame = options.focused ? await focusedFrame(tab.id) : { frameId: 0 };
  if (frame.reason) return frame;
  const how = options.characters ? "characters" : options.focused ? "focused" : "find";
  // chrome.scripting refuses an undefined argument.
  const positions = options.characters?.split(",").map(Number) ?? null;
  const found = await run(tab.id, frame.frameId, DETECT, how, wanted, positions);
  if (!found) return { reason: "The page did not answer. Try again once it has loaded." };
  if (found.reason) return found;
  const fields = found.fields.map(({ kind, count, label }) => ({ kind, count, label: (kind === "secret" && options.label) || label }));
  return { frame: frame.frameId, origin: found.origin, fields };
}

async function focusedFrame(tab) {
  const results = await chrome.scripting.executeScript({ target: { tabId: tab, allFrames: true }, func: PROBE }).catch(() => []);
  return pickFocused(results.map(({ frameId, result }) => ({ frameId, ...result })));
}

// Types into the boxes the find picked, only while their frame is still on that site, then submits.
async function typeKept(config, values, handle) {
  const { target: tab, frame, origin } = config;
  const here = await run(tab, frame, () => location.origin);
  if (!here) return failed("The frame with the boxes is gone.");
  if (here !== origin) return failed(`The page left ${origin} for ${here}.`);
  const plan = config.fields.flatMap((field) => Array.from({ length: field.count }, (_, i) => ({
    kind: field.kind, text: piece(field.count, values[field.kind], i, config.characters),
  })));
  if (plan.some((box) => box.text === undefined)) return failed("The answer is shorter than the boxes it has to fill.");
  if (!(await run(tab, frame, TAKE, handle))) return failed("The page changed after you were asked, so nothing was typed.");
  const outcome = await run(tab, frame, TYPE, origin, plan.map((box) => box.text), plan.map((box) => box.kind));
  if (!outcome) return failed("The page changed after you were asked, so nothing was typed.");
  if (outcome.moved) return failed(`The page left ${origin} for ${outcome.moved}.`);
  if (outcome.reason) return failed(outcome.reason);
  // This side cannot watch the page's requests, so the submit waits a person's pause for the page to check the boxes.
  if (config.fields.length > 1) await sleep(PAUSE_MS);
  if ((await run(tab, frame, SUBMIT, origin)) === false) await run(tab, frame, ENTER, origin);
  const secrets = plan.filter((box) => box.kind !== "username").map((box) => box.text);
  const cleared = await settle((empty) => run(tab, frame, HELD, origin, secrets, empty));
  return { status: "filled", filled: config.fields.map((field) => field.kind), ...(cleared && { cleared: true }) };
}

// Opens the link the site emailed in the agent's tab.
async function openLink(config, values) {
  const url = URL.parse(values.link);
  if (!["http:", "https:"].includes(url?.protocol)) return failed("That is not a web link.");
  await chrome.tabs.update(config.target, { url: url.href });
  return { status: "filled", filled: ["link"] };
}

// Answers the browser's own login dialog (HTTP authentication) while the tab loads the page, for its origin only.
async function answerDialog(config, values) {
  let asked = 0;
  const reply = (details, callback) => {
    const ours = !details.isProxy && new URL(details.url).origin === config.origin;
    // A second challenge means the site turned the first answer down, so it is not sent again.
    const credentials = ours && asked++ === 0 && { username: values.username, password: values.password };
    callback(credentials ? { authCredentials: credentials } : { cancel: true });
  };
  let started = false;
  const loaded = new Promise((resolve) => {
    const watch = (tab, change) => {
      if (tab !== config.target) return;
      started ||= change.status === "loading";
      if (started && change.status === "complete") resolve(chrome.tabs.onUpdated.removeListener(watch));
    };
    chrome.tabs.onUpdated.addListener(watch);
  });
  chrome.webRequest.onAuthRequired.addListener(reply, { urls: ["<all_urls>"], tabId: config.target }, ["asyncBlocking"]);
  await chrome.tabs.update(config.target, { url: config.dialog });
  await Promise.race([loaded, sleep(LOAD_MS)]);
  chrome.webRequest.onAuthRequired.removeListener(reply);
  if (asked === 1) return { status: "filled", filled: ["username", "password"] };
  return failed(asked ? "The site turned that username and password down." : `${config.dialog} did not ask for a login.`);
}

// The only steps anything that reaches the host can ask for: no page content, scripts or cookies ever come back.
const STEPS = {
  tab: async ({ text }) => {
    const matches = (await chrome.tabs.query({})).filter((tab) => tab.url?.includes(text));
    return matches.length === 1 ? { id: matches[0].id, url: bare(matches[0].url) } : { count: matches.length };
  },
  find: async ({ tab, kind, wanted, options }) => {
    const page = await chrome.tabs.get(tab).catch(() => undefined);
    if (!page) return { reason: "The browser tab is gone." };
    const found = kind === "boxes" ? await wire(page, wanted, options) : await TARGETS[kind](undefined, page, wanted, options);
    if (found.reason) return found;
    const handle = crypto.randomUUID();
    if (kind === "boxes") await run(tab, found.frame, KEEP, handle);
    const characters = options.characters?.split(",").map(Number);
    asks.set(handle, { ...found, target: tab, dialog: options.dialog, characters });
    const fields = found.fields.map(({ kind: field, label }) => ({ kind: field, label }));
    return { handle, frame: found.frame, origin: found.origin, fields };
  },
  fill: async ({ handle, values }) => {
    const config = asks.get(handle);
    asks.delete(handle);
    if (!config) return failed("The page changed after you were asked, so nothing was typed.");
    const mode = config.dialog ? answerDialog : values.link ? openLink : typeKept;
    return mode(config, values, handle);
  },
};

async function answer({ client, step, ...request }, from) {
  const run = STEPS[step] ?? (async () => failed(`agent-blindfold has no step ${step}.`));
  const result = await run(request).catch((error) => failed(error.message));
  from.postMessage({ client, ...result });
}

// The open port keeps this worker, and the host Chrome started for it, alive while Chrome runs.
let port;
function connect() {
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(answer);
  port.onDisconnect.addListener(() => (port = undefined));
}

// A host that exited or failed to start is retried each minute; the alarm also wakes this worker if Chrome stopped it.
chrome.alarms.create("host", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => port || connect());
connect();
