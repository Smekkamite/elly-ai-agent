  // ellyApi.js (ESM)
  import { TcpLineClient } from "./tcpLineClient.js";

  export class EllyAPI {
    constructor({ host = "127.0.0.1", port = 25580 } = {}) {
      this.client = new TcpLineClient({ host, port });

      // Queue for ALL incoming lines (including unsolicited TEL:)
      this._queue = [];
      this._waiters = []; // { resolve, reject, timeoutId }

      // Serialize all commands to prevent response desync
      this._chain = Promise.resolve();

      this.client.on("line", (l) => {
        const line = String(l ?? "").trim();
        if (!line) return;

        const w = this._waiters.shift();
        if (w) w.resolve(line);
        else this._queue.push(line);

        // console.log("[RAW]", line);
      });

      this.client.on("error", (e) => this._failAll(e));
      this.client.on("close", () => this._failAll(new Error("socket_closed")));
    }

    _failAll(err) {
      while (this._waiters.length) {
        const w = this._waiters.shift();
        try { clearTimeout(w.timeoutId); } catch {}
        try { w.reject(err); } catch {}
      }
      this._queue = [];
    }
    async senseCrops(radius = 8, timeoutMs = 1600) {
    return this.cmd(`SENSE:CROPS? ${Math.trunc(radius)}`, timeoutMs);
    }

    async cropStatus(x, y, z, timeoutMs = 900) {
    return this.cmd(`CROP:STATUS ${Math.trunc(x)} ${Math.trunc(y)} ${Math.trunc(z)}`, timeoutMs);
    }

    async cropHarvest(x, y, z, timeoutMs = 900) {
      return this.cmd(`CROP:HARVEST ${Math.trunc(x)} ${Math.trunc(y)} ${Math.trunc(z)}`, timeoutMs);
   }

async cropPlant(x, y, z, timeoutMs = 900) {
  return this.cmd(`CROP:PLANT ${Math.trunc(x)} ${Math.trunc(y)} ${Math.trunc(z)}`, timeoutMs);
}
    async connect() {
      await this.client.connect();

      // Best effort: ensure telemetry streaming is OFF at startup
      await this.cmd("TEL:OFF", 1200).catch(() => null);
    }

    async close() {
      this.client.close();
    }

    // ------------------------------------------------------------
    // Low-level helpers
    // ------------------------------------------------------------
    _writeLine(line) {
      const s = String(line ?? "").trim();
      if (!s) return;
      // Use TcpLineClient (no direct socket access)
      this.client.writeLine(s);
    }

    _nextLine(timeoutMs = 1500) {
      if (this._queue.length) return Promise.resolve(this._queue.shift());

      return new Promise((resolve, reject) => {
        const w = {
          resolve: (line) => {
            clearTimeout(w.timeoutId);
            resolve(line);
          },
          reject: (err) => {
            clearTimeout(w.timeoutId);
            reject(err);
          },
          timeoutId: null,
        };

        w.timeoutId = setTimeout(() => {
          const idx = this._waiters.indexOf(w);
          if (idx >= 0) this._waiters.splice(idx, 1);
          reject(new Error("wait_line_timeout"));
        }, Math.max(50, timeoutMs));

        this._waiters.push(w);
      });
    }

    // Serialize any async operation
    _enqueue(fn) {
      const run = async () => fn();
      const p = this._chain.then(run, run);
      // keep chain alive even if rejected
      this._chain = p.catch(() => null);
      return p;
    }

    // Wait for first line matching predicate (optionally ignoring TEL spam)
    async _cmdExpect(line, timeoutMs, predicate, { ignoreTEL = false } = {}) {
      this._writeLine(line);

      const deadline = Date.now() + timeoutMs;

      while (true) {
        const left = Math.max(50, deadline - Date.now());
        if (left <= 0) throw new Error("cmd_timeout");

        const resp = await this._nextLine(left);

        if (ignoreTEL && typeof resp === "string" && resp.startsWith("TEL:")) {
          continue;
        }

        if (!predicate || predicate(resp)) return resp;
        // if not match, keep waiting (but do NOT re-send command)
      }
    }


    // ------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------
    async send(line, timeoutMs = 1500) {
      return await this.cmd(line, timeoutMs);
    }

    /**
     * cmd(): send once, wait first NON-TEL line.
     * IMPORTANT: serialized to prevent desync.
     */
    async cmd(line, timeoutMs = 1500) {
      return this._enqueue(() =>
        this._cmdExpect(line, timeoutMs, () => true, { ignoreTEL: true })
      );
    }

    /**
     * sendRaw(): if you truly want "next line whatever it is",
     * keep it, but STILL serialized.
     */
    async sendRaw(line, timeoutMs = 1500) {
      return this._enqueue(() =>
        this._cmdExpect(line, timeoutMs, () => true, { ignoreTEL: false })
      );
    }
    
      _splitChatText(text, maxLen = 180) {
    const out = [];
    let rest = String(text ?? "").replace(/\r?\n/g, " ").trim();

    while (rest.length > maxLen) {
      let cut = rest.lastIndexOf(" ", maxLen);
      if (cut <= 0) cut = maxLen;

      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }

    if (rest) out.push(rest);
    return out;
  }

    // ------------------------------------------------------------
    // Convenience methods
    // ------------------------------------------------------------
    ping() { return this.cmd("PING?"); }
    pos() { return this.cmd("ELLY:POS?"); }
    inv() { return this.cmd("INV?"); }
    has(itemId) { return this.cmd(`HAS:${itemId}`); }

    telOn() { return this.cmd("TEL:ON"); }
    telOff() { return this.cmd("TEL:OFF"); }

    // TEL:ONCE returns TEL:... so we MUST expect TEL:
    telOnce(timeoutMs = 1500) {
      return this._enqueue(() =>
        this._cmdExpect(
          "TEL:ONCE",
          timeoutMs,
          (l) => String(l).startsWith("TEL:"),
          { ignoreTEL: false }
        )
      );
    }

    senseHunger() { return this.cmd("SENSE:HUNGER?"); }
    senseTime() { return this.cmd("SENSE:TIME?"); }
    senseWeather() { return this.cmd("SENSE:WEATHER?"); }
    senseHostiles() { return this.cmd("SENSE:HOSTILES?"); }
    senseHostilesDetail(radius = 16) { return this.cmd(`SENSE:HOSTILES_DETAIL? ${radius}`, 2500); }
    sensePassivesDetail(radius = 16) { return this.cmd(`SENSE:PASSIVES_DETAIL? ${radius}`, 2500); }
    sensePlayerSleep(name) { return this.cmd(`SENSE:PLAYER_SLEEP? ${name}`, 1500); }
    senseBiome() { return this.cmd("SENSE:BIOME?"); }
    playerPos(name) { return this.cmd(`PLAYER:POS ${name}`, 1500); }
    senseChests(radius = 16) { return this.cmd(`SENSE:CHESTS? ${radius}`, 2500); }
    senseEnv(radius = 4, timeoutMs = 1500) {
    return this.cmd(`SENSE:ENV ${Math.trunc(radius)}`, timeoutMs);
    }
    
    invSelect(slot) { return this.cmd(`INV:SELECT ${slot}`); }
    invSwap(invSlot, hotbarSlot) { return this.cmd(`INV:SWAP ${invSlot} ${hotbarSlot}`); }
    equipBest(kind) { return this.cmd(`INV:EQUIPBEST ${kind}`); }

    drop(itemId, qty) { return this.cmd(`DROP:${itemId} ${qty}`); }

    chestOpen(x, y, z) { return this.cmd(`CHEST:OPEN ${x} ${y} ${z}`, 2500); }
    chestList() { return this.cmd("CHEST:LIST", 2500); }
    chestTake(slot, qty) { return this.cmd(`CHEST:TAKE ${slot} ${qty}`, 2500); }
    chestPut(invSlot, qty) { return this.cmd(`CHEST:PUT ${invSlot} ${qty}`, 2500); }
    chestPutMatch(what, qty) { return this.cmd(`CHEST:PUTMATCH ${what} ${qty}`, 2500); }
    chestClose() { return this.cmd("CHEST:CLOSE", 1500); }

    goto(x, y, z) { return this.cmd(`ELLY:GOTO ${x} ${y} ${z}`, 2500); }
    stop() { return this.cmd("ELLY:STOP", 2000); }
    follow(name) { return this.cmd(`ELLY:FOLLOW ${name}`, 2500); }

    attack() { return this.cmd("ELLY:ATTACK", 1000); }
    use() { return this.cmd("ELLY:USE", 1000); }

    useStart() { return this.cmd("USE:START", 1000); }
    useStop() { return this.cmd("USE:STOP", 1000); }
    attackStart() { return this.cmd("ATTACK:START", 1000); }
    attackStop() { return this.cmd("ATTACK:STOP", 1000); }
    
    eatBest(ms = 1400) { return this.cmd(`EAT:BEST ${ms}`, 2500); }

    lookAt(x, y, z) { return this.cmd(`LOOK:AT ${x} ${y} ${z}`, 1200); }
    lookYawPitch(yaw, pitch) { return this.cmd(`LOOK:YAWPITCH ${yaw} ${pitch}`, 1200); }
    lookPlayer(name) { return this.cmd(`LOOK:PLAYER ${name}`, 1200); }

    bedFind(radius = 10) { return this.cmd(`BED:FIND ${radius}`, 2500); }
    bedSleep(x, y, z) { return this.cmd(`BED:SLEEP ${x} ${y} ${z}`, 2500); }

    async say(text) {
      const parts = this._splitChatText(text, 180);

      for (const part of parts) {
        await this.cmd(`ELLY:SAY ${part}`, 1500);
      }

      return "OK:say_split";
    }

    chat(text) {
      return this.cmd(`CHAT:${String(text).replace(/\r?\n/g, " ")}`, 1500);
    }
  }