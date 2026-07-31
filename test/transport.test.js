import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { EllyAPI } from "../ellyApi.js";

test("TCP timeout reconnects instead of consuming a late response", { timeout: 5000 }, async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;

      while ((index = buffer.indexOf("\n")) >= 0) {
        const command = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);

        if (command === "TEL:OFF") socket.write("OK:tel_off\n");
        else if (command === "SLOW") {
          setTimeout(() => {
            if (!socket.destroyed) socket.write("OK:late\n");
          }, 150);
        } else if (command === "PING?") socket.write("OK:pong\n");
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const api = new EllyAPI({ host: "127.0.0.1", port: address.port });
  t.after(() => api.close());

  await api.connect();
  await assert.rejects(api.cmd("SLOW", 40), /timeout/);
  assert.equal(await api.ping(), "OK:pong");
});
