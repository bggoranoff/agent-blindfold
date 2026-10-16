// Every login in signin.test.mjs again, with signin.mjs reaching the browser through the companion extension.
process.env.AGENT_SIGNIN_TEST_EXTENSION = "1";
await import("./signin.test.mjs");
