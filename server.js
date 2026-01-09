// server.js
const http = require("http");
const { WebSocketServer } = require("ws");
const { URL } = require("url");

const { buildDeck, shuffleDeck } = require("./functions/deck");
const { dealHands } = require("./functions/deal");
const { determineFirstDealerSeat } = require("./functions/dealer");
const {
  leftOfDealer,
  nextSeatClockwise,
  effectiveSuit,
  teamForSeat,
  determineTrickWinner,
} = require("./functions/trick");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

console.log("SERVER VERSION: milestone-6A strict legality (renege OFF) + play_audit");

const rooms = new Map();

function makeEmptyRoom(roomId) {
  return {
    roomId,
    createdAt: Date.now(),
    phase: "lobby", // lobby | playing | complete

    clients: new Set(),

    seats: [
      { seat: 1, clientId: null, isBot: false, ready: false },
      { seat: 2, clientId: null, isBot: false, ready: false },
      { seat: 3, clientId: null, isBot: false, ready: false },
      { seat: 4, clientId: null, isBot: false, ready: false },
    ],

    config: {
      big_joker: "color", // "color" | "bw"
      big_deuce: "D2", // "D2" | "S2"
      // milestone-6A assumption: renege OFF (strict legality)
      renege_enabled: false,
    },

    dealer_seat: null,
    turn_seat: null,
    trick_index: 0, // 1..13
    books: { A: 0, B: 0 },

    // spades restriction tracker (ignored when renege ON later)
    spadesBroken: false,

    hands: { 1: [], 2: [], 3: [], 4: [] },

    current_trick: {
      leaderSeat: null,
      leadSuit: null,
      plays: [], // { seat, card }
    },

    trickHistory: [],

    // full audit per play (for future renege accusations + replay/debug)
    // entry: { t, trick_index, seat, card_id, lead_suit, hand_before:[card], hand_after:[card] }
    playAudit: [],
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

    seats: room.seats.map((s) => ({
      seat: s.seat,
      occupied: Boolean(s.clientId) || s.isBot,
      is_bot: s.isBot,
      ready: s.ready,
    })),

    dealer_seat: room.dealer_seat,
    turn_seat: room.turn_seat,
    trick_index: room.trick_index,
    books: room.books,

    // expose for debugging now; can hide later
    spades_broken: room.spadesBroken,

    current_trick: {
      leaderSeat: room.current_trick.leaderSeat,
      leadSuit: room.current_trick.leadSuit,
      plays: room.current_trick.plays.map((p) => ({
        seat: p.seat,
        card_id: p.card.id,
      })),
    },

    // last 20 tricks for UI history
    trick_history: room.trickHistory.slice(-20),
  };
}

function sendState(room) {
  broadcast(room, { type: "state_update", state: roomPublicState(room) });
}

function sendStateTo(ws, room) {
  safeSend(ws, { type: "state_update", state: roomPublicState(room) });
}

function sendYouAre(ws, room) {
  const seat = findSeatForClient(room, ws._clientId);
  safeSend(ws, {
    type: "you_are",
    room_id: room.roomId,
    seat: seat ? seat.seat : null,
  });
}

function sendHandUpdate(ws, room) {
  const seat = findSeatForClient(room, ws._clientId);
  const seatNum = seat ? seat.seat : null;

  safeSend(ws, {
    type: "hand_update",
    seat: seatNum,
    hand: seatNum ? room.hands[seatNum] : [],
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
  return room.seats.every((s) => (s.isBot ? true : Boolean(s.ready)));
}

function resetAllReady(room) {
  for (const s of room.seats) {
    if (!s.isBot) s.ready = false;
  }
}

function abortToLobby(room, reason) {
  room.phase = "lobby";
  room.dealer_seat = null;
  room.turn_seat = null;
  room.trick_index = 0;
  room.books = { A: 0, B: 0 };
  room.hands = { 1: [], 2: [], 3: [], 4: [] };
  room.current_trick = { leaderSeat: null, leadSuit: null, plays: [] };
  room.trickHistory = [];
  room.playAudit = [];
  room.spadesBroken = false;

  resetAllReady(room);

  broadcast(room, { type: "returned_to_lobby", room_id: room.roomId, reason });
  sendState(room);
}

function startGame(room) {
  // probe for first diamond deals
  const probeDeck = shuffleDeck(buildDeck(room.config));
  const probe = determineFirstDealerSeat(probeDeck);
  room.dealer_seat = probe.dealer_seat;

  // reshuffle and deal
  const liveDeck = shuffleDeck(buildDeck(room.config));
  room.hands = dealHands(liveDeck);

  room.phase = "playing";
  room.trick_index = 1;
  room.books = { A: 0, B: 0 };
  room.trickHistory = [];
  room.playAudit = [];
  room.spadesBroken = false;

  const firstLeader = leftOfDealer(room.dealer_seat);

  room.current_trick = {
    leaderSeat: firstLeader,
    leadSuit: null,
    plays: [],
  };

  room.turn_seat = firstLeader;

  broadcast(room, {
    type: "game_started",
    room_id: room.roomId,
    dealer_seat: room.dealer_seat,
    first_turn_seat: room.turn_seat,
    trick_index: room.trick_index,
  });

  sendState(room);

  for (const clientWs of room.clients) {
    sendHandUpdate(clientWs, room);
    sendYouAre(clientWs, room);
  }
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

/**
 * milestone 6A legality (renege OFF):
 * - must follow suit if possible
 * - spades/jokers/deuces (effectiveSuit=S) cannot be led until broken,
 *   unless the leader has ONLY spades/trump left
 * - if you cannot follow suit, you may play any card (including spade),
 *   and that breaks spades if effectiveSuit(card)==S
 */
function isLegalPlay(room, seatNum, card) {
  // if later we enable renege, legality gate becomes permissive
  if (room.config && room.config.renege_enabled) {
    return { ok: true };
  }

  const hand = room.hands?.[seatNum] || [];
  const trick = room.current_trick;
  const isLeaderPlay = !trick || !Array.isArray(trick.plays) || trick.plays.length === 0;

  const cardSuit = effectiveSuit(card); // "S" is trump in this game

  // leading a trick
  if (isLeaderPlay) {
    if (cardSuit === "S" && room.spadesBroken === false) {
      // allowed only if the player has ONLY spades/trump left
      const hasNonTrump = hand.some((c) => effectiveSuit(c) !== "S");
      if (hasNonTrump) {
        return { ok: false, error: "illegal_lead_spade" };
      }
    }
    return { ok: true };
  }

  // following in a trick
  const leadSuit = trick.leadSuit; // effective suit of first card played
  if (!leadSuit) {
    // should never happen, but be permissive
    return { ok: true };
  }

  const hasLeadSuit = hand.some((c) => effectiveSuit(c) === leadSuit);

  if (hasLeadSuit) {
    // must follow suit
    if (cardSuit !== leadSuit) {
      return { ok: false, error: "must_follow_suit" };
    }

    // if leadSuit isn't spade, and they are following suit properly, ok
    return { ok: true };
  }

  // cannot follow suit => any card allowed (including spade)
  return { ok: true };
}

function handlePlayCard(room, ws, cardIdRaw) {
  if (!requirePlaying(room, ws)) return;

  const seatObj = findSeatForClient(room, ws._clientId);
  if (!seatObj) return safeSend(ws, { type: "error", error: "no_seat" });

  const seatNum = seatObj.seat;

  if (room.turn_seat !== seatNum) {
    return safeSend(ws, { type: "error", error: "not_your_turn" });
  }

  const cardId = String(cardIdRaw || "").trim();
  if (!cardId) return safeSend(ws, { type: "error", error: "missing_card_id" });

  const hand = room.hands?.[seatNum];
  if (!Array.isArray(hand)) return safeSend(ws, { type: "error", error: "hand_missing" });

  const idx = hand.findIndex((c) => c.id === cardId);
  if (idx === -1) return safeSend(ws, { type: "error", error: "card_not_in_hand" });

  // we need the card object for legality check BEFORE removing
  const card = hand[idx];

  // legality gate (renege OFF)
  const legality = isLegalPlay(room, seatNum, card);
  if (!legality.ok) {
    return safeSend(ws, { type: "error", error: legality.error });
  }

  // ===== play audit snapshots (option B: full card objects) =====
  const handBefore = hand.map((c) => ({ ...c }));

  // remove card (use idx we already found)
  hand.splice(idx, 1);

  const handAfter = hand.map((c) => ({ ...c }));

  const leadSuitForAudit =
    room.current_trick && Array.isArray(room.current_trick.plays) && room.current_trick.plays.length > 0
      ? room.current_trick.leadSuit
      : effectiveSuit(card);

  room.playAudit.push({
    t: Date.now(),
    trick_index: room.trick_index,
    seat: seatNum,
    card_id: card.id,
    lead_suit: leadSuitForAudit,
    hand_before: handBefore,
    hand_after: handAfter,
  });

  if (room.playAudit.length > 500) room.playAudit = room.playAudit.slice(-500);
  // ============================================================

  // initialize trick if needed
  if (!room.current_trick) {
    room.current_trick = { leaderSeat: seatNum, leadSuit: null, plays: [] };
  }

  // set lead suit if first play of trick
  if (room.current_trick.plays.length === 0) {
    room.current_trick.leaderSeat = seatNum;
    room.current_trick.leadSuit = effectiveSuit(card);
  }

  // spades broken logic (ONLY when strict legality mode is on)
  // - if any spade/trump is legally played into a non-spade lead (or led when only-spades-left),
  //   spades become broken.
  if (!room.config.renege_enabled && room.spadesBroken === false) {
    if (effectiveSuit(card) === "S") {
      // if it's the first play and allowed only-spades-left, it breaks spades.
      // if it's a follow play because they couldn't follow suit, it breaks spades.
      room.spadesBroken = true;
    }
  }

  room.current_trick.plays.push({ seat: seatNum, card });

  broadcast(room, {
    type: "trick_update",
    room_id: room.roomId,
    trick_index: room.trick_index,
    play: { seat: seatNum, card_id: card.id },
    lead_suit: room.current_trick.leadSuit,
    plays_count: room.current_trick.plays.length,
    next_turn_seat:
      room.current_trick.plays.length >= 4 ? null : nextSeatClockwise(room.turn_seat),
  });

  // if trick complete
  if (room.current_trick.plays.length >= 4) {
    const winnerSeat = determineTrickWinner(room.current_trick);
    const winnerTeam = teamForSeat(winnerSeat);

    room.books[winnerTeam] = (room.books[winnerTeam] || 0) + 1;

    const completed = {
      trick_index: room.trick_index,
      lead_suit: room.current_trick.leadSuit,
      plays: room.current_trick.plays.map((p) => ({ seat: p.seat, card_id: p.card.id })),
      winner_seat: winnerSeat,
      winner_team: winnerTeam,
    };

    room.trickHistory.push(completed);

    broadcast(room, {
      type: "trick_complete",
      room_id: room.roomId,
      ...completed,
      books: room.books,
    });

    // 13 tricks -> end hand (dev loop)
    if (room.trick_index >= 13) {
      broadcast(room, {
        type: "hand_complete",
        room_id: room.roomId,
        books: room.books,
        t: Date.now(),
      });
      abortToLobby(room, "hand_complete");
      return;
    }

    // next trick
    room.trick_index += 1;
    room.current_trick = { leaderSeat: winnerSeat, leadSuit: null, plays: [] };
    room.turn_seat = winnerSeat;

    sendState(room);
    return;
  }

  // advance turn
  room.turn_seat = nextSeatClockwise(room.turn_seat);

  // private update to the player who just played
  sendHandUpdate(ws, room);

  // public state update to all
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

  // initial sync
  sendYouAre(ws, room);
  sendStateTo(ws, room);
  sendHandUpdate(ws, room);

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

    if (msg.type === "stay_in_sync") {
      sendYouAre(ws, room);
      sendStateTo(ws, room);
      sendHandUpdate(ws, room);
      safeSend(ws, { type: "sync_ok", t: Date.now() });
      return;
    }

    if (msg.type === "leave_room") {
      leaveSeat(room, ws._clientId);
      sendState(room);
      ws.close();
      return;
    }

    if (msg.type === "seat_choose") {
      if (room.phase !== "lobby") return safeSend(ws, { type: "error", error: "not_in_lobby" });

      const seatNum = Number(msg.seat);
      const res = seatTake(room, seatNum, ws._clientId);
      if (!res.ok) return safeSend(ws, { type: "error", error: res.error });

      sendYouAre(ws, room);
      sendState(room);
      sendHandUpdate(ws, room);
      return;
    }

    if (msg.type === "ready_set") {
      if (room.phase !== "lobby") return safeSend(ws, { type: "error", error: "not_in_lobby" });

      const seat = findSeatForClient(room, ws._clientId);
      if (!seat) return safeSend(ws, { type: "error", error: "no_seat" });

      seat.ready = Boolean(msg.ready);

      sendState(room);
      maybeStartGame(room);
      return;
    }

    if (msg.type === "play_card") {
      handlePlayCard(room, ws, msg.card_id);
      return;
    }

    safeSend(ws, { type: "error", error: "unknown_message_type" });
  });

  ws.on("close", () => {
    room.clients.delete(ws);

    leaveSeat(room, ws._clientId);

    if (room.clients.size === 0) {
      rooms.delete(room.roomId);
      return;
    }

    sendState(room);
  });
});

server.listen(PORT, () => {
  console.log(`Big Joker Spades WS running on ws://localhost:${PORT}`);
});