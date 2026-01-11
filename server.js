/**
 * Big Joker Spades WS Server
 * server.js
 *
 * - bidding + negotiation logic lives in functions/bidding.js
 * - server delegates ws messages to bidding module
 */

const http = require("http");
const WebSocket = require("ws");
const url = require("url");
const crypto = require("crypto");

const { buildDeck, shuffleDeck } = require("./functions/deck");
const { dealHands } = require("./functions/deal");
const { determineFirstDealerSeat } = require("./functions/dealer");
const trick = require("./functions/trick");

const bidding = require("./functions/bidding");

const PORT = Number(process.env.PORT || 3001);

// =====================================================
// in-memory rooms
// =====================================================
const rooms = new Map(); // roomId -> room object

function uid() {
  return crypto.randomBytes(12).toString("hex");
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  room.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function teamForSeat(seatNum) {
  // 1+3 = A, 2+4 = B
  if (seatNum === 1 || seatNum === 3) return "A";
  if (seatNum === 2 || seatNum === 4) return "B";
  return null;
}

function dealingTeam(room) {
  return teamForSeat(room.dealer_seat);
}

function nonDealingTeam(room) {
  const d = dealingTeam(room);
  return d === "A" ? "B" : "A";
}

function findSeatForClient(room, clientId) {
  for (const [seatStr, seat] of Object.entries(room.seats)) {
    if (seat && seat.clientId === clientId) {
      return { seat: Number(seatStr), seatObj: seat };
    }
  }
  return null;
}

function rotateDealer(room) {
  room.dealer_seat = room.dealer_seat % 4 === 0 ? 1 : room.dealer_seat + 1;
}

// =====================================================
// room template
// =====================================================
function makeEmptyRoom(roomId) {
  return {
    roomId,

    // connected ws clients
    clients: new Set(),

    // seat state
    seats: {
      1: null,
      2: null,
      3: null,
      4: null,
    },

    // match config + game config
    match_config: {
      target_score: 500,
      board: 4,
      min_total_bid: 11,
      // if true: first hand is allowed to bid itself, so books_made is NOT available on first hand
      // if false: first hand does NOT bid itself, so books_made is available if negotiation happens on first hand
      first_hand_bids_itself: true,
    },

    config: {
      // UI sorting config (your existing UI reads these)
      big_joker: "color", // "color" | "bw"
      big_deuce: "D2", // "D2" | "S2"
    },

    // match state
    match: {
      target_score: 500,
      hand_number: 0,
      score: { A: 0, B: 0 },
    },

    // hand state
    hand_number: 0,
    phase: "lobby", // lobby | bidding | negotiating | playing | complete

    dealer_seat: 1,
    turn_seat: null,
    spades_broken: false,

    books: { A: 0, B: 0 },

    // cards
    deck: [],
    hands: { 1: [], 2: [], 3: [], 4: [] },

    // trick state (shape consumed by your UI)
    current_trick: {
      leaderSeat: null,
      leadSuit: null,
      plays: [],
    },
    trick_index: 0,
    trick_history: [],

    // bidding state (owned by functions/bidding.js)
    bidding: null,
    final_bids: null,
  };
}

// =====================================================
// public state for UI
// =====================================================
function roomPublicState(room) {
  return {
    room_id: room.roomId,

    phase: room.phase,
    dealer_seat: room.dealer_seat,
    turn_seat: room.turn_seat,
    trick_index: room.trick_index,
    spades_broken: !!room.spades_broken,

    books: room.books,

    match: {
      hand_number: room.hand_number,
      score: room.match.score,
      target_score: room.match.target_score,
    },

    current_trick: room.current_trick,

    trick_history: room.trick_history,

    config: room.config,
    match_config: room.match_config,

    // IMPORTANT: UI negotiation panel reads negotiation inside state.bidding
    bidding: bidding.biddingPublicState(room),
  };
}

function sendState(room) {
  broadcast(room, { type: "state_update", state: roomPublicState(room) });
}

// =====================================================
// per-seat hand updates
// =====================================================
function sendHandToSeat(room, seatNum) {
  const seat = room.seats[seatNum];
  if (!seat) return;

  const ws = seat.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  safeSend(ws, {
    type: "hand_update",
    seat: seatNum,
    hand: room.hands?.[seatNum] || [],
  });
}

function sendHands(room) {
  [1, 2, 3, 4].forEach((s) => sendHandToSeat(room, s));
}

// =====================================================
// start / advance game
// =====================================================
function enterPlayingFromBids(room, finalBids) {
  room.final_bids = { ...finalBids };
  room.phase = "playing";

  room.trick_index = 0;
  room.books = { A: 0, B: 0 };
  room.spades_broken = false;

  // leader is left of dealer to start
  const firstLeader = room.dealer_seat % 4 === 0 ? 1 : room.dealer_seat + 1;
  room.turn_seat = firstLeader;

  room.current_trick = {
    leaderSeat: firstLeader,
    leadSuit: null,
    plays: [],
  };

  sendState(room);
  sendHands(room);
}

/**
 * normal hand scoring path (after 13 tricks) is already in your codebase.
 * books made is special: end immediately + score + advance.
 */
function resolveBooksMadeHand(room, finalBids) {
  const bidA = Number(finalBids?.A ?? 0);
  const bidB = Number(finalBids?.B ?? 0);

  const delta = { A: 10 * bidA, B: 10 * bidB };

  room.match.score.A += delta.A;
  room.match.score.B += delta.B;

  broadcast(room, {
    type: "hand_scored",
    hand_number: room.hand_number,
    mode: "books_made",
    final_bids: { A: bidA, B: bidB },
    delta,
    new_score: { ...room.match.score },
  });

  broadcast(room, {
    type: "hand_complete",
    hand_number: room.hand_number,
    books: { ...room.books },
    final_bids: { A: bidA, B: bidB },
    mode: "books_made",
  });

  const target = Number(room.match.target_score ?? 500);
  const winner =
    room.match.score.A >= target ? "A" :
    room.match.score.B >= target ? "B" :
    null;

  if (winner) {
    room.phase = "complete";
    broadcast(room, { type: "match_complete", winner_team: winner, reason: "target_score_reached" });
    sendState(room);
    return;
  }

  // advance to next hand
  rotateDealer(room);
  room.hand_number += 1;
  startHand(room);
}

function startHand(room) {
  room.phase = "bidding";
  room.hand_number += 1;
  room.match.hand_number = room.hand_number;

  room.final_bids = null;

  // build + shuffle deck
  const deck = shuffleDeck(buildDeck(room.config));
  room.deck = deck;

  // determine dealer (first hand only)
  if (room.hand_number === 1) {
    const probeDeck = shuffleDeck(buildDeck(room.config));
    const seat = determineFirstDealerSeat(probeDeck);
    room.dealer_seat = seat;
  }

  // deal
  const hands = dealHands(deck);
  room.hands = hands;

  // init trick state
  room.trick_index = 0;
  room.books = { A: 0, B: 0 };
  room.spades_broken = false;

  room.turn_seat = null;
  room.current_trick = {
    leaderSeat: null,
    leadSuit: null,
    plays: [],
  };
  room.trick_history = [];

  // init bidding state (delegated module)
  bidding.initBidding(room, { nonDealingTeam, dealingTeam });

  broadcast(room, { type: "hand_started", hand_number: room.hand_number, dealer_seat: room.dealer_seat });

  sendState(room);
  sendHands(room);
}

function everyoneReady(room) {
  const seats = Object.values(room.seats);
  if (seats.some((s) => !s)) return false;
  return seats.every((s) => !!s.ready);
}

function maybeStartFromLobby(room) {
  if (room.phase !== "lobby") return;
  if (!everyoneReady(room)) return;
  startHand(room);
}

// =====================================================
// bidding helpers passed into functions/bidding.js
// =====================================================
function biddingHelpers(room) {
  return {
    safeSend,
    broadcast,
    sendState,

    findSeatForClient: (r, clientId) => findSeatForClient(r, clientId),
    teamForSeat,

    dealingTeam,
    nonDealingTeam,

    enterPlayingFromBids,
    resolveBooksMadeHand,
  };
}

// =====================================================
// WS server
// =====================================================
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Big Joker Spades WS server\n");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  const parsed = url.parse(req.url, true);
  const roomId = String(parsed.query?.room || "").trim();
  if (!roomId) {
    safeSend(ws, { type: "error", error: "missing_room" });
    ws.close();
    return;
  }

  let room = rooms.get(roomId);
  if (!room) {
    room = makeEmptyRoom(roomId);
    rooms.set(roomId, room);
  }

  // attach client id
  const clientId = uid();
  ws._clientId = clientId;

  room.clients.add(ws);

  // initial state
  safeSend(ws, { type: "you_are", seat: null });
  safeSend(ws, { type: "state_update", state: roomPublicState(room) });

  ws.on("message", (buf) => {
    const msg = safeJsonParse(String(buf));
    if (!msg || !msg.type) return;

    // shorthand
    const type = msg.type;

    // seat choose
    if (type === "seat_choose") {
      if (room.phase !== "lobby") {
        safeSend(ws, { type: "error", error: "not_in_lobby" });
        return;
      }

      const seatNum = Number(msg.seat);
      if (![1, 2, 3, 4].includes(seatNum)) {
        safeSend(ws, { type: "error", error: "invalid_seat" });
        return;
      }

      if (room.seats[seatNum]) {
        safeSend(ws, { type: "error", error: "seat_taken" });
        return;
      }

      // unseat from any old seat
      for (const s of [1, 2, 3, 4]) {
        if (room.seats[s] && room.seats[s].clientId === clientId) {
          room.seats[s] = null;
        }
      }

      room.seats[seatNum] = { clientId, ws, ready: false, kind: "human" };

      safeSend(ws, { type: "you_are", seat: seatNum });
      sendState(room);
      return;
    }

    // ready
    if (type === "ready_set") {
      const seatObj = findSeatForClient(room, clientId);
      if (!seatObj) {
        safeSend(ws, { type: "error", error: "no_seat" });
        return;
      }
      room.seats[seatObj.seat].ready = !!msg.ready;
      sendState(room);
      maybeStartFromLobby(room);
      return;
    }

    // leave
    if (type === "leave_room") {
      for (const s of [1, 2, 3, 4]) {
        if (room.seats[s] && room.seats[s].clientId === clientId) {
          room.seats[s] = null;
        }
      }
      safeSend(ws, { type: "you_are", seat: null });
      sendState(room);
      return;
    }

    // resync hand
    if (type === "stay_in_sync") {
      const seatObj = findSeatForClient(room, clientId);
      if (seatObj) sendHandToSeat(room, seatObj.seat);
      safeSend(ws, { type: "state_update", state: roomPublicState(room) });
      return;
    }

    // ======================================
    // bidding delegation
    // ======================================
    if (type === "bid_set") {
      bidding.handleBidSet(room, ws, msg.bid, biddingHelpers(room));
      return;
    }

    if (type === "bid_confirm") {
      bidding.handleBidConfirm(room, ws, biddingHelpers(room));
      // if the negotiation path is "both teams increase", finalization / re-loop happens once BOTH teams re-lock
      bidding.maybeFinalizeAfterBothIncreaseRelock(room, biddingHelpers(room));
      return;
    }

    if (type === "negotiation_choice") {
      bidding.handleNegotiationChoice(room, ws, msg.choice, biddingHelpers(room));
      return;
    }

    if (type === "negotiation_response") {
      bidding.handleNegotiationResponse(room, ws, msg.accept, biddingHelpers(room));
      return;
    }

    // ======================================
    // playing (card play)
    // ======================================
    if (type === "play_card") {
      if (room.phase !== "playing") {
        safeSend(ws, { type: "error", error: "not_in_playing" });
        return;
      }

      const seatObj = findSeatForClient(room, clientId);
      if (!seatObj) {
        safeSend(ws, { type: "error", error: "no_seat" });
        return;
      }

      const seatNum = seatObj.seat;

      if (Number(room.turn_seat) !== Number(seatNum)) {
        safeSend(ws, { type: "error", error: "not_your_turn" });
        return;
      }

      const cardId = msg.card_id;

      // delegate legality + state mutation to trick module
      try {
        trick.playCard(room, seatNum, cardId);
      } catch (e) {
        safeSend(ws, { type: "error", error: e?.message || "play_error" });
        return;
      }

      // after play, sync all state
      sendState(room);
      sendHands(room);
      return;
    }

    safeSend(ws, { type: "error", error: "unknown_message_type" });
  });

  ws.on("close", () => {
    room.clients.delete(ws);

    // remove seat if occupied
    for (const s of [1, 2, 3, 4]) {
      if (room.seats[s] && room.seats[s].clientId === clientId) {
        room.seats[s] = null;
      }
    }

    sendState(room);

    // optional: garbage collect empty rooms
    if (room.clients.size === 0) {
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Big Joker Spades WS server running on ws://localhost:${PORT}`);
});