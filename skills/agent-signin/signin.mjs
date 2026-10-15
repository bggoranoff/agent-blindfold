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
  signin.mjs ask [<fields>] [--tab <text>] [--focused] [--characters <n,n,...>] [--label <text>] [--wait]
                 [--cdp <url>] [--public <https url> | --tunnel] [--port <n>] [--minutes <n>]
  signin.mjs ask link [--tab <text>] [--wait] ...
  signin.mjs ask --dialog <url> [--tab <text>] [--wait] ...
  signin.mjs wait <id>

Without <fields>, ask finds the login boxes the page shows now. <fields> is a comma list of username, password,
code and secret, to ask for only those.`;
const SELF = fileURLToPath(import.meta.url);
const FIELDS = ["username", "password", "code", "secret", "link"];
// Each rule is a combination of fields and options that cannot work, and what to do instead.
const RULES = [
  [(fields) => fields.includes("link") && fields.length > 1, "Ask for link on its own."],
  [(fields, o) => (o.focused || o.characters) && fields.length !== 1, "--focused and --characters take one field, such as ask password --focused."],
  [(fields, o) => o.characters && !/^\d+(,\d+)*$/.test(o.characters), "--characters takes positions, such as 2,5,7."],
  [(fields, o) => o.characters && !["password", "secret"].includes(fields[0]), "--characters works with password or secret."],
  [(fields, o) => fields.includes("secret") && !o.focused && !o.characters, "Click into the box, then ask for secret with --focused."],
  [(fields, o) => o.dialog && fields.length && fields.join() !== "username,password", "--dialog asks for the username and password itself."],
];
const LABELS = { username: "Email or username", password: "Password", code: "Verification code", secret: "Answer", link: "Sign-in link from your email" };
const STATE = join(tmpdir(), "agent-signin");
const PUBLIC_PORT = 8769;
const POLL_MS = 100;
const SETTLE_MS = 10000;
const LOAD_MS = 15000;
// Sites check a box when it loses focus and hold back a submit until that check is done, so a submit waits for the
// page's requests to go quiet, for at most as long as a person's pause.
const PAUSE_MS = 1000;
const QUIET_MS = 150;
const OPENERS = { darwin: "open", win32: "explorer" };
const CHROMIUM = /chrome|chromium|edge|brave|vivaldi/i;
const WINDOW = ["--window-size=440,640"];

// Finds the boxes to ask for, when the user is asked, and keeps them in globalThis.wired for DevTools references.
const DETECT = `(how, wanted, positions) => {
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
    if (missing.length) return { reason: \`No \${missing.join(" or ")} box shows on this page.\` };
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
    const boxes = [inputs.filter((e) => e.maxLength === 1), inputs.filter((e) => e.type === "password")]
      .find((list) => list.length === positions.length);
    return boxes ? [{ kind: wanted[0], boxes }] : { reason: \`No \${positions.length} boxes for the characters show on this page.\` };
  };
  const picked = { find, focused, characters }[how]();
  if (picked.reason) return picked;
  globalThis.wired = picked.flatMap((field) => field.boxes);
  const fields = picked.map(({ kind, boxes }) => ({ kind, count: boxes.length, label: boxes.length > 1 ? "" : label(boxes[0]) }));
  return { origin: location.origin, fields };
}`;
// Types into the boxes found when the user was asked, only if the frame is still on that site and every box is still in
// the page; a password goes only into a box that still hides it.
const TYPE = `function (origin, texts, kinds, ...boxes) {
  if (location.origin !== origin) return { moved: location.origin };
  if (!boxes.every((e) => e.isConnected)) return { reason: "The page changed after you were asked, so nothing was typed." };
  if (boxes.some((e, i) => kinds[i] === "password" && e.type !== "password")) {
    return { reason: "The password box no longer hides what is typed, so nothing was typed." };
  }
  boxes.forEach((e, i) => {
    e.focus();
    e.select();
    if (document.execCommand("insertText", false, texts[i])) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, texts[i]);
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return {};
}`;
// Clicks the submit button of the box's form, as some sites ignore a synthetic Enter; false when there is none to click.
const SUBMIT = `function (origin) {
  if (location.origin !== origin) return true;
  const button = this.form && [...this.form.elements].find((e) => e.type === "submit" && !e.disabled);
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
const PROBE = `() => ({ active: document.activeElement?.tagName === "INPUT", focus: document.hasFocus() })`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

const failed = (reason) => ({ status: "failed", reason, filled: [] });

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
  const wanted = fields?.split(",") ?? [];
  if (!wanted.every((field) => FIELDS.includes(field))) fail(USAGE);
  const broken = RULES.find(([breaks]) => breaks(wanted, options));
  if (broken) fail(broken[1]);
  if (options.public && !options.public.startsWith("https://")) fail("--public must be an https:// URL.");
  const tab = await pickTab(options.cdp, options.tab);
  const top = new URL(options.dialog ?? tab.url).origin;
  if (!/^https?:/.test(top)) fail(`The tab is on ${tab.url}, not a website.`);
  const kind = wanted.includes("link") ? "link" : options.dialog ? "dialog" : "boxes";
  const target = await TARGETS[kind](tab, wanted, options);
  const id = randomBytes(6).toString("base64url");
  const config = {
    id, top, ...target, label: options.label, characters: options.characters?.split(",").map(Number),
    dialog: options.dialog, cdp: options.cdp, target: tab.id, token: randomBytes(32).toString("base64url"),
    public: options.public, tunnel: options.tunnel, minutes: Number(options.minutes),
    port: Number(options.port ?? (options.public ? PUBLIC_PORT : 0)),
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

// What each kind of ask fills: the boxes the page shows, a link to open, or the browser's own login dialog.
const TARGETS = {
  link: (tab) => ({ frame: tab.id, origin: new URL(tab.url).origin, fields: [{ kind: "link" }] }),
  dialog: (tab, wanted, options) => ({
    frame: tab.id, origin: new URL(options.dialog).origin, fields: [{ kind: "username" }, { kind: "password" }],
  }),
  boxes: wire,
};

// Finds the boxes to fill now, in the tab or in the frame the agent clicked into, and keeps DevTools references to
// them, so the fill types into these boxes and nowhere else.
async function wire(tab, wanted, options) {
  const browser = await connect(tab.webSocketDebuggerUrl);
  const frame = options.focused ? await focusedFrame(browser) : { id: tab.id };
  const contextId = await world(browser, frame);
  const how = options.characters ? "characters" : options.focused ? "focused" : "find";
  const positions = options.characters?.split(",").map(Number);
  const args = [how, wanted, positions].map((arg) => JSON.stringify(arg)).join(", ");
  const found = await run(browser, frame, contextId, `(${DETECT})(${args})`);
  if (!found) fail("The page did not answer. Try again once it has loaded.");
  if (found.reason) fail(found.reason);
  const total = found.fields.reduce((sum, field) => sum + field.count, 0);
  const nodes = await Promise.all(Array.from({ length: total }, (_, i) => backendNode(browser, frame, contextId, i)));
  browser.close();
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
  const probes = await Promise.all(all.map(async (frame) => ({ ...frame, ...(await evaluate(browser, frame, PROBE)) })));
  const typing = probes.filter((probe) => probe.active);
  const picked = typing.length > 1 ? typing.filter((probe) => probe.focus) : typing;
  if (picked.length !== 1) fail("No box is selected. Click into the box, then ask again with --focused.");
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
  const params = { frameId: frame.id, worldName: "agent-signin" };
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
    const handlers = shell("defaults", ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"]);
    const bundle = handlers.match(/LSHandlerRoleAll = "?([\w.-]+)"?;\s*LSHandlerURLScheme = https;/)?.[1];
    return CHROMIUM.test(bundle) && ["open", "-nb", bundle, "--args", `--app=${url}`, ...WINDOW];
  },
  linux: (url) => {
    const name = shell("xdg-settings", ["get", "default-web-browser"]).trim().replace(/\.desktop$/, "");
    return CHROMIUM.test(name) && [name, `--app=${url}`, ...WINDOW];
  },
};

function shell(command, args) {
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
  const kinds = config.fields.map((field) => field.kind);
  const save = (state) => writeState(config.id, { origin: config.origin, fields: kinds, ...state });
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
    const values = Object.fromEntries(config.fields.filter((f) => sent[f.kind]).map((f) => [f.kind, String(sent[f.kind])]));
    if (Object.keys(values).length < config.fields.length) return reply(response, 400, "Fill in every box first.");
    // Checked again after the await and set before the next one, so two POSTs can never both fill.
    if (busy) return reply(response, 404, "This link is no longer open.");
    busy = true;
    const result = await fill(config, values).catch(() => failed("The browser stopped answering."));
    reply(response, 200, message(config, result), result);
  };
}

function message(config, result) {
  if (result.status !== "filled") return `Stopped. ${result.reason}`;
  if (result.filled.includes("link")) return "Opened the link in your agent's browser.";
  const names = result.filled.map((field) => (field === "secret" ? "answer" : field));
  return `Typed your ${names.join(" and ")} into ${new URL(config.origin).host}.`;
}

async function fill(config, values) {
  const tab = (await pages(config.cdp)).find((target) => target.id === config.target);
  if (!tab) return failed("The browser tab is gone.");
  const browser = await connect(tab.webSocketDebuggerUrl);
  const mode = config.dialog ? answerDialog : values.link ? openLink : typeWired;
  return mode(browser, config, values).finally(browser.close);
}

// What goes into one box of a field: the whole answer, one digit of a split code, or one picked character.
function piece(field, text, index, positions) {
  if (positions) return text[positions[index] - 1];
  return field.boxes.length > 1 ? text[index] : text;
}

async function typeWired(browser, config, values) {
  const frame = (await frames(browser)).find((candidate) => candidate.id === config.frame);
  if (!frame) return failed("The frame with the boxes is gone.");
  const here = await evaluate(browser, frame, "() => location.origin");
  if (here !== config.origin) return failed(`The page left ${config.origin} for ${here}.`);
  const plan = config.fields.flatMap((field) => field.boxes.map((node, i) => ({
    node, kind: config.characters ? "character" : field.kind, text: piece(field, values[field.kind], i, config.characters),
  })));
  if (plan.some((box) => box.text === undefined)) return failed("The answer is shorter than the boxes it has to fill.");
  const quiet = await requests(browser);
  const contextId = await world(browser, frame);
  const boxes = await Promise.all(plan.map((box) => resolve(browser, frame, contextId, box.node)));
  if (boxes.includes(undefined)) return failed("The page changed after you were asked, so nothing was typed.");
  const args = [config.origin, plan.map((box) => box.text), plan.map((box) => box.kind)].map((value) => ({ value }));
  const params = { functionDeclaration: TYPE, executionContextId: contextId, returnByValue: true };
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
  const cleared = await settle(browser, frame, config.origin, secrets);
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

// Page snapshots show what a password box holds, so nothing typed may still sit in the page when the agent looks.
async function settle(browser, frame, origin, secrets) {
  for (const deadline = Date.now() + SETTLE_MS; Date.now() < deadline; await sleep(POLL_MS)) {
    if (!((await evaluate(browser, frame, HELD, origin, secrets, false)) ?? 1)) return false;
  }
  return Boolean(await evaluate(browser, frame, HELD, origin, secrets, true));
}

// Presses Enter only when the box's form has no button to click; a page that already moved on gets nothing.
async function submit(browser, frame, origin, box) {
  const params = { functionDeclaration: SUBMIT, objectId: box, arguments: [{ value: origin }], returnByValue: true };
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
  await browser.send("Page.navigate", { url: url.href });
  return { status: "filled", filled: ["link"] };
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
  await Promise.race([loaded, sleep(LOAD_MS)]);
  await browser.send("Fetch.disable");
  if (asked === 1) return { status: "filled", filled: ["username", "password"] };
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
  const link = config.fields[0].kind === "link";
  const hint = config.characters ? `<p class="sub">Only characters ${config.characters.join(", ")} are typed.</p>` : "";
  const parts = {
    nonce,
    host,
    sub: link ? "Your agent's browser will open it, signing in to" : "Your agent's browser will type this into",
    inside: top === host ? "" : `<p class="sub">inside ${top}</p>`,
    inputs: config.fields.map((field) => INPUTS[field.kind](escapeHtml(field.label || LABELS[field.kind]))).join("") + hint,
    button: link ? "Open link" : "Sign in",
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
  username: (label) => `<label for="username">${label}</label><input id="username" name="username" type="text"
    autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>`,
  password: (label) => hidden("password", label, "current-password"),
  code: (label) => `<label for="code">${label}</label><input id="code" name="code" type="text" inputmode="numeric"
    autocomplete="one-time-code" required>`,
  secret: (label) => hidden("secret", label, "off"),
  link: (label) => `<label for="link">${label}</label><input id="link" name="link" type="url"
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
if (!COMMANDS[command] || (command === "wait" && !argument)) fail(USAGE);
await COMMANDS[command](argument, options).catch((error) => fail(error.message));
