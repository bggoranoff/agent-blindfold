# agent-signin

Let a browser agent sign in to websites without your password, code or sign-in link ever passing through it.

When the agent hits a login, it runs one command. A one-time page pops up for you, or arrives as a link if the agent runs on a server. You fill it from your password manager. The script types what you entered into the agent's browser tab itself, on the site the page named, and submits. The agent only learns which fields were typed.

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

The agent's browser must be a Chromium with a DevTools port, which is how Playwright MCP, Chrome DevTools MCP and Browser Use drive it anyway. Give it its own profile, with password saving off so no password stays in it:

```sh
mkdir -p ~/.agent-browser/Default
echo '{"credentials_enable_service":false,"profile":{"password_manager_enabled":false}}' > ~/.agent-browser/Default/Preferences
```

Then give your agents a browser tool that starts that Chrome when it is not running yet. On macOS, save this as `~/.local/bin/agent-browser-mcp` and make it executable:

```sh
#!/bin/sh
PORT=9222
up() { curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null; }
if ! up; then
  open -gna "Google Chrome" --args --remote-debugging-port=$PORT --user-data-dir="$HOME/.agent-browser" --no-first-run
  for _ in $(seq 40); do up && break; sleep 0.25; done
fi
exec npx -y @playwright/mcp --cdp-endpoint "http://127.0.0.1:$PORT"
```

```sh
claude mcp add --scope user browser -- ~/.local/bin/agent-browser-mcp   # Claude Code
codex mcp add browser -- ~/.local/bin/agent-browser-mcp                 # Codex
```

Set `CDP_URL` when the port is not `http://127.0.0.1:9222`.

Codex runs commands in a sandbox that blocks the DevTools port. Let only this script out with a rule, for example in `~/.codex/rules/agent-signin.rules`:

```
prefix_rule(pattern = ["node", "/path/to/agent-signin/skills/agent-signin/signin.mjs"], decision = "allow")
```

Codex also asks before it first uses the browser tool. Approve it then, or set `default_tools_approval_mode = "approve"` under `[mcp_servers.browser]`.

## Use

```sh
$ node signin.mjs ask --tab linkedin.com --wait
{"id":"q3Zc1rT0","origin":"https://www.linkedin.com","fields":["username","password"],"status":"waiting","url":"http://127.0.0.1:53121/9fK…","expires":…}
{"origin":"https://www.linkedin.com","fields":["username","password"],"status":"filled","filled":["username","password"],"unused":[]}
```

Without `--wait`, `ask` returns at once and `wait <id>` blocks until the user answers. Either way the last line says `filled`, `failed`, `cancelled` or `expired`, and the command exits 0 only on `filled`.

| The page asks for | Command |
|---|---|
| An email, username, password or verification code box (a code may be one box per digit) | `ask` |
| Some characters of a password or memorable word, such as the 2nd, 5th and 7th | `ask password --characters 2,5,7` (or `secret`) |
| A PIN, security answer or memorable word | `ask secret --focused --label "Memorable word"` |
| A box `ask` misses or gets wrong, such as one inside an embedded frame from another site | `ask <username, password or code> --focused` |
| Clicking a link it emailed | `ask link` |
| The browser's own login dialog (HTTP authentication) | `ask --dialog <url>` |

`ask` finds the boxes the page shows when it runs, and the user's page asks for exactly those, labelled in the site's own words. The script keeps DevTools references to those boxes and types into them and nowhere else: if one has gone or been swapped by the time the user answers, nothing is typed. A site that asks for the email first gets one page for the email and, once the password page shows, another for the password. With `--focused`, the agent clicks into the box first and the script uses that box instead. `"cleared": true` means the page still held a typed secret 10 seconds after submitting, so the script emptied the box.

### Local and remote agents

| The agent runs | The user gets the page | Flag |
|---|---|---|
| On the user's machine | A small window in their default browser, which closes itself once answered (a tab if the browser is not Chromium-based; `$BROWSER` overrides) | none |
| On a server, behind your own HTTPS reverse proxy | A link the agent sends them | `--public https://box.example.com/signin` |
| On a server, nothing set up | A link through a Cloudflare quick tunnel | `--tunnel` (needs `cloudflared`) |

Use `--tunnel` to try it out and `--public` for real passwords. Both are HTTPS from the user's phone to the server, but a quick tunnel is decrypted on Cloudflare's servers on the way, and `--public` is decrypted only on yours. The last hops, to the script and to the browser, stay on the server's loopback.

With `--public` the page listens on `127.0.0.1:8769` (`--port` changes it). Point the proxy at it, prefix and all. For example, with Caddy:

```
box.example.com {
	reverse_proxy /signin/* 127.0.0.1:8769
}
```

`SIGNIN_PUBLIC_URL` sets `--public` for every call, so the agent does not need to know it.

## Security model

- **The agent never receives a value.** Values go from the page to the script's server process, which holds them in memory for one fill and then exits. Nothing it prints or writes holds them.
- **Nothing is left in the page.** Page snapshots, Playwright MCP's among them, include what a password field holds. So the script submits with the form's own button and, if a typed secret is still in the page 10 seconds later, empties the field before the agent hears back.
- **Values go only into the boxes the page named.** The boxes, their frame and its origin are pinned when `ask` runs, and the page shows that origin, and the page around it when the box sits in a frame from another site. The origin check and the typing run in one evaluation in an isolated world, so neither a navigation nor the page's own scripts can land between them. A tab that moved, or a box that was swapped, gets nothing.
- **A password goes only into a password box.** A password is never typed into a box of another type, nor into a password box that has been switched to show its text.
- **One link, one use.** The link carries a 256-bit token, works for one submission, and dies after 10 minutes (`--minutes`). The server listens on 127.0.0.1 only.
- **The page loads nothing.** No external scripts, styles or images, and a CSP that allows only its own inline script and its own origin.

What it does not protect against:

- **An agent that sets out to get it.** The agent drives the same browser, and usually has a shell on the same machine. It could read the field in the second before submit, read the request body (Playwright MCP's `browser_network_request` returns it), or swap the script. The promise is that the password never passes through the agent in normal use, not that a hostile agent cannot reach it.
- **The login dialog's password afterwards.** With HTTP authentication the browser resends the password with every request to that site, where any tool that lists requests can show it.
- **An opened link.** Once a sign-in link is open, its address is in the agent's tab. Most such links work only once.
- **The tunnel.** With `--tunnel`, Cloudflare could see values in transit. Use `--public` for real passwords.
- **A phishing tab.** If a prompt injection sends the agent to a look-alike site, the page shows that site's real origin. Read it before you fill.

## Limits

- Passkeys, security keys and biometrics cannot be handed over. The user completes those in the agent's browser some other way.
- Boxes are found by heuristics (`autocomplete`, type, name, label). When they miss, or the page shows two password boxes, the agent clicks into the box and adds `--focused`.
- A field inside a closed shadow root, or two levels deep in frames from other sites, is not reached.
- A browser without a DevTools port, such as an extension-driven one, is not supported.

## Test

```sh
npm test
```

Launches a headless Chrome (`$CHROME`, or the usual install paths) with a fresh profile on a random port, and runs each kind of login against local fixtures: two-step, a swapped box, moved tab, a form that ignores Enter, a form that never submits, a box in a frame from another site, a password refused by a text box, picked characters, the login dialog, and an emailed link.

## License

MIT
