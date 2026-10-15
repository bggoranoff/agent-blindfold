import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SCRIPT = fileURLToPath(new URL("../skills/agent-signin/signin.mjs", import.meta.url));
const CHROMES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const CHROME = CHROMES.find((path) => path && existsSync(path));
const USERNAME = "ada@example.com";
const PASSWORD = "correct-horse-battery-staple";
const LOGIN = `<form method="post"><input type="email" name="identifier" autocomplete="username"><button>Next</button></form>`;
const PASSWORD_PAGE = `<form method="post"><input type="password" name="secret"><button>Sign in</button></form>`;
const DEAF_PAGE = `<form method="post"><input type="password" name="deaf" onkeydown="event.key === 'Enter' && event.preventDefault()">
  <button>Sign in</button></form>`;
const STUCK_PAGE = `<form onsubmit="return false"><input type="password" name="stuck"><button>Sign in</button></form>`;

let chrome, profile, cdp, site, other;

// A two-step login like Google's: the username on one page, the password on the next.
function fixture() {
  const received = {};
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    Object.assign(received, Object.fromEntries(new URLSearchParams(body)));
    const next = {
      "POST /login": [303, "", { Location: "/password" }],
      "GET /password": [200, PASSWORD_PAGE, {}],
      "GET /deaf": [200, DEAF_PAGE, {}],
      "GET /stuck": [200, STUCK_PAGE, {}],
    };
    const [status, html, headers] = next[`${request.method} ${request.url}`] ?? [200, LOGIN, {}];
    response.writeHead(status, { "Content-Type": "text/html", ...headers }).end(html);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` });
  }));
}

async function run(...args) {
  const env = { ...process.env, BROWSER: "true" };
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [SCRIPT, ...args, "--cdp", cdp], { env })
    .catch((error) => error);
  return { output: stdout + stderr, result: JSON.parse(stdout) };
}

async function openTab(url) {
  return (await fetch(`${cdp}/json/new?${url}`, { method: "PUT" })).json();
}

async function evaluate(tab, expression) {
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve) => (socket.onopen = resolve));
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  const { data } = await new Promise((resolve) => (socket.onmessage = resolve));
  socket.close();
  return JSON.parse(data).result.result.value;
}

before(async () => {
  if (!CHROME) return;
  profile = mkdtempSync(join(tmpdir(), "agent-signin-test-"));
  // Port 0 and a fresh profile: never the user's own browser on 9222.
  chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
    "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  while (!existsSync(portFile)) await sleep(100);
  cdp = `http://127.0.0.1:${readFileSync(portFile, "utf8").split("\n")[0]}`;
  [site, other] = await Promise.all([fixture(), fixture()]);
});

after(async () => {
  const exited = chrome && new Promise((resolve) => chrome.once("exit", resolve));
  chrome?.kill();
  await exited;
  site?.server.close();
  other?.server.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

test("a two-step login gets the username, then the password, and no output holds either", { skip: !CHROME && "no Chromium" }, async () => {
  await openTab(`${site.url}/login`);
  await sleep(500);
  const asked = await run("ask", "username,password", "--tab", `${site.url}/login`);
  assert.equal(asked.result.status, "waiting");
  assert.equal(asked.result.origin, site.url);

  const page = await (await fetch(asked.result.url)).text();
  assert.match(page, new RegExp(new URL(site.url).host));
  const answer = await fetch(asked.result.url, { method: "POST", body: JSON.stringify({ username: USERNAME, password: PASSWORD }) });
  const waited = await run("wait", asked.result.id);

  assert.equal(waited.result.status, "filled");
  assert.deepEqual(waited.result.filled, ["username", "password"]);
  while (!site.received.secret) await sleep(100);
  assert.deepEqual(site.received, { identifier: USERNAME, secret: PASSWORD });
  const everything = asked.output + waited.output + (await answer.text());
  assert.ok(!everything.includes(PASSWORD) && !everything.includes(USERNAME));
});

test("a tab that moved to another origin gets nothing typed", { skip: !CHROME && "no Chromium" }, async () => {
  const tab = await openTab(`${site.url}/password?moved`);
  await sleep(500);
  const asked = await run("ask", "password", "--tab", "?moved");
  await evaluate(tab, `location.href = ${JSON.stringify(`${other.url}/password`)}`);
  await sleep(500);

  await fetch(asked.result.url, { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
  const waited = await run("wait", asked.result.id);

  assert.equal(waited.result.status, "failed");
  assert.match(waited.result.reason, new RegExp(other.url));
  assert.equal(await evaluate(tab, "document.querySelector('input').value"), "");
});

test("a form that ignores Enter is sent with its own button", { skip: !CHROME && "no Chromium" }, async () => {
  await openTab(`${site.url}/deaf`);
  await sleep(500);
  const asked = await run("ask", "password", "--tab", "/deaf");
  await fetch(asked.result.url, { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
  const waited = await run("wait", asked.result.id);

  assert.equal(waited.result.status, "filled");
  assert.equal(site.received.deaf, PASSWORD);
});

test("a password the page still holds is emptied before the agent hears back", { skip: !CHROME && "no Chromium" }, async () => {
  const tab = await openTab(`${site.url}/stuck`);
  await sleep(500);
  const asked = await run("ask", "password", "--tab", "/stuck");
  await fetch(asked.result.url, { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
  const waited = await run("wait", asked.result.id);

  assert.equal(waited.result.cleared, true);
  assert.equal(await evaluate(tab, "document.querySelector('input').value"), "");
});
