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

## Use

```sh
$ node signin.mjs ask username,password --tab linkedin.com --wait
{"id":"q3Zc1rT0","origin":"https://www.linkedin.com","fields":["username","password"],"status":"waiting","url":"http://127.0.0.1:53121/9fK…","expires":…}
{"origin":"https://www.linkedin.com","fields":["username","password"],"status":"filled","filled":["username","password"],"unused":[]}
```

Without `--wait`, `ask` returns at once and `wait <id>` blocks until the user answers. Either way the last line says `filled`, `failed`, `cancelled` or `expired`, and the command exits 0 only on `filled`.

| The page asks for | Command |
|---|---|
| Email or username and password, on one page or one after the other | `ask username,password` |
| A verification or 2FA code, in one box or one box per digit | `ask code` |
| Some characters of a password or memorable word, such as the 2nd, 5th and 7th | `ask password --characters 2,5,7` (or `secret`) |
| A PIN, security answer or memorable word | `ask secret --focused --label "Memorable word"` |
| A field the script does not find on its own, such as one inside an embedded frame from another site | `ask <field> --focused` |
| Clicking a link it emailed | `ask link` |
| The browser's own login dialog (HTTP authentication) | `ask username,password --dialog <url>` |

By default the script finds the fields itself. With `--focused`, the agent clicks into the field first and the script types there, after the same checks. For a site that asks for the email first, ask for both: the script types the email, submits, and types the password when the next page shows it. `"cleared": true` means the page still held a typed secret 10 seconds after submitting, so the script emptied the field.

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
- **Values go only to the site the page names.** The tab or frame and its origin are pinned when `ask` runs, and the page shows that origin, and the page around it when the field sits in a frame from another site. The origin check and the typing run in one evaluation, so a navigation cannot land between them. A tab that moved gets nothing.
- **A password goes only into a password field.** With `--focused`, a password is never typed into a field of another type, wherever the agent clicked.
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
- Fields are found by heuristics (`autocomplete`, type, name, label). When they miss, the agent clicks into the field and adds `--focused`.
- A field inside a closed shadow root, or two levels deep in frames from other sites, is not reached.
- A browser without a DevTools port, such as an extension-driven one, is not supported.

## Test

```sh
npm test
```

Launches a headless Chrome (`$CHROME`, or the usual install paths) with a fresh profile on a random port, and runs each kind of login against local fixtures: two-step, moved tab, a form that ignores Enter, a form that never submits, a field in a frame from another site, a password refused by a text field, picked characters, the login dialog, and an emailed link.

## License

MIT
