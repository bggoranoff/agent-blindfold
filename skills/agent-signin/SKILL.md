---
name: agent-signin
description: Sign your browser in to a website with a login the user types on a one-time page, so you never see their password or code. Use when a page in your browser asks for a username, password, verification code or 2FA code, or shows the user signed out of a site you need.
---

# Agent sign-in

You never handle the user's password or code. `signin.mjs` (next to this file) opens a one-time page where the user types them, often from their password manager. It types them into your browser tab itself and submits the form. You only learn which fields it typed.

It needs Node 22 and the Chromium you drive, reachable over its DevTools port: `$CDP_URL`, or `http://127.0.0.1:9222` by default.

## Steps

1. Open the site's sign-in page in your browser. Note which of `username`, `password` and `code` it asks for. A page that asks for the email first will ask for the password next: ask for both at once and the script types the password when it shows.
2. Ask the user:

   ```sh
   node <this folder>/signin.mjs ask username,password --tab <part of the tab's URL>
   ```

   It prints `{"id", "url", "origin", "fields", ...}` and returns at once.
   - **The user is at this machine:** the page has opened in their browser. Tell them it is there.
   - **The user is elsewhere** (you run on a server and they reach you through chat): add `--tunnel`, or `--public <url>` if the operator gave you one (`$SIGNIN_PUBLIC_URL` sets it for you). Send them the `url`.
3. Wait for them:

   ```sh
   node <this folder>/signin.mjs wait <id>
   ```

   It blocks until the user answers, cancels, or the link expires after 10 minutes. Run it in the background, or with a timeout over 10 minutes.
4. On `"status": "filled"`, look at the page:
   - Signed in: carry on with the task.
   - It asks for a code: go back to step 2 with `code`.
   - Wrong password, a field listed in `unused`, or `"cleared": true` with no error on the page: go back to step 2 and tell the user what the site said.
   - A CAPTCHA, a passkey or an approval in another app: ask the user to do it, then look again.
5. On `failed`, `cancelled` or `expired`, tell the user the `reason` in one line and stop.

## Rules

- Never ask for a password or code in chat. If the user sends one anyway, don't type it. Point them to the page.
- Never read back what the script typed: no reading a field's `value`, no screenshot of a revealed password.
- Don't look at the page while `wait` runs. Until it returns, the page may still hold the password, and a snapshot would show it.
- Never open the details or body of a request the sign-in sent, such as with `browser_network_request`. It holds the password.
- If the browser offers to save the password, decline.
- The page shows the user the exact origin the login goes to. If the tab moves to another site before they answer, nothing is typed: run `ask` again on the new page.
