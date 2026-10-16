#!/usr/bin/env node
// Hand a login from the user to the agent's browser on a one-time page, without the agent ever seeing it.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { json } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { failed, fill as fillTab, POLL_MS, TARGETS } from "./extension/browser.mjs";

const USAGE = `Usage:
  signin.mjs ask [<fields>] [--tab <text>] [--focused] [--characters <n,n,...>] [--label <text>] [--wait]
                 [--cdp <url> | --cdp extension] [--public <https url> | --tunnel] [--port <n>] [--minutes <n>]
  signin.mjs ask link [--tab <text>] [--wait] ...
  signin.mjs ask --dialog <url> [--tab <text>] [--wait] ...
  signin.mjs wait <id>
  signin.mjs install [<browser profile folder>]
  signin.mjs setup

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
const STATE = join(tmpdir(), "agent-blindfold");
// Where the companion extension's native host, extension/host.mjs, listens for the user's own Chrome.
const EXTENSION = join(STATE, "extension.sock");
const HOST = "io.github.bggoranoff.agent_blindfold";
const EXTENSION_ID = "ahgehaammfeiemempinnlmodhpjdaohm";
// Google Chrome's profile folder, under the home folder, where Chrome looks for native messaging hosts.
const CHROME_PROFILES = { darwin: "Library/Application Support/Google/Chrome", linux: ".config/google-chrome" };
const PUBLIC_PORT = 8769;
const COMMAND_MS = 10000;
const TUNNEL_MS = 30000;


// Written synchronously: the process often exits right after, and a pending write to an agent's pipe would be lost.
const say = (fd, text) => writeSync(fd, `${text}\n`);

function fail(message) {
  say(2, message);
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

// A tab's address without its query or fragment, where sign-in links and OAuth codes keep their tokens.
const bare = (url) => url.split(/[?#]/)[0];

async function pickTab(cdp, text = "") {
  if (cdp === "extension") return extensionTab(text);
  const all = await pages(cdp);
  const matches = all.filter((tab) => tab.url.includes(text));
  if (matches.length !== 1) {
    fail(`${matches.length} tabs match ${JSON.stringify(text)}. Pass --tab with part of one URL:\n`
      + all.map((tab) => bare(tab.url)).join("\n"));
  }
  return matches[0];
}

// The user's own Chrome holds all their tabs, so the extension names only the one tab that matches.
async function extensionTab(text) {
  const tab = await extension({ step: "tab", text });
  if (!tab.id) fail(`${tab.count} tabs match ${JSON.stringify(text)}. Pass --tab with part of one URL.`);
  return tab;
}

async function ask(fields, options) {
  const wanted = fields?.split(",") ?? [];
  if (!wanted.every((field) => FIELDS.includes(field))) fail(USAGE);
  const broken = RULES.find(([breaks]) => breaks(wanted, options));
  if (broken) fail(broken[1]);
  if (options.public && !options.public.startsWith("https://")) fail("--public must be an https:// URL.");
  const tab = await pickTab(options.cdp, options.tab);
  const top = new URL(options.dialog ?? tab.url).origin;
  if (!/^https?:/.test(top)) fail(`The tab is on ${bare(tab.url)}, not a website.`);
  const kind = wanted.includes("link") ? "link" : options.dialog ? "dialog" : "boxes";
  const target = await prepare(tab, kind, wanted, options);
  const id = randomBytes(6).toString("hex");
  const local = !options.public && !options.tunnel;
  const native = process.platform === "darwin" && !process.env.BROWSER;
  const config = {
    id, top, ...target, label: options.label, characters: options.characters?.split(",").map(Number),
    dialog: options.dialog, cdp: options.cdp, target: tab.id, token: randomBytes(32).toString("base64url"),
    public: options.public, tunnel: options.tunnel, minutes: Number(options.minutes), native,
    port: Number(options.port ?? (options.public ? PUBLIC_PORT : 0)),
  };
  // The token goes over stdin rather than argv, where `ps` would show it.
  const server = spawn(process.execPath, [SELF, "serve"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
  server.stdin.end(JSON.stringify(config));
  server.unref();
  // A tunnel can take one wait for its URL and another for its DNS record.
  const state = await settled(id, (s) => s.url || s.status !== "waiting", Date.now() + 2 * TUNNEL_MS + 5000);
  say(1, JSON.stringify({ id, ...state }));
  if (state.status !== "waiting") process.exit(1);
  if (local && !native) openPage(state.url);
  if (options.wait) await wait(id);
}

// What the fill will need: over a DevTools port, the boxes themselves; in the user's own Chrome, the extension keeps them
// and hands back a handle.
async function prepare(tab, kind, wanted, options) {
  const { focused, characters, label, dialog } = options;
  const found = options.cdp === "extension"
    ? await extension({ step: "find", tab: tab.id, kind, wanted, options: { focused, characters, label, dialog } })
    : await port(tab, (browser) => TARGETS[kind](browser, tab, wanted, options));
  if (found.reason) fail(found.reason);
  return found;
}

function openPage(url) {
  const opener = process.env.BROWSER ?? (process.platform === "win32" ? "explorer" : "xdg-open");
  spawn(opener, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
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
  say(1, JSON.stringify(state));
  process.exit(state.status === "filled" ? 0 : 1);
}

// Lets the browser start the companion extension's host: a manifest in its NativeMessagingHosts folder, and a wrapper
// beside it that pins this node, since the browser starts hosts without the user's PATH.
async function install(profile) {
  if (!profile && !CHROME_PROFILES[process.platform]) fail("Pass the browser's profile folder: install works on macOS and Linux.");
  const hosts = join(profile ?? join(homedir(), CHROME_PROFILES[process.platform]), "NativeMessagingHosts");
  const wrapper = join(hosts, `${HOST}.sh`);
  const manifest = join(hosts, `${HOST}.json`);
  const unpacked = fileURLToPath(new URL("./extension", import.meta.url));
  mkdirSync(hosts, { recursive: true });
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${join(unpacked, "host.mjs")}"\n`, { mode: 0o755 });
  const allowed = [`chrome-extension://${EXTENSION_ID}/`];
  writeFileSync(manifest, JSON.stringify({ name: HOST, description: "agent-blindfold", type: "stdio", path: wrapper, allowed_origins: allowed }));
  say(1, `Chrome can now start the agent-blindfold extension's helper (${manifest}).
Now load the extension once: open chrome://extensions, turn on Developer mode, click Load unpacked and pick ${unpacked}
To remove it later, remove the extension and delete ${manifest} and ${wrapper}.`);
}

// Copies the package out of npm's cache to ~/.agent-blindfold, where the README's own-Chrome install clones it, since agents and the browser keep paths into it.
async function setup() {
  const home = join(homedir(), ".agent-blindfold");
  const root = join(dirname(SELF), "..", "..");
  const skill = basename(dirname(SELF));
  if (existsSync(join(home, ".git"))) fail(`${home} is a git clone: update it with git -C ${home} pull instead.`);
  if (root !== home) cpSync(root, home, { recursive: true });
  for (const skills of [join(homedir(), ".claude", "skills"), join(homedir(), ".agents", "skills")]) {
    mkdirSync(skills, { recursive: true });
    rmSync(join(skills, skill), { force: true });
    symlinkSync(join(home, "skills", skill), join(skills, skill), "junction");
  }
  say(1, `Installed to ${home} and linked the ${skill} skill for Claude Code and Codex.
For your own Chrome, also run: node ${join(home, "skills", skill, "signin.mjs")} install`);
}

async function serve() {
  const config = JSON.parse(readFileSync(0, "utf8"));
  const kinds = config.fields.map((field) => field.kind);
  const save = (state) => writeState(config.id, { origin: config.origin, fields: kinds, ...state });
  const job = { busy: false };
  let tunnel, dialog, over;
  const finish = (state) => {
    if (over) return;
    over = true;
    job.busy = true;
    save(state);
    tunnel?.kill();
    dialog?.kill();
    // A beat for the answer to reach the page, which may already have been closed mid-fill.
    setTimeout(() => process.exit(0), 500);
  };
  try {
    const server = createServer(handler(config, finish, job));
    await new Promise((resolve, reject) => server.once("error", reject).listen(config.port, "127.0.0.1", resolve));
    const local = `http://127.0.0.1:${server.address().port}`;
    if (config.tunnel) [tunnel, config.public] = await openTunnel(local);
    const expires = Date.now() + config.minutes * 60000;
    save({ status: "waiting", url: `${(config.public ?? local).replace(/\/$/, "")}/${config.token}`, expires });
    if (config.native) dialog = prompt(config, finish, job);
    // A fill under way finishes, cleanup included, even when the link expires meanwhile.
    setTimeout(() => job.busy || finish({ status: "expired" }), expires - Date.now());
  } catch (error) {
    finish({ status: "failed", reason: error.message });
  }
}

// Asks in a window on this Mac as well as through the link, and the first answer wins; the window's answer comes back
// over a pipe to this process alone.
function prompt(config, finish, job) {
  const dialog = spawn("osascript", ["-l", "JavaScript", "-e", DIALOG, JSON.stringify(form(config))],
    { stdio: ["ignore", "pipe", "ignore"] });
  const answered = async (values) => {
    if (job.busy) return;
    if (!values) return finish({ status: "cancelled" });
    job.busy = true;
    finish(await fill(config, values).catch(() => failed("The browser stopped answering.")));
  };
  // A Mac with no screen to show the window on can still be answered through a public link.
  const unopened = () => config.public || finish(failed("The sign-in window did not open."));
  json(dialog.stdout).then(answered, unopened);
  return dialog;
}

async function openTunnel(local) {
  const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", local], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  const url = await new Promise((resolve, reject) => {
    tunnel.on("error", () => reject(new Error("--tunnel needs cloudflared on the PATH.")));
    tunnel.on("exit", () => reject(new Error("cloudflared exited before it had a URL.")));
    setTimeout(() => {
      tunnel.kill();
      reject(new Error("cloudflared had no URL after 30 seconds."));
    }, TUNNEL_MS);
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
  for (const deadline = Date.now() + TUNNEL_MS; Date.now() < deadline; await sleep(1000)) {
    if (await resolver.resolve4(host).catch(() => null)) return;
  }
}

function handler(config, finish, job) {
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
    if (route === "POST /cancel" && !job.busy) return reply(response, 200, "Cancelled. Nothing was typed.", { status: "cancelled" });
    if (route !== "POST " || job.busy) return reply(response, 404, "This link is no longer open.");
    const sent = await json(request).catch(() => ({}));
    const values = Object.fromEntries(config.fields.filter((f) => sent[f.kind]).map((f) => [f.kind, String(sent[f.kind])]));
    if (Object.keys(values).length < config.fields.length) return reply(response, 400, "Fill in every box first.");
    // Checked again after the await and set before the next one, so two POSTs can never both fill.
    if (job.busy) return reply(response, 404, "This link is no longer open.");
    job.busy = true;
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
  if (config.cdp === "extension") return extension({ step: "fill", handle: config.handle, values });
  const tab = (await pages(config.cdp)).find((target) => target.id === config.target);
  if (!tab) return failed("The browser tab is gone.");
  return port(tab, (browser) => fillTab(browser, config, values));
}

// One step over the tab's own DevTools WebSocket.
async function port(tab, step) {
  const browser = await connect(new WebSocket(tab.webSocketDebuggerUrl));
  return step(browser).finally(browser.close);
}

// One step in a tab of the user's own Chrome, asked of the companion extension through its host's socket.
function extension(request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(EXTENSION);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("close", () => reject(new Error("The browser stopped answering.")));
    // The line reader passes the socket's errors on, and an error nobody hears crashes the process.
    createInterface({ input: socket }).on("error", () => {
      reject(new Error("No agent-blindfold extension answers in Chrome. Install it as the README says."));
    }).once("line", (line) => {
      resolve(JSON.parse(line));
      socket.end();
    });
  });
}

async function connect(socket) {
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const pending = new Map();
  const listeners = {};
  let next = 0;
  const done = (id, result, error) => {
    const call = pending.get(id);
    pending.delete(id);
    clearTimeout(call?.timer);
    if (error) return call?.reject(error);
    call?.resolve(result);
  };
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method) return listeners[message.method]?.(message.params);
    done(message.id, message.result ?? {});
  };
  socket.onclose = () => [...pending.keys()].forEach((id) => done(id, null, new Error("The browser closed the connection.")));
  // A browser that stops answering fails the step instead of leaving it waiting forever.
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => done(id, null, new Error("The browser stopped answering.")), COMMAND_MS);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const on = (method, listener) => {
    listeners[method] = listener;
  };
  return { send, on, close: () => socket.close() };
}

// What the page and the window both tell the user: the site that gets the answer, and what happens to it.
function wording(config) {
  const host = new URL(config.origin).host;
  const top = new URL(config.top).host;
  const link = config.fields[0].kind === "link";
  return {
    host,
    sub: link ? "Your agent's browser will open it, signing in to" : "Your agent's browser will type this into",
    inside: top === host ? "" : `inside ${top}`,
    hint: config.characters ? `Only characters ${config.characters.join(", ")} are typed.` : "",
    button: link ? "Open link" : "Sign in",
  };
}

function form(config) {
  const { host, sub, inside, hint, button } = wording(config);
  const where = [host, inside].filter(Boolean).join(", ");
  return {
    title: `Sign in to ${host}`,
    text: [`${sub} ${where}.`, hint].filter(Boolean).join(" "),
    button,
    fields: config.fields.map((field) => ({
      kind: field.kind, label: field.label || LABELS[field.kind], secret: ["password", "secret"].includes(field.kind),
    })),
  };
}

function page(response, config) {
  const nonce = randomBytes(16).toString("base64");
  const { host, sub, inside, hint, button } = wording(config);
  const parts = {
    nonce,
    host,
    sub,
    inside: inside && `<p class="sub">${inside}</p>`,
    inputs: config.fields.map((field) => INPUTS[field.kind](escapeHtml(field.label || LABELS[field.kind]))).join("")
      + (hint && `<p class="sub">${hint}</p>`),
    button,
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

const EYE = `<button type="button" class="eye" aria-label="Show" aria-pressed="false"><svg viewBox="0 0 24 24" width="18"
  height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
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

// A native window with a labelled box per field; prints the answers as JSON, or null when cancelled.
const DIALOG = `ObjC.import("Cocoa");
function run([input]) {
  const form = JSON.parse(input);
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  // Paste reaches a box only through an Edit menu's shortcut.
  const menu = $.NSMenu.alloc.init, edit = $.NSMenu.alloc.init, item = $.NSMenuItem.alloc.init;
  [["Cut", "cut:", "x"], ["Copy", "copy:", "c"], ["Paste", "paste:", "v"], ["Select All", "selectAll:", "a"]]
    .forEach(([title, action, key]) => edit.addItemWithTitleActionKeyEquivalent(title, action, key));
  item.submenu = edit;
  menu.addItem(item);
  app.mainMenu = menu;
  const alert = $.NSAlert.alloc.init;
  alert.messageText = form.title;
  alert.informativeText = form.text;
  alert.addButtonWithTitle(form.button);
  alert.addButtonWithTitle("Cancel");
  const rows = form.fields.length;
  const view = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, 260, rows * 50));
  const boxes = form.fields.map((field, i) => {
    const y = (rows - 1 - i) * 50;
    const label = $.NSTextField.labelWithString(field.label);
    label.frame = $.NSMakeRect(0, y + 26, 260, 17);
    const box = (field.secret ? $.NSSecureTextField : $.NSTextField).alloc.initWithFrame($.NSMakeRect(0, y + 2, 260, 22));
    view.addSubview(label);
    view.addSubview(box);
    return box;
  });
  alert.accessoryView = view;
  alert.window.initialFirstResponder = boxes[0];
  alert.window.autorecalculatesKeyViewLoop = true;
  app.activateIgnoringOtherApps(true);
  for (;;) {
    if (Number(alert.runModal) !== Number($.NSAlertFirstButtonReturn)) return "null";
    const values = boxes.map((box) => box.stringValue.js);
    if (values.every(Boolean)) return JSON.stringify(Object.fromEntries(form.fields.map((field, i) => [field.kind, values[i]])));
    alert.informativeText = form.text + " Fill in every box first.";
  }
}`;

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign in</title>
<style>
:root{--bg:#faf9f5;--fg:#1f1e1d;--muted:#6b6a66;--card:#fff;--line:#e3e1da}
@media (prefers-color-scheme:dark){:root{--bg:#1f1e1d;--fg:#f0eee6;--muted:#a3a19a;--card:#2a2927;--line:#3d3c39}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 -apple-system,system-ui,sans-serif}
main{max-width:340px;margin:0 auto;padding:18px 16px 10px}h1{font-size:19px;margin:0;text-align:center}
p{text-align:center;margin:2px 0}.sub{color:var(--muted);font-size:13px}.host{font-weight:700;font-size:16px;overflow-wrap:anywhere}
form{margin-top:8px}label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
input{width:100%;font:inherit;font-size:16px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
button{display:block;width:100%;font:inherit;font-weight:600;padding:9px;margin-top:14px;border:0;border-radius:8px;background:var(--fg);color:var(--bg)}
button.quiet{background:none;color:var(--muted);margin-top:2px;padding:6px}[hidden]{display:none}
.secret{position:relative}.secret input{padding-right:40px}
.eye{position:absolute;right:2px;top:50%;transform:translateY(-50%);display:flex;width:36px;margin:0;padding:7px;background:none;color:var(--muted)}
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
const COMMANDS = { ask, wait, serve, install, setup };
if (!COMMANDS[command] || (command === "wait" && !argument)) fail(USAGE);
await COMMANDS[command](argument, options).catch((error) => fail(error.message));
