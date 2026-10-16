// Chrome starts this for the agent-signin extension; it carries messages between the extension and signin.mjs.
import { mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const DIRECTORY = join(tmpdir(), "agent-signin");
const SOCKET = join(DIRECTORY, "extension.sock");
const RETRY_MS = 5000;
const clients = new Map();
let next = 0;
let input = Buffer.alloc(0);

// Native messaging frames each message with a 4-byte length in native byte order, little-endian wherever Chrome runs.
function post(message) {
  const body = Buffer.from(JSON.stringify(message));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([length, body]));
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4 && input.length >= 4 + input.readUInt32LE(0)) {
    const end = 4 + input.readUInt32LE(0);
    const { client, ...message } = JSON.parse(input.toString("utf8", 4, end));
    input = input.subarray(end);
    clients.get(client)?.write(`${JSON.stringify(message)}\n`);
  }
});
// Chrome closes the pipe when the extension lets go of the host.
process.stdin.on("end", () => process.exit());

const server = createServer((socket) => {
  const client = ++next;
  clients.set(client, socket);
  createInterface({ input: socket }).on("line", (line) => post({ client, ...JSON.parse(line) }));
  // A signin.mjs that exits mid-message must not take the host down with it.
  socket.on("error", () => {});
  socket.on("close", () => clients.delete(client));
});

// Another Chrome profile's host may already serve the socket: this one waits for it to go, and only clears a dead one.
function claim() {
  server.once("error", async (error) => {
    if (error.code !== "EADDRINUSE") throw error;
    const live = await new Promise((resolve) => {
      createConnection(SOCKET).on("connect", function () {
        this.destroy();
        resolve(true);
      }).on("error", () => resolve(false));
    });
    if (!live) rmSync(SOCKET, { force: true });
    setTimeout(claim, live ? RETRY_MS : 0);
  });
  server.listen(SOCKET);
}

mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 });
claim();
