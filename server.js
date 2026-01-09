const http = require("http");
const { WebSocketServer } = require("ws");
const { URL } = require("url");

const {
  defaultConfig,
  buildDeck,
  shuffleDeck,
  deckSummary
} = require("./functions/deck");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

console.log("SERVER VERSION: lobby-v4-m2-deck");

const rooms = new Map();

function makeEmptyRoom(roomId) {
  return {
    roomId,
    createdAt: Date.now(),
    startedAt: null,
    phase: "lobby", // lobby | playing | complete (later)
    clients: new Set(),
    config: defaultConfig(),
    deck: null, // milestone 2: shuffled deck stored here at game start
    seats: [
      { seat: 1, clientId: null, isBot: false, ready: false },
      { seat: 2, clientId: null, isBot: false, ready: false },
      { seat: 3, clientId: null, isBot: false, ready: false },
      { seat: 4, clientId: null, isBot: false, ready: false },
    ],
  };
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, makeEmptyRoom(roomId));
  return rooms.get(roomId);
}

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  for (const c of room.clients) safeSend(c, obj);
}

function roomPublicState(room) {
  return {
    room_id: room.roomId,
    phase: room.phase,
    started_at: room.startedAt,
    seats: room.seats.map((s) => ({
      seat: s.seat,
      occupied: Boolean(s.clientId) || s.isBot,
      is_bot: s.isBot,
      ready: s.ready,
    })),
  };
}

function sendState(room) {
  broadcast(room, { type: "state_update", state: roomPublicState(room) });
}

function findSeatForClient(room, clientId) {
  return room.seats.find((s) => s.clientId === clientId) || null;
}

function sendYouAre(ws, room) {
  const seat = findSeatForClient(room, ws._clientId);
  safeSend(ws, {
    type: "you_are",
    room_id: room.roomId,
    seat: seat ? seat.seat : null,
  });
}

function leaveSeat(room, clientId) {
  for (const s of room.seats) {
    if (s.clientId === clientId) {
      s.clientId = null;
      s.ready = false;
      s.isBot = false;
    }
  }
}

function seatTake(room, seatNumber, clientId) {
  const seat = room.seats.find((s) => s.seat === seatNumber);
  if (!seat) return { ok: false, error: "invalid_seat" };
  if (seat.clientId || seat.isBot) return { ok: false, error: "seat_taken" };

  // changing seats auto-unreadies you: clear any existing seat first
  leaveSeat(room, clientId);

  seat.clientId = clientId;
  seat.ready = false;
  seat.isBot = false;

  return { ok: true };
}

function allFourSeatsOccupied(room) {
  return room.seats.every((s) => Boolean(s.clientId) || s.isBot);
}

function allFourSeatsReady(room) {
  return room.seats.every((s) => (Boolean(s.clientId) || s.isBot) && s.ready === true);
}

function resetAllReady(room) {
  for (const s of room.seats) s.ready = false;
}

function abortToLobby(room, reason) {
  if (room.phase !== "playing") return;

  room.phase = "lobby";
  room.startedAt = null;
  room.deck = null; // clear deck on abort
  resetAllReady(room);

  broadcast(room, {
    type: "game_aborted",
    room_id: room.roomId,
    reason: reason || "player_left",
    t: Date.now(),
  });

  sendState(room);
}

function startGame(room) {
  room.phase = "playing";
  room.startedAt = Date.now();

  // reset lobby readiness per your requirement
  resetAllReady(room);

  // ===== milestone 2: build + shuffle deck, store it =====
  const built = buildDeck(room.config);
  room.deck = shuffleDeck(built);

  const summary = deckSummary(room.deck, 8);
  console.log(`[${room.roomId}] deck built`, summary);

  // optional: send summary to clients for verification (no full deck)
  broadcast(room, {
    type: "deck_built",
    room_id: room.roomId,
    summary,
  });
  // ================================================

  broadcast(room, {
    type: "game_started",
    room_id: room.roomId,
    started_at: room.startedAt,
  });

  sendState(room);
}

function maybeStartGame(room) {
  if (room.phase !== "lobby") return;
  if (!allFourSeatsOccupied(room)) return;
  if (!allFourSeatsReady(room)) return;

  startGame(room);
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

const wss = new WebSocketServer({ server });

let nextClientId = 1;

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get("room");

  if (!roomId) {
    safeSend(ws, { type: "error", error: "missing_room_param" });
    ws.close();
    return;
  }

  const room = getOrCreateRoom(roomId);

  ws._clientId = `c${nextClientId++}`;
  ws._roomId = roomId;

  room.clients.add(ws);

  // initial sync
  sendState(room);
  sendYouAre(ws, room);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      safeSend(ws, { type: "error", error: "invalid_json" });
      return;
    }

    if (msg.type === "ping") {
      safeSend(ws, { type: "pong", t: Date.now() });
      return;
    }

    // leave room (client requested)
    if (msg.type === "leave_room") {
      leaveSeat(room, ws._clientId);
      abortToLobby(room, "leave_room");
      sendYouAre(ws, room);
      sendState(room);
      ws.close();
      return;
    }

    // seat selection
    if (msg.type === "seat_choose") {
      if (room.phase !== "lobby") {
        safeSend(ws, { type: "error", error: "not_in_lobby" });
        return;
      }

      const seatNum = Number(msg.seat);
      const res = seatTake(room, seatNum, ws._clientId);

      if (!res.ok) {
        safeSend(ws, { type: "error", error: res.error });
        return;
      }

      sendState(room);
      sendYouAre(ws, room);
      return;
    }

    // ready toggle
    if (msg.type === "ready_set") {
      if (room.phase !== "lobby") {
        safeSend(ws, { type: "error", error: "not_in_lobby" });
        return;
      }

      const desired = Boolean(msg.ready);
      const seat = findSeatForClient(room, ws._clientId);

      if (!seat) {
        safeSend(ws, { type: "error", error: "no_seat" });
        return;
      }

      seat.ready = desired;
      sendState(room);
      maybeStartGame(room);
      return;
    }

    safeSend(ws, { type: "error", error: "unknown_message_type" });
  });

  ws.on("close", () => {
    room.clients.delete(ws);

    const wasSeated = Boolean(findSeatForClient(room, ws._clientId));
    leaveSeat(room, ws._clientId);

    if (wasSeated) {
      abortToLobby(room, "disconnect");
    }

    if (room.clients.size > 0) {
      sendState(room);
    } else {
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Big Joker Spades WS running on ws://localhost:${PORT}`);
});