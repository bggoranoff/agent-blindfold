import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SCRIPT = fileURLToPath(new URL("../skills/agent-signin/signin.mjs", import.meta.url));
// Set by extension.test.mjs, which runs every login again through the companion extension instead of the DevTools port.
const EXTENSION = process.env.AGENT_SIGNIN_TEST_EXTENSION && fileURLToPath(new URL("../skills/agent-signin/extension", import.meta.url));
// Another extension that stays attached to every tab, as Claude in Chrome does while it drives one.
const OTHER_MANIFEST = {
  manifest_version: 3, name: "other", version: "1", permissions: ["debugger"], background: { service_worker: "other.js" },
};
const OTHER_WORKER = `setInterval(async () => {
  const pages = (await chrome.debugger.getTargets()).filter((target) => target.type === "page" && target.url.startsWith("http"));
  pages.forEach((page) => chrome.debugger.attach({ targetId: page.id }, "1.3").catch(() => {}));
}, 300);`;
// Google Chrome 137 and later ignore --load-extension, so the extension run never picks it on its own.
const CHROMES = [
  process.env.CHROME,
  !EXTENSION && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  !EXTENSION && "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const CHROME = CHROMES.find((path) => path && existsSync(path));
const SKIP = { skip: !CHROME && "no Chromium" };
const USERNAME = "ada@example.com";
const PASSWORD = "correct-horse-battery-staple";
const LOGIN = `<form method="post"><label>Work email <input type="email" name="identifier" autocomplete="username"></label>
  <button>Next</button></form>`;
const PASSWORD_PAGE = `<form method="post"><input type="password" name="secret"><button>Sign in</button></form>`;
const DEAF_PAGE = `<form method="post"><input type="password" name="deaf" onkeydown="event.key === 'Enter' && event.preventDefault()">
  <button>Sign in</button></form>`;
const STUCK_PAGE = `<form onsubmit="return false"><input type="password" name="stuck"><button>Sign in</button></form>`;
const WORD_PAGE = `<form method="post"><input type="text" name="word"><button>Next</button></form>`;
const CHARACTERS_PAGE = `<form method="post"><input type="password" maxlength="1" name="c1">
  <input type="password" maxlength="1" name="c2"><input type="password" maxlength="1" name="c3"><button>Next</button></form>`;
const FRAMED_PAGE = `<form method="post"><input type="password" name="framed"><button>Sign in</button></form>`;

let chrome, profile, cdp, site, other;

// A site whose pages a test can add to; by default a two-step login like Google's, the username first.
function fixture() {
  const received = {};
  const routes = {
    "POST /login": [303, "", { Location: "/password" }],
    "GET /password": [200, PASSWORD_PAGE],
    "GET /deaf": [200, DEAF_PAGE],
    "GET /stuck": [200, STUCK_PAGE],
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    Object.assign(received, Object.fromEntries(new URLSearchParams(body)));
    const route = routes[`${request.method} ${request.url.split("?")[0]}`] ?? [200, LOGIN];
    const [status, html, headers] = typeof route === "function" ? route(request) : route;
    response.writeHead(status, { "Content-Type": "text/html", ...headers }).end(html);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ server, received, routes, url: `http://127.0.0.1:${server.address().port}` });
  }));
}

async function run(...args) {
  const env = { ...process.env, BROWSER: "true" };
  const browser = EXTENSION ? "extension" : cdp;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [SCRIPT, ...args, "--cdp", browser], { env })
    .catch((error) => error);
  return { output: stdout + stderr, result: stdout ? JSON.parse(stdout) : null };
}

async function answer(asked, values) {
  await fetch(asked.result.url, { method: "POST", body: JSON.stringify(values) });
  return run("wait", asked.result.id);
}

async function openTab(url) {
  const tab = await (await fetch(`${cdp}/json/new?${url}`, { method: "PUT" })).json();
  await sleep(700);
  return tab;
}

async function call(tab, method, params) {
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve) => (socket.onopen = resolve));
  socket.send(JSON.stringify({ id: 1, method, params }));
  const { data } = await new Promise((resolve) => (socket.onmessage = resolve));
  socket.close();
  return JSON.parse(data).result;
}

const evaluate = async (tab, expression) => (await call(tab, "Runtime.evaluate", { expression, returnByValue: true })).result.value;

// A real click, as an agent's browser tool makes one, so focus can land inside a frame from another site.
async function click(tab, x, y) {
  await call(tab, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await call(tab, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function until(check) {
  for (const deadline = Date.now() + 10000; Date.now() < deadline; await sleep(100)) {
    if (await check()) return;
  }
  assert.fail("timed out");
}

// Loads the companion extension, with its host known to this profile alone, and another extension attached to every tab.
function install() {
  // The host's socket goes in the profile too, away from any agent-signin the user runs for real.
  process.env.TMPDIR = profile;
  execFileSync(process.execPath, [SCRIPT, "install", profile]);
  const peer = join(profile, "other");
  mkdirSync(peer);
  writeFileSync(join(peer, "manifest.json"), JSON.stringify(OTHER_MANIFEST));
  writeFileSync(join(peer, "other.js"), OTHER_WORKER);
  return [`--load-extension=${EXTENSION},${peer}`];
}

before(async () => {
  if (!CHROME) return;
  profile = mkdtempSync(join(tmpdir(), "agent-signin-test-"));
  const extensions = EXTENSION ? install() : [];
  // Port 0 and a fresh profile: never the user's own browser on 9222.
  chrome = spawn(CHROME, ["--headless=new", "--use-mock-keychain", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
    "--no-default-browser-check", ...extensions, "about:blank"], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  for (const deadline = Date.now() + 15000; !existsSync(portFile); await sleep(100)) {
    if (Date.now() > deadline || chrome.exitCode !== null) throw new Error("Chrome did not start.");
  }
  cdp = `http://127.0.0.1:${readFileSync(portFile, "utf8").split("\n")[0]}`;
  const socket = join(profile, "agent-signin", "extension.sock");
  for (const deadline = Date.now() + 15000; EXTENSION && !existsSync(socket); await sleep(100)) {
    if (Date.now() > deadline) throw new Error("Chrome did not load the extension; run this with Chrome for Testing or Chromium.");
  }
  [site, other] = await Promise.all([fixture(), fixture()]);
});

after(async () => {
  const exited = chrome?.exitCode === null && new Promise((resolve) => chrome.once("exit", resolve));
  chrome?.kill();
  await exited;
  site?.server.close();
  other?.server.close();
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
});

test("a two-step login asks for the email, then the password, each in the page's own words, and no output holds either", SKIP, async () => {
  const tab = await openTab(`${site.url}/login`);
  const first = await run("ask", "--tab", `${site.url}/login`);
  assert.equal(first.result.status, "waiting");
  assert.equal(first.result.origin, site.url);
  assert.deepEqual(first.result.fields, ["username"]);
  const page = await (await fetch(first.result.url)).text();
  assert.match(page, new RegExp(new URL(site.url).host));
  assert.match(page, /Work email/);
  assert.doesNotMatch(page, /name="password"/);
  const reply = await fetch(first.result.url, { method: "POST", body: JSON.stringify({ username: USERNAME }) });
  const firstWaited = await run("wait", first.result.id);
  assert.equal(firstWaited.result.status, "filled");

  await until(async () => (await evaluate(tab, "location.pathname")) === "/password");
  const second = await run("ask", "--tab", `${site.url}/password`);
  assert.deepEqual(second.result.fields, ["password"]);
  const secondWaited = await answer(second, { password: PASSWORD });

  assert.equal(secondWaited.result.status, "filled");
  await until(() => site.received.secret);
  assert.deepEqual(site.received, { identifier: USERNAME, secret: PASSWORD });
  const everything = first.output + firstWaited.output + second.output + secondWaited.output + (await reply.text());
  assert.ok(!everything.includes(PASSWORD) && !everything.includes(USERNAME));
});

test("a box the page swapped out after the user was asked gets nothing typed, nor does its stand-in", SKIP, async () => {
  const tab = await openTab(`${site.url}/password?swapped`);
  const asked = await run("ask", "--tab", "?swapped");
  await evaluate(tab, `document.querySelector("input").replaceWith(Object.assign(document.createElement("input"), { type: "password" }))`);

  const waited = await answer(asked, { password: PASSWORD });

  assert.equal(waited.result.status, "failed");
  assert.match(waited.result.reason, /page changed/);
  assert.equal(await evaluate(tab, "document.querySelector('input').value"), "");
});

test("a tab that moved to another origin gets nothing typed", SKIP, async () => {
  const tab = await openTab(`${site.url}/password?moved`);
  const asked = await run("ask", "password", "--tab", "?moved");
  await evaluate(tab, `location.href = ${JSON.stringify(`${other.url}/password`)}`);
  await sleep(500);

  const waited = await answer(asked, { password: PASSWORD });

  assert.equal(waited.result.status, "failed");
  assert.match(waited.result.reason, new RegExp(other.url));
  assert.equal(await evaluate(tab, "document.querySelector('input').value"), "");
});

test("a form that ignores Enter is sent with its own button", SKIP, async () => {
  await openTab(`${site.url}/deaf`);
  const asked = await run("ask", "--tab", "/deaf");
  const waited = await answer(asked, { password: PASSWORD });

  assert.equal(waited.result.status, "filled");
  assert.equal(site.received.deaf, PASSWORD);
});

test("a password the page still holds is emptied before the agent hears back", SKIP, async () => {
  const tab = await openTab(`${site.url}/stuck`);
  const asked = await run("ask", "password", "--tab", "/stuck");
  const waited = await answer(asked, { password: PASSWORD });

  assert.equal(waited.result.cleared, true);
  assert.equal(await evaluate(tab, "document.querySelector('input').value"), "");
});

test("a field the agent clicked inside another site's frame gets the password, and the page names that site", SKIP, async () => {
  const frame = `${other.url.replace("127.0.0.1", "localhost")}/framed`;
  other.routes["GET /framed"] = [200, FRAMED_PAGE];
  site.routes["GET /host"] = [200, `<iframe src="${frame}" style="width:360px;height:120px;border:0"></iframe>`];
  const tab = await openTab(`${site.url}/host`);
  await click(tab, 40, 25);

  const asked = await run("ask", "password", "--focused", "--tab", "/host");
  assert.equal(asked.result.origin, new URL(frame).origin);
  assert.match(await (await fetch(asked.result.url)).text(), /inside 127\.0\.0\.1/);
  const waited = await answer(asked, { password: PASSWORD });

  assert.equal(waited.result.status, "filled");
  assert.equal(other.received.framed, PASSWORD);
});

test("a password never goes into a field that is not a password field, but a secret can", SKIP, async () => {
  site.routes["GET /word"] = [200, WORD_PAGE];
  const tab = await openTab(`${site.url}/word`);
  await evaluate(tab, "document.querySelector('input').focus()");

  const refused = await run("ask", "password", "--focused", "--tab", "/word");
  assert.equal(refused.result, null);
  assert.match(refused.output, /not a password box/);

  const asked = await run("ask", "secret", "--focused", "--label", "Memorable <word>", "--tab", "/word");
  assert.match(await (await fetch(asked.result.url)).text(), /Memorable &#60;word&#62;/);
  const waited = await answer(asked, { secret: "blue-whale" });
  assert.equal(waited.result.status, "filled");
  await until(() => site.received.word);
  assert.equal(site.received.word, "blue-whale");
});

test("only the characters asked for are typed, one per box", SKIP, async () => {
  site.routes["GET /characters"] = [200, CHARACTERS_PAGE];
  await openTab(`${site.url}/characters`);
  const asked = await run("ask", "password", "--characters", "2,5,7", "--tab", "/characters");
  const waited = await answer(asked, { password: PASSWORD });

  assert.equal(waited.result.status, "filled");
  assert.deepEqual([site.received.c1, site.received.c2, site.received.c3], ["o", "e", "t"]);
});

test("the browser's own login dialog is answered, for the named site only", SKIP, async () => {
  const expected = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;
  site.routes["GET /basic"] = (request) => (request.headers.authorization === expected
    ? [200, "<h1>Welcome</h1>"] : [401, "Locked", { "WWW-Authenticate": 'Basic realm="test"' }]);
  const tab = await openTab(`${site.url}/basic`);
  const asked = await run("ask", "--dialog", `${site.url}/basic`, "--tab", "/basic");
  const waited = await answer(asked, { username: USERNAME, password: PASSWORD });

  assert.equal(waited.result.status, "filled");
  assert.equal(await evaluate(tab, "document.body.innerText"), "Welcome");
  assert.ok(!waited.output.includes(PASSWORD));
});

test("an emailed sign-in link opens in the agent's tab, and anything but a web link does not", SKIP, async () => {
  const tab = await openTab(`${site.url}/check-email`);
  const bad = await answer(await run("ask", "link", "--tab", "/check-email"), { link: "javascript:alert(1)" });
  assert.equal(bad.result.status, "failed");

  const waited = await answer(await run("ask", "link", "--tab", "/check-email"), { link: `${site.url}/welcome?token=abc` });
  assert.equal(waited.result.status, "filled");
  await until(async () => (await evaluate(tab, "location.href")).endsWith("/welcome?token=abc"));
});

test("the extension takes only its own steps, never a DevTools command", { skip: SKIP.skip || (!EXTENSION && "DevTools port run") }, async () => {
  const socket = createConnection(join(profile, "agent-signin", "extension.sock"));
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(`${JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.cookie" } })}\n`);
  const line = await new Promise((resolve) => createInterface({ input: socket }).once("line", resolve));
  socket.end();
  assert.deepEqual(JSON.parse(line), { status: "failed", reason: "agent-signin has no step undefined.", filled: [] });
});
