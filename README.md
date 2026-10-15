# agent-signin

Let a browser agent sign in to websites without ever seeing your password.

When the agent hits a login form, it runs one command. A one-time page pops up for you (or arrives as a link, if the agent runs on a server). You fill it from your password manager. The script types the values into the agent's browser tab itself, on the site the page named, and submits the form. The agent only learns which fields were typed.

It is one Node script with no dependencies, packaged as an [Agent Skill](https://agentskills.io) so Claude Code, Codex and other skill-aware agents pick it up from a folder.

```
 you ──▶ one-time page ──POST──▶ signin.mjs serve ──DevTools Protocol──▶ the agent's Chromium tab
                                        │
 agent ◀── {"status":"filled","filled":["username","password"]} ◀── state file (no values)
```

## Install

Needs Node 22 or later.

```sh
git clone https://github.com/bggoranoff/agent-signin
ln -s "$PWD/agent-signin/skills/agent-signin" ~/.claude/skills/agent-signin   # Claude Code
ln -s "$PWD/agent-signin/skills/agent-signin" ~/.agents/skills/agent-signin   # Codex
```

The agent's browser must be a Chromium with a DevTools port, which is how Playwright MCP, Chrome DevTools MCP and Browser Use drive it anyway. For example:

```sh
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.agent-browser"
npx @playwright/mcp --cdp-endpoint http://127.0.0.1:9222
```

Set `CDP_URL` when the port is not `http://127.0.0.1:9222`.

## Use

```sh
$ node signin.mjs ask username,password --tab linkedin.com
{"id":"q3Zc1rT0","origin":"https://www.linkedin.com","fields":["username","password"],"status":"waiting","url":"http://127.0.0.1:53121/9fK…","expires":…}
$ node signin.mjs wait q3Zc1rT0
{"origin":"https://www.linkedin.com","fields":["username","password"],"status":"filled","filled":["username","password"],"unused":[]}
```

`ask` takes any of `username`, `password` and `code`, and returns at once. `wait` blocks until the user answers, then prints `filled`, `failed`, `cancelled` or `expired`, and exits 0 only on `filled`. For a site that asks for the email first, ask for both: the script types the email, submits, and types the password when the next page shows it. `"cleared": true` means the page still held the password or code 10 seconds after submitting, so the script emptied the field.

### Local and remote agents

| The agent runs | The user gets the page | Flag |
|---|---|---|
| On the user's machine | A small window in their default browser, which closes itself once answered (a tab if the browser is not Chromium-based; `$BROWSER` overrides) | none |
| On a server, behind your own HTTPS reverse proxy | A link the agent sends them | `--public https://box.example.com/signin` |
| On a server, nothing set up | A link through a Cloudflare quick tunnel | `--tunnel` (needs `cloudflared`) |

With `--public` the page listens on `127.0.0.1:8769` (`--port` changes it). Point the proxy at it, prefix and all. For example, with Caddy:

```
box.example.com {
	reverse_proxy /signin/* 127.0.0.1:8769
}
```

`SIGNIN_PUBLIC_URL` sets `--public` for every call, so the agent does not need to know it.

## Security model

- **The agent never receives a value.** Values go from the page to the script's server process, which holds them in memory for one fill and then exits. Nothing it prints or writes holds them.
- **Nothing is left in the page.** Page snapshots, Playwright MCP's among them, include what a password field holds. So the script submits with the form's own button and, if the password or code is still in the page 10 seconds later, empties the field before `wait` returns.
- **Values go only to the origin the page names.** The tab and its origin are pinned when `ask` runs, and the page shows that origin. The origin check and the typing run in one `Runtime.evaluate`, so a navigation cannot land between them. A tab that moved gets nothing.
- **One link, one use.** The link carries a 256-bit token, works for one submission, and dies after 10 minutes (`--minutes`). The server listens on 127.0.0.1 only.
- **The page loads nothing.** No external scripts, styles or images, and a CSP that allows only its own inline script and its own origin.

What it does not protect against:

- **An agent that looks before `wait` returns.** Anything that can run JavaScript in the tab can read an input's value in the second between typing and submitting.
- **The tunnel.** With `--tunnel`, Cloudflare terminates TLS and could see values in transit. Use `--public` behind your own TLS if that matters.
- **A phishing tab.** If a prompt injection sends the agent to a look-alike site, the page shows that site's real origin. Read it before you fill.

## Limits

- Login forms inside a cross-origin iframe, or inside a closed shadow root, are not found.
- Passkeys and security keys cannot be handed over. The user has to complete those in the browser some other way.
- Fields are found by heuristics (`autocomplete`, type, name, label). An unusual form can fail with `No username field showed on …`.
- A browser without a DevTools port, such as an extension-driven one, is not supported.

## Test

```sh
npm test
```

Launches a headless Chrome (`$CHROME`, or the usual install paths) with a fresh profile on a random port, and runs two-step and moved-tab logins against a local fixture.

## License

MIT
