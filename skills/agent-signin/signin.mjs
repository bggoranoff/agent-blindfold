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
  signin.mjs ask <fields> [--tab <text>] [--cdp <url>] [--public <https url> | --tunnel] [--port <n>] [--minutes <n>]
  signin.mjs wait <id>

<fields> is a comma list of username, password and code.`;
const SELF = fileURLToPath(import.meta.url);
const FIELDS = ["username", "password", "code"];
const STATE = join(tmpdir(), "agent-signin");
const PUBLIC_PORT = 8769;
const NEXT_FIELD_MS = 15000;
const SETTLE_MS = 10000;
// Sites check a field when it loses focus and hold back a submit until that check is done, as a person's pause allows.
const PAUSE_MS = 1000;
const OPENERS = { darwin: "open", win32: "explorer" };
const CHROMIUM = /chrome|chromium|edge|brave|vivaldi/i;
const WINDOW = ["--window-size=440,640"];
// Runs in the tab. The origin check and the typing share one evaluation, so a navigation cannot slip between them.
const FILL = `(origin, values) => {
  if (location.origin !== origin) return { moved: location.origin };
  // Password managers' and sites' helper fields render but are aria-hidden; no person can see or reach them.
  const shown = (e) => e.getClientRects().length && !e.disabled && !e.readOnly && !e.closest("[aria-hidden=true]")
    && getComputedStyle(e).visibility !== "hidden" && !["hidden", "submit", "button", "checkbox", "radio"].includes(e.type);
  const inputs = [...document.querySelectorAll("input")].filter(shown);
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
  const type = (e, text) => {
    e.focus();
    e.select();
    if (document.execCommand("insertText", false, text)) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, text);
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  };
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
// Runs in the tab: clicks the submit button of the form holding the value, as some sites ignore a synthetic Enter.
const SUBMIT = `(origin, value) => {
  if (location.origin !== origin) return true;
  const field = [...document.querySelectorAll("input")].find((e) => e.value === value);
  const button = field?.form && [...field.form.elements].find((e) => e.type === "submit" && !e.disabled);
  button?.click();
  return Boolean(button);
}`;
// Runs in the tab: finds inputs still holding a typed secret, and empties them when asked.
const HELD = `(origin, secrets, empty) => {
  if (location.origin !== origin) return 0;
  const held = [...document.querySelectorAll("input")].filter((e) => secrets.includes(e.value));
  if (empty) held.forEach((e) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, ""));
  return held.length;
}`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

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
  if (options.public && !options.public.startsWith("https://")) fail("--public must be an https:// URL.");
  const tab = await pickTab(options.cdp, options.tab);
  const origin = new URL(tab.url).origin;
  if (!/^https?:/.test(origin)) fail(`The tab is on ${tab.url}, not a website.`);
  const id = randomBytes(6).toString("base64url");
  const config = {
    id, origin, fields: wanted, cdp: options.cdp, target: tab.id, token: randomBytes(32).toString("base64url"),
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
  if (options.public || options.tunnel) return;
  openPage(state.url);
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
    await sleep(300);
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
    const failed = { status: "failed", reason: "The browser stopped answering.", filled: [] };
    const result = await fill(config, values).catch(() => failed);
    reply(response, 200, message(config, result), result);
  };
}

function message(config, result) {
  const host = new URL(config.origin).host;
  if (result.status === "filled") return `Typed your ${result.filled.join(" and ")} into ${host}.`;
  return `Nothing more was typed: ${result.reason}`;
}

async function fill(config, values) {
  const tab = (await pages(config.cdp)).find((target) => target.id === config.target);
  if (!tab) return { status: "failed", reason: "The browser tab is gone.", filled: [] };
  const browser = await connect(tab.webSocketDebuggerUrl);
  const filled = [];
  let left = Object.keys(values);
  let deadline = Date.now() + NEXT_FIELD_MS;
  // Type what the page shows, press Enter, and wait for the next step to show the rest (identifier-first logins).
  while (left.length && Date.now() < deadline) {
    const only = Object.fromEntries(left.map((field) => [field, values[field]]));
    const expression = `(${FILL})(${JSON.stringify(config.origin)}, ${JSON.stringify(only)})`;
    const { result } = await browser.send("Runtime.evaluate", { expression, returnByValue: true });
    const outcome = result?.value ?? { typed: [] };
    if (outcome.moved) return { status: "failed", reason: `The tab left ${config.origin} for ${outcome.moved}.`, filled };
    if (!outcome.typed.length) {
      await sleep(500);
      continue;
    }
    filled.push(...outcome.typed);
    left = left.filter((field) => !outcome.typed.includes(field));
    await sleep(PAUSE_MS);
    await submit(browser, config.origin, values[outcome.typed.at(-1)]);
    deadline = Date.now() + NEXT_FIELD_MS;
  }
  if (!filled.length) return { status: "failed", reason: `No ${left.join(" or ")} field showed on ${config.origin}.`, filled };
  const cleared = await settle(browser, config.origin, [values.password, values.code].filter(Boolean));
  return { status: "filled", filled, unused: left, ...(cleared && { cleared: true }) };
}

// Page snapshots show what a password field holds, so nothing typed may still sit in the page when the agent looks.
async function settle(browser, origin, secrets) {
  const held = async (empty) => {
    const expression = `(${HELD})(${JSON.stringify(origin)}, ${JSON.stringify(secrets)}, ${empty})`;
    const { result } = await browser.send("Runtime.evaluate", { expression, returnByValue: true });
    return result?.value ?? 1;
  };
  for (const deadline = Date.now() + SETTLE_MS; Date.now() < deadline; await sleep(300)) {
    if (!(await held(false))) return false;
  }
  return Boolean(await held(true));
}

async function submit(browser, origin, value) {
  const expression = `(${SUBMIT})(${JSON.stringify(origin)}, ${JSON.stringify(value)})`;
  const { result } = await browser.send("Runtime.evaluate", { expression, returnByValue: true });
  if (result?.value) return;
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const pending = new Map();
  let next = 0;
  socket.onmessage = ({ data }) => {
    const answer = JSON.parse(data);
    pending.get(answer.id)?.(answer);
    pending.delete(answer.id);
  };
  const send = (method, params) => new Promise((resolve) => {
    pending.set(++next, (answer) => resolve(answer.result ?? {}));
    socket.send(JSON.stringify({ id: next, method, params }));
  });
  return { send };
}

function page(response, config) {
  const nonce = randomBytes(16).toString("base64");
  const host = new URL(config.origin).host;
  const inputs = config.fields.map((field) => INPUTS[field]).join("");
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; `
      + "connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(PAGE.replace("{host}", host).replace("{inputs}", inputs).replace("{nonce}", nonce));
}

const INPUTS = {
  username: `<label for="username">Email or username</label><input id="username" name="username" type="text"
    autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>`,
  password: `<label for="password">Password</label><input id="password" name="password" type="password"
    autocomplete="current-password" required>`,
  code: `<label for="code">Verification code</label><input id="code" name="code" type="text" inputmode="numeric"
    autocomplete="one-time-code" required>`,
};

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign in</title>
<style>
:root{--bg:#faf9f5;--fg:#1f1e1d;--muted:#6b6a66;--card:#fff;--line:#e3e1da}
@media (prefers-color-scheme:dark){:root{--bg:#1f1e1d;--fg:#f0eee6;--muted:#a3a19a;--card:#2a2927;--line:#3d3c39}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:380px;margin:0 auto;padding:40px 16px}h1{font-size:24px;margin:0;text-align:center}
p{text-align:center;margin:4px 0}.sub{color:var(--muted)}.host{font-weight:700;font-size:20px;overflow-wrap:anywhere;margin-bottom:16px}
label{display:block;font-size:14px;color:var(--muted);margin:16px 0 6px}
input{width:100%;font:inherit;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg)}
button{display:block;width:100%;font:inherit;font-weight:600;padding:13px;margin-top:20px;border:0;border-radius:10px;background:var(--fg);color:var(--bg)}
button.quiet{background:none;color:var(--muted);margin-top:8px}[hidden]{display:none}
</style>
<main><h1>Sign in</h1><p class="sub">Your agent's browser will type this into</p><p class="host">{host}</p>
<form>{inputs}<button>Sign in</button></form><button class="quiet" id="cancel">Cancel</button><p id="status" role="status"></p></main>
<script nonce="{nonce}">
const form = document.forms[0], cancel = document.getElementById("cancel"), status = document.getElementById("status");
async function send(path, body) {
  form.hidden = cancel.hidden = true;
  status.textContent = "Signing in…";
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => null);
  const answer = response?.ok ? await response.json() : { message: "This link is no longer open." };
  status.textContent = answer.message;
  if (answer.close) setTimeout(() => window.close(), 2500);
}
form.onsubmit = (event) => {
  event.preventDefault();
  const body = JSON.stringify(Object.fromEntries(new FormData(form)));
  form.reset();
  send(location.pathname, body);
};
cancel.onclick = () => send(location.pathname + "/cancel", "{}");
</script>`;

const { values: options, positionals: [command, argument] } = parseArgs({
  allowPositionals: true,
  options: {
    tab: { type: "string" },
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
