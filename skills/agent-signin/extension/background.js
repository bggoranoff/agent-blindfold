// Finds and fills login boxes in a tab of this Chrome for signin.mjs, which reaches this worker through the host.
import { failed, fill, TARGETS } from "./browser.mjs";

const HOST = "io.github.bggoranoff.agent_signin";
// What each find chose, kept here so a fill types only into boxes a find picked, and only once.
const asks = new Map();

// The listener is what starts this worker when Chrome starts.
chrome.runtime.onStartup.addListener(() => {});

const bare = (url) => url.split(/[?#]/)[0];
const pages = async () => (await chrome.debugger.getTargets()).filter((target) => target.type === "page");

// A DevTools connection to one tab, shaped like the one browser.mjs gets over a DevTools port.
async function attach(targetId) {
  const listeners = {};
  const forward = (source, method, params) => source.targetId === targetId && listeners[method]?.(params);
  await chrome.debugger.attach({ targetId }, "1.3");
  chrome.debugger.onEvent.addListener(forward);
  return {
    // A command on a page that just navigated answers empty, as over a DevTools port, which browser.mjs reads as a change.
    send: (method, params = {}, sessionId) => chrome.debugger.sendCommand({ targetId, sessionId }, method, params).catch(() => ({})),
    on: (method, listener) => (listeners[method] = listener),
    close: () => {
      chrome.debugger.onEvent.removeListener(forward);
      return chrome.debugger.detach({ targetId }).catch(() => {});
    },
  };
}

// The only steps anything that reaches the host can ask for: no page content, scripts or cookies ever come back.
const STEPS = {
  tab: async ({ text }) => {
    const matches = (await pages()).filter((tab) => tab.url.includes(text));
    return matches.length === 1 ? { id: matches[0].id, url: bare(matches[0].url) } : { count: matches.length };
  },
  find: async ({ tab, kind, wanted, options }) => {
    const page = (await pages()).find((candidate) => candidate.id === tab);
    if (!page) return { reason: "The browser tab is gone." };
    const browser = await attach(tab);
    const found = await TARGETS[kind](browser, page, wanted, options).finally(browser.close);
    if (found.reason) return found;
    const handle = crypto.randomUUID();
    const characters = options.characters?.split(",").map(Number);
    asks.set(handle, { ...found, target: tab, dialog: options.dialog, characters });
    const fields = found.fields.map(({ kind: field, label }) => ({ kind: field, label }));
    return { handle, frame: found.frame, origin: found.origin, fields };
  },
  fill: async ({ handle, values }) => {
    const config = asks.get(handle);
    asks.delete(handle);
    if (!config) return failed("The page changed after you were asked, so nothing was typed.");
    const browser = await attach(config.target);
    return fill(browser, config, values).finally(browser.close);
  },
};

async function answer({ client, step, ...request }, from) {
  const run = STEPS[step] ?? (async () => failed(`agent-signin has no step ${step}.`));
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
