// tcpLineClient.js (ESM)
// Minimal TCP line transport: connects, writes, emits "line" events.
// IMPORTANT: No request/response logic here. EllyAPI handles waiting/queueing.

import net from "net";
import { EventEmitter } from "events";

export class TcpLineClient extends EventEmitter {
  constructor({ host = "127.0.0.1", port = 25580 } = {}) {
    super();
    this.host = host;
    this.port = port;

    this.socket = null;
    this.buffer = "";
    this._connecting = null; // Promise guard
  }

  async connect(timeoutMs = 2000) {
    // Already connected
    if (this.socket && !this.socket.destroyed) return;

    // If a connect is in progress, await it
    if (this._connecting) return await this._connecting;

    this._connecting = new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });

      const done = (fn) => {
        try { cleanup(); } catch {}
        this._connecting = null;
        fn();
      };

      const cleanup = () => {
        clearTimeout(t);
        s.off("error", onError);
        s.off("connect", onConnect);
      };

      const onError = (e) => {
        done(() => reject(e));
      };

      const onConnect = () => {
        cleanup();

        this.socket = s;
        this.buffer = "";
        s.setNoDelay(true);

        s.on("data", (d) => this._onData(d));
        s.on("error", (e) => this._onSocketError(e));
        s.on("close", () => this._onSocketClose());

        this._connecting = null;
        resolve();
      };

      const t = setTimeout(() => {
        try { s.destroy(new Error("connect_timeout")); } catch {}
      }, Math.max(50, timeoutMs));

      s.once("error", onError);
      s.once("connect", onConnect);
    });

    return await this._connecting;
  }

  close() {
    if (!this.socket) return;
    try { this.socket.end(); } catch {}
    try { this.socket.destroy(); } catch {}
    this.socket = null;
    this.buffer = "";
  }

  /**
   * Fire-and-forget write (NO wait).
   * EllyAPI will read responses via the "line" stream.
   */
  writeLine(cmd) {
    if (!this.socket || this.socket.destroyed) throw new Error("not_connected");
    const line = String(cmd ?? "").trim();
    if (!line) return;
    this.socket.write(line + "\n", "utf8");
  }

  _onData(d) {
    this.buffer += d.toString("utf8");

    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);

      if (!line) continue;
      this.emit("line", line);
    }
  }

  _onSocketError(e) {
    this.emit("error", e);
  }

  _onSocketClose() {
    this.emit("close");
    this.socket = null;
  }
}