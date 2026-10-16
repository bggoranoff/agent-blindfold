---
name: agent-blindfold
description: Sign your browser in to a website with a login the user enters in a sign-in window or on a one-time page, so you never see their password, code or sign-in link. Use when a page in your browser asks for a username, password, verification or 2FA code, PIN, security answer or emailed sign-in link, when the browser shows its own login dialog, or when the user is signed out of a site you need.
---

# Agent Blindfold

You never handle the user's secrets. `signin.mjs`, next to this file, shows the user a sign-in window, or a one-time page, that their password manager can fill. It types what they enter into your browser tab itself and submits. You only learn which fields it typed. Run it as shown here; there is no need to read it or check your setup first.

It reaches your Chromium over its DevTools port: `$CDP_URL`, or `http://127.0.0.1:9222`. If you browse in the user's own Chrome through an extension, such as Claude in Chrome, add `--cdp extension`: it then goes through agent-blindfold's companion extension, which the user installs once. It works only in those browsers. If you browse with something else, such as a built-in browser, open the site with the tools that drive one of them instead, such as a Playwright MCP server connected to it, and sign in there.

## 1. Pick the command

Look at the page, then pick a row.

| The page asks for | Command |
|---|---|
| An email, username, password or verification code box | `ask`. It finds the boxes the page shows now; when the site asks for the email first, ask again on the password page. |
| Some characters of a password or memorable word, such as the 2nd, 5th and 7th | `ask password --characters 2,5,7`, or `secret` instead of `password` |
| A PIN, security answer or memorable word | click into the box, then `ask secret --focused --label "<the page's name for it>"` |
| A box `ask` misses or gets wrong, such as one inside an embedded frame | click into it, then `ask <username, password or code> --focused` |
| Clicking a link it emailed | `ask link` |
| The browser's own login dialog, not a web page | `ask --dialog <the URL you opened>` |

Add `--tab <part of the tab's URL>` when more than one tab is open, as there always is in the user's own Chrome.

## 2. Ask

The command is `node <this folder>/signin.mjs ask ...`.

Add `--tunnel`, unless `$SIGNIN_PUBLIC_URL` is set, which gives the link a public address itself. It prints `{"id", "url", ...}` at once. Send the user the `url` in one line. If you run on the user's own Mac, add that a sign-in window opens there too, and either one works. Then run `node <this folder>/signin.mjs wait <id>` with a 10-minute timeout. It returns once they answer.

If `ask` says `--tunnel needs cloudflared`, run it again without `--tunnel` and with `--wait`, and tell the user a sign-in window is opening.

## 3. Read the result

The last line is `{"status": ..., "filled": [...], ...}`.

- `filled`: look at the page.
  - Signed in: carry on.
  - It asks for something more, such as the password after the email, or a code: back to step 1.
  - Wrong password, or `"cleared": true` with no error showing: back to step 1, and tell the user what the site said.
  - A CAPTCHA, a passkey or an approval in another app: ask the user to do it, then look again.
- `failed`, `cancelled` or `expired`: tell the user the `reason` in one line and stop. If `ask` itself says what to do instead, such as clicking into a box, do that and ask again.

## Rules

- Never ask for a password, code or sign-in link in chat. If the user sends one anyway, don't use it; point them to the sign-in window or page.
- Don't look at the page until the command returns. Until then the page may still hold the password.
- Never read back what the script typed: no reading a field's value, no opening the details or body of a request the sign-in sent, no screenshot of a revealed password.
- If the browser offers to save the password, decline.
- The window or page shows the user the exact site it types into. If the tab moves to another site first, nothing is typed: ask again on the new page.
