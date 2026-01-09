const http = require("http");
const { WebSocketServer } = require("ws");
const { URL } = require("url");

const {
  defaultConfig,
  buildDeck,
  shuffleDeck,
  deckSummary,
} = require("./functions/deck");

const { dealHands } = require("./functions/deal");
const { determineFirstDealerSeat } = require("./functions/dealer");

const {
  nextSeatClockwise,
  leftOfDealer,
  effectiveSuit,
  teamForSeat,
  determineTrickWinner,
} = require("./functions/trick");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

console.log("SERVER VERSION: playing-v1-m5-trick-engine");

const rooms = new Map();

function makeEmptyRoom(roomId) {
  return {
    roomId,
    createdAt: Date.now(),
    startedAt: null,
    phase: "lobby", // lobby | playing
    clients: new Set(),

    config: defaultConfig(),

    deck: null,
    hands: null,

    dealerSeat: null, // milestone 4a
    spadesBroken: false, // milestone 6 later

    // milestone 5
    trickIndex: 0, // 1..13 while playing
    turnSeat: null,
    currentTrick: null, // { leaderSeat, leadSuit, plays:[{seat, card}] }
    books: { A: 0, B: 0 },
    trickHistory: [],

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

function findSeatForClient(room, clientId) {
  return room.seats.find((s) => s.clientId === clientId) || null;
}

function roomPublicState(room) {
  return {
    room_id: room.roomId,
    phase: room.phase,
    started_at: room.startedAt,

    dealer_seat: room.dealerSeat,

    // milestone 5
    trick_index: room.trickIndex,
    turn_seat: room.turnSeat,
    books: room.books,
    current_trick: room.currentTrick
      ? {
          leader_seat: room.currentTrick.leaderSeat,
          lead_suit: room.currentTrick.leadSuit,
          plays: room.currentTrick.plays.map((p) => ({
            seat: p.seat,
            card_id: p.card.id,
          })),
        }
      : null,

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

function sendYouAre(ws, room) {
  const seat = findSeatForClient(room, ws._clientId);
  safeSend(ws, {
    type: "you_are",
    room_id: room.roomId,
    seat: seat ? seat.seat : null,
  });
}

function resetAllReady(room) {
  for (const s of room.seats) s.ready = false;
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

  // one seat per client
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
  return room.seats.every(
    (s) => (Boolean(s.clientId) || s.isBot) && s.ready === true
  );
}

function abortToLobby(room, reason) {
  if (room.phase !== "playing") return;

  room.phase = "lobby";
  room.startedAt = null;
  room.deck = null;
  room.hands = null;

  room.spadesBroken = false;

  // milestone 5 reset
  room.trickIndex = 0;
  room.turnSeat = null;
  room.currentTrick = null;
  room.books = { A: 0, B: 0 };
  room.trickHistory = [];

  resetAllReady(room);

  broadcast(room, {
    type: "game_aborted",
    room_id: room.roomId,
    reason: reason || "player_left",
    t: Date.now(),
  });

  sendState(room);
}

function sendPrivateHand(room, ws, seatNum) {
  const hand = room.hands?.[seatNum];
  if (!hand) return;

  safeSend(ws, {
    type: "hand_update",
    room_id: room.roomId,
    seat: seatNum,
    hand,
  });
}

function sendPrivateHandIfAvailable(room, ws) {
  if (room.phase !== "playing") return;
  if (!room.hands) return;

  const seatObj = findSeatForClient(room, ws._clientId);
  if (!seatObj) return;

  sendPrivateHand(room, ws, seatObj.seat);
}

function startGame(room) {
  room.phase = "playing";
  room.startedAt = Date.now();
  room.spadesBroken = false;

  // reset ready after lock-in
  resetAllReady(room);

  // ===== milestone 4a: first diamond deals =====
  if (room.dealerSeat === null) {
    const probeDeck = shuffleDeck(buildDeck(room.config));
    const probe = determineFirstDealerSeat(probeDeck);

    room.dealerSeat = probe.dealer_seat;

    console.log(
      `[${room.roomId}] first diamond deals -> dealer seat ${room.dealerSeat} (card=${probe.found_card_id}, index=${probe.dealt_index})`
    );

    broadcast(room, {
      type: "dealer_determined",
      room_id: room.roomId,
      dealer_seat: room.dealerSeat,
      found_card_id: probe.found_card_id, // debug ok
    });
  }

  // ===== milestone 2: build + shuffle (reshuffle) =====
  const built = buildDeck(room.config);
  room.deck = shuffleDeck(built);

  const summary = deckSummary(room.deck, 8);
  console.log(`[${room.roomId}] deck built`, summary);

  broadcast(room, {
    type: "deck_built",
    room_id: room.roomId,
    summary,
  });

  // ===== milestone 3: deal hands =====
  room.hands = dealHands(room.deck);

  broadcast(room, {
    type: "hands_dealt",
    room_id: room.roomId,
    counts: { 1: 13, 2: 13, 3: 13, 4: 13 },
  });

  for (const clientWs of room.clients) {
    sendPrivateHandIfAvailable(room, clientWs);
  }

  // ===== milestone 5: initialize trick engine =====
  room.trickIndex = 1;
  room.books = { A: 0, B: 0 };
  room.trickHistory = [];

  const firstLeader = leftOfDealer(room.dealerSeat);
  room.currentTrick = {
    leaderSeat: firstLeader,
    leadSuit: null, // effective suit
    plays: [],
  };
  room.turnSeat = firstLeader;

  broadcast(room, {
    type: "game_started",
    room_id: room.roomId,
    started_at: room.startedAt,
    first_turn_seat: room.turnSeat,
    trick_index: room.trickIndex,
  });

  sendState(room);
}

function maybeStartGame(room) {
  if (room.phase !== "lobby") return;
  if (!allFourSeatsOccupied(room)) return;
  if (!allFourSeatsReady(room)) return;
  startGame(room);
}

function requirePlaying(room, ws) {
  if (room.phase !== "playing") {
    safeSend(ws, { type: "error", error: "not_playing" });
    return false;
  }
  return true;
}

function handlePlayCard(room, ws, cardIdRaw) {
  if (!requirePlaying(room, ws)) return;

  const seatObj = findSeatForClient(room, ws._clientId);
  if (!seatObj) {
    safeSend(ws, { type: "error", error: "no_seat" });
    return;
  }

  const seatNum = seatObj.seat;

  if (room.turnSeat !== seatNum) {
    safeSend(ws, { type: "error", error: "not_your_turn" });
    return;
  }

  const cardId = String(cardIdRaw || "").trim();
  if (!cardId) {
    safeSend(ws, { type: "error", error: "missing_card_id" });
    return;
  }

  const hand = room.hands?.[seatNum];
  if (!Array.isArray(hand)) {
    safeSend(ws, { type: "error", error: "hand_missing" });
    return;
  }

  const idx = hand.findIndex((c) => c.id === cardId);
  if (idx === -1) {
    safeSend(ws, { type: "error", error: "card_not_in_hand" });
    return;
  }

  const [card] = hand.splice(idx, 1);

  // apply to current trick
  if (!room.currentTrick) {
    room.currentTrick = {
      leaderSeat: seatNum,
      leadSuit: null,
      plays: [],
    };
  }

  if (room.currentTrick.plays.length === 0) {
    room.currentTrick.leaderSeat = seatNum;
    room.currentTrick.leadSuit = effectiveSuit(card);
  }

  room.currentTrick.plays.push({ seat: seatNum, card });

  // spades broken tracking for later milestones
  if (card.is_trump) room.spadesBroken = true;

  broadcast(room, {
    type: "trick_update",
    room_id: room.roomId,
    trick_index: room.trickIndex,
    turn_seat: room.turnSeat,
    play: { seat: seatNum, card_id: card.id },
    lead_suit: room.currentTrick.leadSuit,
    plays_count: room.currentTrick.plays.length,
  });

  // if trick complete (4 plays)
  if (room.currentTrick.plays.length >= 4) {
    const winnerSeat = determineTrickWinner(room.currentTrick);
    const winnerTeam = teamForSeat(winnerSeat);

    room.books[winnerTeam] += 1;

    room.trickHistory.push({
      trick_index: room.trickIndex,
      lead_suit: room.currentTrick.leadSuit,
      plays: room.currentTrick.plays.map((p) => ({ seat: p.seat, card_id: p.card.id })),
      winner_seat: winnerSeat,
      winner_team: winnerTeam,
    });

    broadcast(room, {
      type: "trick_complete",
      room_id: room.roomId,
      trick_index: room.trickIndex,
      winner_seat: winnerSeat,
      winner_team: winnerTeam,
      books: room.books,
      plays: room.currentTrick.plays.map((p) => ({ seat: p.seat, card_id: p.card.id })),
    });

    // next trick or hand complete
    if (room.trickIndex >= 13) {
      broadcast(room, {
        type: "hand_complete",
        room_id: room.roomId,
        books: room.books,
        t: Date.now(),
      });

      // return to lobby (dev-friendly loop)
      abortToLobby(room, "hand_complete");
      return;
    }

    room.trickIndex += 1;
    room.currentTrick = {
      leaderSeat: winnerSeat,
      leadSuit: null,
      plays: [],
    };
    room.turnSeat = winnerSeat;

    sendState(room);
    return;
  }

  // advance turn
  room.turnSeat = nextSeatClockwise(room.turnSeat);

  // update just this player's hand
  sendPrivateHand(room, ws, seatNum);

  sendState(room);
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

  sendState(room);
  sendYouAre(ws, room);
  sendPrivateHandIfAvailable(room, ws);

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

    if (msg.type === "leave_room") {
      leaveSeat(room, ws._clientId);
      abortToLobby(room, "leave_room");
      sendYouAre(ws, room);
      sendState(room);
      ws.close();
      return;
    }

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

    if (msg.type === "play_card") {
      handlePlayCard(room, ws, msg.card_id);
      return;
    }

    if (msg.type === "stay_in_sync") {
      // always safe: resend public + private info
      sendState(room);
      sendYouAre(ws, room);
      sendPrivateHandIfAvailable(room, ws);
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