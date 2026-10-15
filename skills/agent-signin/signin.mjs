#!/usr/bin/env node
// Hand a login from the user to the agent's browser on a one-time page, without the agent ever seeing it.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = `Usage:
  signin.mjs ask <fields> [--tab <text>] [--focused] [--characters <n,n,...>] [--label <text>] [--dialog <url>]
                 [--wait] [--cdp <url>] [--public <https url> | --tunnel] [--port <n>] [--minutes <n>]
  signin.mjs wait <id>

<fields> is a comma list of username, password, code, secret and link.`;
const SELF = fileURLToPath(import.meta.url);
const FIELDS = ["username", "password", "code", "secret", "link"];
// Each rule is a combination of fields and options that cannot work, and what to do instead.
const RULES = [
  [(fields) => fields.includes("link") && fields.length > 1, "Ask for link on its own."],
  [(fields, o) => (o.focused || o.characters) && fields.length > 1, "--focused and --characters take one field."],
  [(fields, o) => o.characters && !/^\d+(,\d+)*$/.test(o.characters), "--characters takes positions, such as 2,5,7."],
  [(fields, o) => o.characters && !["password", "secret"].includes(fields[0]), "--characters works with password or secret."],
  [(fields, o) => fields.includes("secret") && !o.focused && !o.characters, "Click into the field, then ask for secret with --focused."],
  [(fields, o) => o.dialog && fields.join() !== "username,password", "--dialog takes username,password."],
];
const STATE = join(tmpdir(), "agent-signin");
const PUBLIC_PORT = 8769;
const POLL_MS = 100;
const NEXT_FIELD_MS = 15000;
const SETTLE_MS = 10000;
// Sites check a field when it loses focus and hold back a submit until that check is done, so a submit waits for the
// page's requests to go quiet, for at most as long as a person's pause.
const PAUSE_MS = 1000;
const QUIET_MS = 150;
const OPENERS = { darwin: "open", win32: "explorer" };
const CHROMIUM = /chrome|chromium|edge|brave|vivaldi/i;
const WINDOW = ["--window-size=440,640"];

// Shared by the functions below. Each runs in the frame, where the origin check and the typing share one evaluation,
// so a navigation cannot slip between them.
const IN_PAGE = `
  if (location.origin !== origin) return { moved: location.origin };
  // Password managers' and sites' helper fields render but are aria-hidden; no person can see or reach them.
  const shown = (e) => e.getClientRects().length && !e.disabled && !e.readOnly && !e.closest("[aria-hidden=true]")
    && getComputedStyle(e).visibility !== "hidden" && !["hidden", "submit", "button", "checkbox", "radio"].includes(e.type);
  const inputs = [...document.querySelectorAll("input")].filter(shown);
  const type = (e, text) => {
    e.focus();
    e.select();
    if (document.execCommand("insertText", false, text)) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, text);
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  };`;
// Finds the fields the page shows and types what it can.
const FIND = `(origin, values) => {${IN_PAGE}
  const hint = (e) => [e.name, e.id, e.placeholder, e.getAttribute("aria-label"), e.autocomplete].join(" ").toLowerCase();
  const password = inputs.find((e) => e.type === "password");
  const boxes = inputs.filter((e) => e.maxLength === 1);
  const code = inputs.find((e) => e.autocomplete === "one-time-code")
    || inputs.find((e) => e !== password && /otp|code|pin|verif|2fa|mfa|token/.test(hint(e)));
  const beforePassword = inputs.slice(0, Math.max(inputs.indexOf(password), 0))
    .filter((e) => ["text", "email", "tel"].includes(e.type));
  const username = inputs.find((e) => /username|email/.test(e.autocomplete)) || inputs.find((e) => e.type === "email")
    || inputs.find((e) => e !== code && e !== password && /user|email|login|account|identifier/.test(hint(e)))
    || beforePassword.pop();
  const typed = [];
  const put = (kind, e) => {
    if (!e || !values[kind]) return;
    type(e, values[kind]);
    typed.push(kind);
  };
  put("username", username);
  put("password", password);
  const split = values.code && boxes.length >= 4 && boxes.length === values.code.length;
  if (!split) put("code", code);
  if (split) {
    boxes.forEach((e, i) => type(e, values.code[i]));
    typed.push("code");
  }
  return { typed };
}`;
// Types into the field the agent clicked into; a password goes only into a password field.
const FOCUSED = `(origin, values) => {${IN_PAGE}
  const [[kind, text]] = Object.entries(values);
  const field = document.activeElement;
  if (!inputs.includes(field)) return { reason: "The field the agent picked is no longer selected." };
  if (kind === "password" && field.type !== "password") return { reason: "The field the agent picked is not a password field." };
  type(field, text);
  return { typed: [kind] };
}`;
// Types only the characters a site asks for, such as the 2nd, 5th and 7th, one per box.
const CHARACTERS = `(origin, values, positions) => {${IN_PAGE}
  const [[kind, text]] = Object.entries(values);
  const picked = positions.map((n) => text[n - 1]);
  if (picked.includes(undefined)) return { reason: "The answer is shorter than the characters asked for." };
  const boxes = [inputs.filter((e) => e.maxLength === 1), inputs.filter((e) => e.type === "password")]
    .find((list) => list.length === picked.length);
  if (!boxes) return { reason: \`No \${picked.length} boxes for the characters showed.\` };
  boxes.forEach((e, i) => type(e, picked[i]));
  return { typed: [kind] };
}`;
// Clicks the submit button of the form holding the value, as some sites ignore a synthetic Enter.
const SUBMIT = `(origin, value) => {
  if (location.origin !== origin) return true;
  const field = [document.activeElement, ...document.querySelectorAll("input")].find((e) => e?.value === value);
  const button = field?.form && [...field.form.elements].find((e) => e.type === "submit" && !e.disabled);
  button?.click();
  return Boolean(button);
}`;
// Finds inputs still holding a typed secret, and empties them when asked.
const HELD = `(origin, secrets, empty) => {
  if (location.origin !== origin) return 0;
  const held = [...document.querySelectorAll("input")].filter((e) => secrets.includes(e.value));
  if (empty) held.forEach((e) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, ""));
  return held.length;
}`;
const PROBE = `() => ({ origin: location.origin, active: document.activeElement?.tagName === "INPUT", focus: document.hasFocus() })`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

const failed = (reason, filled = []) => ({ status: "failed", reason, filled });

function readState(id) {
  const path = join(STATE, `${id}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function writeState(id, state) {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const path = join(STATE, `${id}.json`);
  writeFileSync(`${path}.partial`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${path}.partial`, path);
}

async function pages(cdp) {
  const response = await fetch(`${cdp}/json/list`).catch(() => {
    throw new Error(`No browser DevTools endpoint at ${cdp}.`);
  });
  return (await response.json()).filter((target) => target.type === "page");
}

async function pickTab(cdp, text = "") {
  const all = await pages(cdp);
  const matches = all.filter((tab) => tab.url.includes(text));
  if (matches.length !== 1) {
    fail(`${matches.length} tabs match ${JSON.stringify(text)}. Pass --tab with part of one URL:\n`
      + all.map((tab) => tab.url).join("\n"));
  }
  return matches[0];
}

async function ask(fields, options) {
  const wanted = fields.split(",");
  if (!wanted.every((field) => FIELDS.includes(field))) fail(USAGE);
  const broken = RULES.find(([breaks]) => breaks(wanted, options));
  if (broken) fail(broken[1]);
  if (options.public && !options.public.startsWith("https://")) fail("--public must be an https:// URL.");
  const tab = await pickTab(options.cdp, options.tab);
  const top = new URL(options.dialog ?? tab.url).origin;
  if (!/^https?:/.test(top)) fail(`The tab is on ${tab.url}, not a website.`);
  const frame = options.focused ? await focusedFrame(tab) : { id: tab.id, origin: top };
  const id = randomBytes(6).toString("base64url");
  const config = {
    id, origin: frame.origin, top, fields: wanted, frame: frame.id, focused: options.focused, label: options.label,
    characters: options.characters?.split(",").map(Number), dialog: options.dialog, cdp: options.cdp, target: tab.id,
    token: randomBytes(32).toString("base64url"), public: options.public, tunnel: options.tunnel,
    minutes: Number(options.minutes), port: Number(options.port ?? (options.public ? PUBLIC_PORT : 0)),
  };
  // The token goes over stdin rather than argv, where `ps` would show it.
  const server = spawn(process.execPath, [SELF, "serve"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
  server.stdin.end(JSON.stringify(config));
  server.unref();
  const state = await settled(id, (s) => s.url || s.status !== "waiting", Date.now() + 30000);
  console.log(JSON.stringify({ id, ...state }));
  if (state.status !== "waiting") process.exit(1);
  if (!options.public && !options.tunnel) openPage(state.url);
  if (options.wait) await wait(id);
}

// The frame where the agent left the cursor: the tab itself, or a frame inside it, even one from another site.
async function focusedFrame(tab) {
  const browser = await connect(tab.webSocketDebuggerUrl);
  const all = await frames(browser);
  const probes = await Promise.all(all.map(async (frame) => ({ ...frame, ...(await evaluate(browser, frame, PROBE)) })));
  browser.close();
  const typing = probes.filter((probe) => probe.active);
  const picked = typing.length > 1 ? typing.filter((probe) => probe.focus) : typing;
  if (picked.length !== 1) fail("No field is selected. Click into the field, then ask again with --focused.");
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

// Runs a function in a fresh isolated world of the frame, out of reach of the page's own scripts.
async function evaluate(browser, frame, source, ...args) {
  const world = await browser.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "agent-signin" }, frame.sessionId);
  if (!world.executionContextId) return undefined;
  const expression = `(${source})(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;
  const params = { expression, contextId: world.executionContextId, returnByValue: true };
  const { result } = await browser.send("Runtime.evaluate", params, frame.sessionId);
  return result?.value;
}

// A Chromium default browser shows the page as a small app window, which the page can close itself.
function openPage(url) {
  const plain = [process.env.BROWSER ?? OPENERS[process.platform] ?? "xdg-open", url];
  const app = process.env.BROWSER ? null : DEFAULT_CHROMIUM[process.platform]?.(url);
  const launch = ([command, ...args], fallback) => spawn(command, args, { detached: true, stdio: "ignore" })
    .on("error", () => fallback && launch(fallback)).unref();
  launch(app ?? plain, app && plain);
}

const DEFAULT_CHROMIUM = {
  darwin: (url) => {
    const handlers = run("defaults", ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"]);
    const bundle = handlers.match(/LSHandlerRoleAll = "?([\w.-]+)"?;\s*LSHandlerURLScheme = https;/)?.[1];
    return CHROMIUM.test(bundle) && ["open", "-nb", bundle, "--args", `--app=${url}`, ...WINDOW];
  },
  linux: (url) => {
    const name = run("xdg-settings", ["get", "default-web-browser"]).trim().replace(/\.desktop$/, "");
    return CHROMIUM.test(name) && [name, `--app=${url}`, ...WINDOW];
  },
};

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

async function settled(id, done, deadline) {
  for (;;) {
    const state = readState(id);
    if (state && done(state)) return state;
    if (Date.now() > (state?.expires ?? deadline) + 5000) return { ...state, status: "expired" };
    await sleep(POLL_MS);
  }
}

async function wait(id) {
  const state = await settled(id, (s) => s.status !== "waiting", Date.now() + 30000);
  rmSync(join(STATE, `${id}.json`), { force: true });
  console.log(JSON.stringify(state));
  process.exit(state.status === "filled" ? 0 : 1);
}

async function serve() {
  const config = JSON.parse(readFileSync(0, "utf8"));
  const save = (state) => writeState(config.id, { origin: config.origin, fields: config.fields, ...state });
  let tunnel, over;
  const finish = (state) => {
    if (over) return;
    over = true;
    save(state);
    tunnel?.kill();
    // A beat for the answer to reach the page, which may already have been closed mid-fill.
    setTimeout(() => process.exit(0), 500);
  };
  try {
    const server = createServer(handler(config, finish));
    await new Promise((resolve, reject) => server.once("error", reject).listen(config.port, "127.0.0.1", resolve));
    const local = `http://127.0.0.1:${server.address().port}`;
    if (config.tunnel) [tunnel, config.public] = await openTunnel(local);
    const expires = Date.now() + config.minutes * 60000;
    save({ status: "waiting", url: `${(config.public ?? local).replace(/\/$/, "")}/${config.token}`, expires });
    setTimeout(() => finish({ status: "expired" }), expires - Date.now());
  } catch (error) {
    finish({ status: "failed", reason: error.message });
  }
}

async function openTunnel(local) {
  const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", local], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  const url = await new Promise((resolve, reject) => {
    tunnel.on("error", () => reject(new Error("--tunnel needs cloudflared on the PATH.")));
    tunnel.on("exit", () => reject(new Error("cloudflared exited before it had a URL.")));
    tunnel.stderr.on("data", (chunk) => {
      log += chunk;
      const found = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (found) resolve(found[0]);
    });
  });
  await published(new URL(url).hostname);
  return [tunnel, url];
}

// The record shows up seconds after cloudflared prints it, and a resolver that looks too early caches the miss for
// 60 s, so this asks Cloudflare's authoritative server, which caches nothing, before anyone else looks.
async function published(host) {
  const [server] = await dns.resolveNs("trycloudflare.com");
  const resolver = new dns.Resolver();
  resolver.setServers([(await dns.lookup(server, { family: 4 })).address]);
  for (const deadline = Date.now() + 30000; Date.now() < deadline; await sleep(1000)) {
    if (await resolver.resolve4(host).catch(() => null)) return;
  }
}

function handler(config, finish) {
  let busy = false;
  const reply = (response, status, text, result) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ message: text, close: Boolean(result) }));
    if (result) finish(result);
  };
  return async (request, response) => {
    // The token may sit under any prefix a reverse proxy adds.
    const [, rest] = new URL(request.url, "http://localhost").pathname.split(`/${config.token}`);
    const route = `${request.method} ${rest}`;
    if (route === "GET ") return page(response, config);
    if (route === "POST /cancel" && !busy) return reply(response, 200, "Cancelled. Nothing was typed.", { status: "cancelled" });
    if (route !== "POST " || busy) return reply(response, 404, "This link is no longer open.");
    const sent = await json(request).catch(() => ({}));
    const values = Object.fromEntries(config.fields.filter((f) => sent[f]).map((f) => [f, String(sent[f])]));
    if (!Object.keys(values).length) return reply(response, 400, "Fill in the fields first.");
    // Checked again after the await and set before the next one, so two POSTs can never both fill.
    if (busy) return reply(response, 404, "This link is no longer open.");
    busy = true;
    const result = await fill(config, values).catch(() => failed("The browser stopped answering."));
    reply(response, 200, message(config, result), result);
  };
}

function message(config, result) {
  if (result.status !== "filled") return `Nothing more was typed: ${result.reason}`;
  if (result.filled.includes("link")) return "Opened the link in your agent's browser.";
  const names = result.filled.map((field) => (field === "secret" ? "answer" : field));
  return `Typed your ${names.join(" and ")} into ${new URL(config.origin).host}.`;
}

async function fill(config, values) {
  const tab = (await pages(config.cdp)).find((target) => target.id === config.target);
  if (!tab) return failed("The browser tab is gone.");
  const browser = await connect(tab.webSocketDebuggerUrl);
  const mode = config.dialog ? answerDialog : values.link ? openLink : typeFields;
  return mode(browser, config, values).finally(browser.close);
}

async function typeFields(browser, config, values) {
  const frame = (await frames(browser)).find((candidate) => candidate.id === config.frame);
  if (!frame) return failed("The frame with the field is gone.");
  const how = config.characters ? CHARACTERS : config.focused ? FOCUSED : FIND;
  const quiet = await requests(browser);
  const lastOf = (kind) => (config.characters ? values[kind][config.characters.at(-1) - 1] : values[kind]);
  const filled = [];
  let left = Object.keys(values);
  let deadline = Date.now() + NEXT_FIELD_MS;
  // Type what the frame shows, submit, and wait for the next step to show the rest (identifier-first logins).
  while (left.length && Date.now() < deadline) {
    const only = Object.fromEntries(left.map((field) => [field, values[field]]));
    const outcome = (await evaluate(browser, frame, how, config.origin, only, config.characters)) ?? { typed: [] };
    if (outcome.moved) return failed(`The page left ${config.origin} for ${outcome.moved}.`, filled);
    if (outcome.reason) return failed(outcome.reason, filled);
    if (!outcome.typed.length) {
      await sleep(2 * POLL_MS);
      continue;
    }
    filled.push(...outcome.typed);
    left = left.filter((field) => !outcome.typed.includes(field));
    if (outcome.typed.length > 1) await quiet();
    await submit(browser, frame, config.origin, lastOf(outcome.typed.at(-1)));
    deadline = Date.now() + NEXT_FIELD_MS;
  }
  if (!filled.length) return failed(`No ${left.join(" or ")} field showed on ${config.origin}.`);
  const secrets = config.characters?.map((n) => values[filled[0]][n - 1]) ?? [values.password, values.code, values.secret];
  const cleared = await settle(browser, frame, config.origin, secrets.filter(Boolean));
  return { status: "filled", filled, unused: left, ...(cleared && { cleared: true }) };
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

// Page snapshots show what a password field holds, so nothing typed may still sit in the page when the agent looks.
async function settle(browser, frame, origin, secrets) {
  for (const deadline = Date.now() + SETTLE_MS; Date.now() < deadline; await sleep(POLL_MS)) {
    if (!((await evaluate(browser, frame, HELD, origin, secrets, false)) ?? 1)) return false;
  }
  return Boolean(await evaluate(browser, frame, HELD, origin, secrets, true));
}

async function submit(browser, frame, origin, value) {
  if (await evaluate(browser, frame, SUBMIT, origin, value)) return;
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

// Opens the link the site emailed in the agent's tab; it signs the tab in, wherever the link's tracking redirects go.
async function openLink(browser, config, values) {
  const url = URL.parse(values.link);
  if (!["http:", "https:"].includes(url?.protocol)) return failed("That is not a web link.");
  await browser.send("Page.navigate", { url: url.href });
  return { status: "filled", filled: ["link"], unused: [] };
}

// Answers the browser's own login dialog (HTTP authentication), only for the origin the page named.
async function answerDialog(browser, config, values) {
  let asked = 0;
  browser.on("Fetch.requestPaused", ({ requestId }) => browser.send("Fetch.continueRequest", { requestId }));
  browser.on("Fetch.authRequired", ({ requestId, request, authChallenge }) => {
    const ours = authChallenge.source === "Server" && new URL(request.url).origin === config.origin;
    // A second challenge means the site turned the first answer down, so it is not sent again.
    const answer = ours && asked++ === 0;
    const credentials = { response: "ProvideCredentials", username: values.username, password: values.password };
    browser.send("Fetch.continueWithAuth", { requestId, authChallengeResponse: answer ? credentials : { response: "CancelAuth" } });
  });
  await browser.send("Fetch.enable", { handleAuthRequests: true });
  await browser.send("Page.enable");
  const loaded = new Promise((resolve) => browser.on("Page.loadEventFired", resolve));
  await browser.send("Page.navigate", { url: config.dialog });
  await Promise.race([loaded, sleep(NEXT_FIELD_MS)]);
  await browser.send("Fetch.disable");
  if (asked === 1) return { status: "filled", filled: ["username", "password"], unused: [] };
  return failed(asked ? "The site turned that username and password down." : `${config.dialog} did not ask for a login.`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const pending = new Map();
  const listeners = {};
  let next = 0;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method) return listeners[message.method]?.(message.params);
    pending.get(message.id)?.(message.result ?? {});
    pending.delete(message.id);
  };
  const send = (method, params, sessionId) => new Promise((resolve) => {
    pending.set(++next, resolve);
    socket.send(JSON.stringify({ id: next, method, params, sessionId }));
  });
  const on = (method, listener) => {
    listeners[method] = listener;
  };
  return { send, on, close: () => socket.close() };
}

function page(response, config) {
  const nonce = randomBytes(16).toString("base64");
  const host = new URL(config.origin).host;
  const top = new URL(config.top).host;
  const hint = config.characters && `<p class="sub">Only characters ${config.characters.join(", ")} are typed.</p>`;
  const parts = {
    nonce,
    host,
    sub: config.fields.includes("link") ? "Your agent's browser will open it, signing in to" : "Your agent's browser will type this into",
    inside: top === host ? "" : `<p class="sub">inside ${top}</p>`,
    inputs: config.fields.map((field) => INPUTS[field](config)).join("") + (hint || ""),
    button: config.fields.includes("link") ? "Open link" : "Sign in",
  };
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; `
      + "connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(PAGE.replace(/\{(\w+)\}/g, (match, key) => parts[key] ?? match));
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const EYE = `<button type="button" class="eye" aria-label="Show" aria-pressed="false"><svg viewBox="0 0 24 24" width="22"
  height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path class="slash" d="M4 4l16 16"/>
  </svg></button>`;

const hidden = (name, label, autocomplete) => `<label for="${name}">${label}</label><div class="secret"><input id="${name}"
  name="${name}" type="password" autocomplete="${autocomplete}" required>${EYE}</div>`;

const INPUTS = {
  username: () => `<label for="username">Email or username</label><input id="username" name="username" type="text"
    autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>`,
  password: () => hidden("password", "Password", "current-password"),
  code: () => `<label for="code">Verification code</label><input id="code" name="code" type="text" inputmode="numeric"
    autocomplete="one-time-code" required>`,
  secret: (config) => hidden("secret", escapeHtml(config.label ?? "Answer"), "off"),
  link: () => `<label for="link">Sign-in link from your email</label><input id="link" name="link" type="url"
    autocapitalize="none" autocorrect="off" spellcheck="false" required>`,
};

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign in</title>
<style>
:root{--bg:#faf9f5;--fg:#1f1e1d;--muted:#6b6a66;--card:#fff;--line:#e3e1da}
@media (prefers-color-scheme:dark){:root{--bg:#1f1e1d;--fg:#f0eee6;--muted:#a3a19a;--card:#2a2927;--line:#3d3c39}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:380px;margin:0 auto;padding:40px 16px}h1{font-size:24px;margin:0;text-align:center}
p{text-align:center;margin:4px 0}.sub{color:var(--muted)}.host{font-weight:700;font-size:20px;overflow-wrap:anywhere}
form{margin-top:16px}label{display:block;font-size:14px;color:var(--muted);margin:16px 0 6px}
input{width:100%;font:inherit;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg)}
button{display:block;width:100%;font:inherit;font-weight:600;padding:13px;margin-top:20px;border:0;border-radius:10px;background:var(--fg);color:var(--bg)}
button.quiet{background:none;color:var(--muted);margin-top:8px}[hidden]{display:none}
.secret{position:relative}.secret input{padding-right:52px}
.eye{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:flex;width:44px;margin:0;padding:10px;background:none;color:var(--muted)}
.eye:not([aria-pressed=true]) .slash{display:none}
</style>
<main><h1>Sign in</h1><p class="sub">{sub}</p><p class="host">{host}</p>{inside}
<form>{inputs}<button>{button}</button></form><button class="quiet" id="cancel">Cancel</button><p id="status" role="status"></p></main>
<script nonce="{nonce}">
const form = document.forms[0], cancel = document.getElementById("cancel"), status = document.getElementById("status");
async function send(path, body) {
  form.hidden = cancel.hidden = true;
  status.textContent = "Signing in…";
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => null);
  const answer = response?.ok ? await response.json() : { message: "This link is no longer open." };
  status.textContent = answer.message;
  if (answer.close) setTimeout(() => window.close(), 1200);
}
form.onsubmit = (event) => {
  event.preventDefault();
  const body = JSON.stringify(Object.fromEntries(new FormData(form)));
  form.reset();
  send(location.pathname, body);
};
cancel.onclick = () => send(location.pathname + "/cancel", "{}");
for (const eye of document.querySelectorAll(".eye")) eye.onclick = () => {
  const input = eye.previousElementSibling, show = input.type === "password";
  input.type = show ? "text" : "password";
  eye.setAttribute("aria-pressed", show);
  eye.setAttribute("aria-label", show ? "Hide" : "Show");
};
</script>`;

const { values: options, positionals: [command, argument] } = parseArgs({
  allowPositionals: true,
  options: {
    tab: { type: "string" },
    focused: { type: "boolean" },
    characters: { type: "string" },
    label: { type: "string" },
    dialog: { type: "string" },
    wait: { type: "boolean" },
    cdp: { type: "string", default: process.env.CDP_URL ?? "http://127.0.0.1:9222" },
    public: { type: "string", default: process.env.SIGNIN_PUBLIC_URL },
    tunnel: { type: "boolean" },
    port: { type: "string" },
    minutes: { type: "string", default: "10" },
  },
});
const COMMANDS = { ask, wait, serve };
if (!COMMANDS[command] || (command !== "serve" && !argument)) fail(USAGE);
await COMMANDS[command](argument, options).catch((error) => fail(error.message));
