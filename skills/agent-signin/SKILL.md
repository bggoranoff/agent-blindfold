---
name: agent-signin
description: Sign your browser in to a website with a login the user enters on a one-time page, so you never see their password, code or sign-in link. Use when a page in your browser asks for a username, password, verification or 2FA code, PIN, security answer or emailed sign-in link, when the browser shows its own login dialog, or when the user is signed out of a site you need.
---

# Agent sign-in

You never handle the user's secrets. `signin.mjs`, next to this file, shows the user a one-time page their password manager can fill. It types what they enter into your browser tab itself and submits. You only learn which fields it typed. Run it as shown here; there is no need to read it or check your setup first.

It reaches your Chromium over its DevTools port: `$CDP_URL`, or `http://127.0.0.1:9222`. It works only in that browser. If you browse with something else, such as a built-in or extension browser, open the site with the tools that drive that Chromium instead, such as a Playwright MCP server connected to it, and sign in there.

## 1. Pick the command

Look at the page, then pick a row.

| The page asks for | Command |
|---|---|
| Email or username and password, on one page or one after the other | `ask username,password` |
| A verification or 2FA code | `ask code` |
| Some characters of a password or memorable word, such as the 2nd, 5th and 7th | `ask password --characters 2,5,7`, or `secret` instead of `password` |
| A PIN, security answer or memorable word | click into the field, then `ask secret --focused --label "<the page's name for it>"` |
| A field the rows above miss, such as one inside an embedded frame | click into it, then `ask <field> --focused` |
| Clicking a link it emailed | `ask link` |
| The browser's own login dialog, not a web page | `ask username,password --dialog <the URL you opened>` |

Add `--tab <part of the tab's URL>` when more than one tab is open.

## 2. Ask

The command is `node <this folder>/signin.mjs ask ...`.

- **The user is at this machine:** add `--wait` and give it a 10-minute timeout. Tell the user in one line that a sign-in window is opening, then run it. It returns once they answer.
- **The user is elsewhere** (you run on a server and they reach you through chat): add `--tunnel`, or `--public <url>` if the operator set one (`$SIGNIN_PUBLIC_URL` does it for you). It prints `{"id", "url", ...}` at once. Send them the `url`, then run `node <this folder>/signin.mjs wait <id>` with a 10-minute timeout.

## 3. Read the result

The last line is `{"status": ..., "filled": [...], ...}`.

- `filled`: look at the page.
  - Signed in: carry on.
  - It asks for something more, such as a code: back to step 1.
  - Wrong password, a field in `unused`, or `"cleared": true` with no error showing: back to step 1, and tell the user what the site said.
  - A CAPTCHA, a passkey or an approval in another app: ask the user to do it, then look again.
- `failed`, `cancelled` or `expired`: tell the user the `reason` in one line and stop.

## Rules

- Never ask for a password, code or sign-in link in chat. If the user sends one anyway, don't use it; point them to the page.
- Don't look at the page until the command returns. Until then the page may still hold the password.
- Never read back what the script typed: no reading a field's value, no opening the details or body of a request the sign-in sent, no screenshot of a revealed password.
- If the browser offers to save the password, decline.
- The page shows the user the exact site it types into. If the tab moves to another site first, nothing is typed: ask again on the new page.
