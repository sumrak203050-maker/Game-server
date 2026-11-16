const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const encoder = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function cleanText(value, max) {
  return String(value == null ? "" : value).replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, max);
}
function randomHex(bytes = 16) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, b => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(value) {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}
async function passwordDigest(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: fromHex(saltHex),
    iterations: 100000,
    hash: "SHA-256"
  }, key, 256);
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function publicRoom(room) {
  return {
    code: room.code,
    name: room.name,
    players: room.members.length,
    max: room.max,
    locked: room.visibility === "private",
    visibility: room.visibility,
    started: !!room.started,
    createdAt: room.createdAt
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hubId = env.LOBBY_HUB.idFromName("platy-dom-global");
    const hub = env.LOBBY_HUB.get(hubId);

    if (url.pathname === "/health") {
      return hub.fetch(new Request("https://lobby-hub/_internal/health"));
    }
    if (url.pathname === "/api/lobbies") {
      return hub.fetch(new Request("https://lobby-hub/_internal/list"));
    }
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return new Response("Origin not allowed", { status: 403 });
      return hub.fetch(request);
    }
    if (url.pathname === "/test") {
      return env.ASSETS.fetch(new Request(new URL("/test.html", url), request));
    }
    return env.ASSETS.fetch(request);
  }
};

export class LobbyHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/_internal/health") {
      const rooms = await this.readRooms();
      return json({ ok: true, service: "ПЛАТНЫЙ ДОМ", transport: "websocket", durableObjects: "sqlite", rooms: Object.keys(rooms).length, connectedClients: this.ctx.getWebSockets().length });
    }
    if (url.pathname === "/_internal/list") {
      return json({ ok: true, rooms: await this.listRooms() });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const id = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, roomCode: null, isHost: false });
    server.send(JSON.stringify({ type: "ready", id }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let payload;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      if (text.length > 300000) {
        ws.close(1009, "Message too large");
        return;
      }
      payload = JSON.parse(text);
    } catch {
      return;
    }
    if (!payload || payload.type !== "event" || typeof payload.event !== "string") return;

    const ack = value => {
      if (payload.ackId == null) return;
      try { ws.send(JSON.stringify({ type: "ack", id: payload.ackId, data: value })); } catch {}
    };

    try {
      const result = await this.handleEvent(ws, payload.event, payload.data || {});
      if (payload.ackId != null) ack(result === undefined ? { ok: true } : result);
    } catch (error) {
      console.error("[ws] event failed", payload.event, error);
      ack({ ok: false, error: "Ошибка сервера при обработке события" });
    }
  }

  async webSocketClose(ws, code, reason) {
    try { await this.leaveRoom(ws, reason || "Соединение закрыто"); } catch (error) { console.error("[ws] close cleanup failed", error); }
  }

  async webSocketError(ws, error) {
    try { await this.leaveRoom(ws, "Ошибка соединения"); } catch {}
    console.error("[ws] socket error", error);
  }

  async readRooms() {
    return (await this.ctx.storage.get("rooms")) || {};
  }

  async writeRooms(rooms) {
    await this.ctx.storage.put("rooms", rooms);
  }

  getAttachment(ws) {
    try { return ws.deserializeAttachment() || {}; } catch { return {}; }
  }

  setAttachment(ws, patch) {
    const current = this.getAttachment(ws);
    ws.serializeAttachment({ ...current, ...patch });
  }

  findSocket(id) {
    return this.ctx.getWebSockets().find(ws => {
      const attachment = this.getAttachment(ws);
      return attachment.id === id && ws.readyState === 1;
    }) || null;
  }

  sendEvent(id, event, data) {
    const ws = this.findSocket(id);
    if (!ws) return false;
    try {
      ws.send(JSON.stringify({ type: "event", event, data }));
      return true;
    } catch {
      return false;
    }
  }

  broadcastEvent(event, data) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      try { ws.send(JSON.stringify({ type: "event", event, data })); } catch {}
    }
  }

  async listRooms() {
    const rooms = await this.readRooms();
    return Object.values(rooms)
      .filter(room => !room.started && room.members.length < room.max)
      .map(publicRoom)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async announceRoomList() {
    this.broadcastEvent("lobby:list-changed", {});
  }

  async makeCode(rooms) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let attempt = 0; attempt < 100; attempt++) {
      const bytes = new Uint8Array(5);
      crypto.getRandomValues(bytes);
      let code = "";
      for (const byte of bytes) code += alphabet[byte % alphabet.length];
      if (!rooms[code]) return code;
    }
    throw new Error("Не удалось выделить код комнаты");
  }

  async leaveRoom(ws, reason) {
    const attachment = this.getAttachment(ws);
    const code = attachment.roomCode;
    if (!code) return;
    const rooms = await this.readRooms();
    const room = rooms[code];
    this.setAttachment(ws, { roomCode: null, isHost: false });
    if (!room) return;

    if (room.hostId === attachment.id) {
      delete rooms[code];
      await this.writeRooms(rooms);
      for (const memberId of room.members) {
        if (memberId === attachment.id) continue;
        const member = this.findSocket(memberId);
        if (!member) continue;
        this.sendEvent(memberId, "lobby:closed", { reason: reason || "Создатель закрыл лобби" });
        this.setAttachment(member, { roomCode: null, isHost: false });
        try { member.close(4000, "Lobby closed"); } catch {}
      }
      await this.announceRoomList();
      return;
    }

    room.members = room.members.filter(id => id !== attachment.id);
    await this.writeRooms(rooms);
    this.sendEvent(room.hostId, "lobby:player-left", { id: attachment.id });
    await this.announceRoomList();
  }

  async handleEvent(ws, event, data) {
    const attachment = this.getAttachment(ws);
    const id = attachment.id;

    if (event === "test:echo") {
      return { ok: true, echo: cleanText(data.text, 120), socketId: id, transport: "websocket", serverTime: new Date().toISOString() };
    }
    if (event === "lobby:list") {
      return { ok: true, rooms: await this.listRooms() };
    }
    if (event === "lobby:create") {
      if (attachment.roomCode) await this.leaveRoom(ws, "Создано новое лобби");
      const rooms = await this.readRooms();
      const name = cleanText(data.name, 24) || "Новый дом";
      const max = Math.max(2, Math.min(10, Math.floor(Number(data.max) || 6)));
      const visibility = data.visibility === "private" ? "private" : "public";
      const password = String(data.password || "");
      if (visibility === "private" && password.trim().length < 4) {
        return { ok: false, error: "Пароль закрытого лобби должен содержать минимум 4 символа" };
      }
      const code = await this.makeCode(rooms);
      const salt = visibility === "private" ? randomHex(16) : "";
      const hash = visibility === "private" ? await passwordDigest(password, salt) : "";
      const room = {
        code, name, max, visibility, passwordSalt: salt, passwordHash: hash,
        hostId: id, members: [id], started: false, createdAt: Date.now()
      };
      rooms[code] = room;
      await this.writeRooms(rooms);
      this.setAttachment(ws, { roomCode: code, isHost: true });
      await this.announceRoomList();
      console.log("[lobby] created", code, visibility);
      return { ok: true, id, room: publicRoom(room) };
    }
    if (event === "lobby:join") {
      const code = cleanText(data.code, 8).toUpperCase();
      const rooms = await this.readRooms();
      const room = rooms[code];
      if (!room) return { ok: false, error: "Лобби не найдено. Возможно, создатель уже вышел." };
      if (room.started) return { ok: false, error: "Игра уже началась — войти нельзя." };
      if (room.members.length >= room.max) return { ok: false, error: "Лобби заполнено." };
      if (room.visibility === "private") {
        const candidate = await passwordDigest(String(data.password || ""), room.passwordSalt);
        if (!safeEqual(candidate, room.passwordHash)) return { ok: false, error: "Неверный пароль от закрытого лобби." };
      }
      if (attachment.roomCode) await this.leaveRoom(ws, "Игрок перешёл в другое лобби");
      const latest = await this.readRooms();
      const currentRoom = latest[code];
      if (!currentRoom || currentRoom.started || currentRoom.members.length >= currentRoom.max) {
        return { ok: false, error: "Лобби уже недоступно или заполнено." };
      }
      currentRoom.members.push(id);
      latest[code] = currentRoom;
      await this.writeRooms(latest);
      this.setAttachment(ws, { roomCode: code, isHost: false });
      const response = { ok: true, id, room: publicRoom(currentRoom) };
      const hello = {
        t: "hello",
        name: cleanText(data.name || "Игрок", 14) || "Игрок",
        look: data.look && typeof data.look === "object" ? data.look : {}
      };
      this.sendEvent(currentRoom.hostId, "game:member-message", { id, m: hello });
      await this.announceRoomList();
      return response;
    }
    if (event === "lobby:update") {
      const rooms = await this.readRooms();
      const room = rooms[attachment.roomCode];
      if (!room || room.hostId !== id) return { ok: false, error: "Только создатель может обновлять лобби" };
      room.name = cleanText(data.name || room.name, 24) || room.name;
      room.max = Math.max(room.members.length, Math.min(10, Math.max(2, Math.floor(Number(data.max) || room.max))));
      room.started = !!data.started;
      await this.writeRooms(rooms);
      await this.announceRoomList();
      return { ok: true };
    }
    if (event === "game:to-host") {
      const rooms = await this.readRooms();
      const room = rooms[attachment.roomCode];
      if (!room || room.hostId === id || !room.members.includes(id)) return;
      this.sendEvent(room.hostId, "game:member-message", { id, m: data });
      return;
    }
    if (event === "game:to-player") {
      const rooms = await this.readRooms();
      const room = rooms[attachment.roomCode];
      if (!room || room.hostId !== id) return;
      const target = String(data.id || "");
      if (!room.members.includes(target) || target === id) return;
      this.sendEvent(target, "game:host-message", data.message);
      return;
    }
    if (event === "game:kick-player") {
      const rooms = await this.readRooms();
      const room = rooms[attachment.roomCode];
      if (!room || room.hostId !== id) return;
      const target = String(data.id || "");
      if (!room.members.includes(target) || target === id) return;
      const targetSocket = this.findSocket(target);
      this.sendEvent(target, "game:kicked", { reason: "Хост отключил вас от лобби" });
      if (targetSocket) {
        await this.leaveRoom(targetSocket, "Хост отключил вас от лобби");
        try { targetSocket.close(4001, "Kicked by host"); } catch {}
      }
      return;
    }
    if (event === "voice:signal") {
      const rooms = await this.readRooms();
      const room = rooms[attachment.roomCode];
      if (!room || !room.members.includes(id)) return;
      const target = String(data.to || "");
      if (!room.members.includes(target) || target === id || !data.data || typeof data.data !== "object") return;
      this.sendEvent(target, "voice:signal", { from: id, data: data.data });
      return;
    }
    if (event === "lobby:leave") {
      await this.leaveRoom(ws, "Игрок покинул лобби");
      return { ok: true };
    }
    if (event === "ping") return { ok: true, pong: true };
    return { ok: false, error: "Неизвестное событие: " + event };
  }
}
