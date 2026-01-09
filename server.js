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

console.log("SERVER VERSION: milestone-7 (bidding + scoring) + strict legality");

const rooms = new Map();

function makeEmptyRoom(roomId) {
  return {
    roomId,
    createdAt: Date.now(),

    phase: "lobby", // lobby | bidding | playing | complete

    clients: new Set(),

    seats: [
      { seat: 1, clientId: null, isBot: false, ready: false },
      { seat: 2, clientId: null, isBot: false, ready: false },
      { seat: 3, clientId: null, isBot: false, ready: false },
      { seat: 4, clientId: null, isBot: false, ready: false },
    ],

    // match-level config
    match_config: {
      target_score: 500, // 500 default; later: 350/250/custom
      board: 4, // minimum team bid
      min_total_bid: 11, // minimum combined bids across teams
      first_hand_bids_itself: true,
      allow_books_made: true, // we’ll wire UI + flow next
    },

    // game-level config (deck/trump + legality)
    config: {
      big_joker: "color", // "color" | "bw"
      big_deuce: "D2", // "D2" | "S2"
      renege_enabled: false, // milestone 7 still strict (OFF)
    },

    // match state
    hand_number: 0,
    match_score: { A: 0, B: 0 },

    dealer_seat: null,

    // hand state
    spades_broken: false,
    turn_seat: null,
    trick_index: 0, // 1..13
    books: { A: 0, B: 0 },

    hands: { 1: [], 2: [], 3: [], 4: [] },

    current_trick: {
      leaderSeat: null,
      leadSuit: null, // effective suit
      plays: [], // { seat, card }
    },

    trickHistory: [],

    // bidding state (only used when phase === "bidding")
    bidding: null, // init per bidding-hand
    final_bids: null, // {A:number, B:number} stored once bidding locks
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

function computeTeamTotalsFromPicks(picks) {
  const a1 = Number(picks?.[1] ?? 0);
  const a3 = Number(picks?.[3] ?? 0);
  const b2 = Number(picks?.[2] ?? 0);
  const b4 = Number(picks?.[4] ?? 0);
  return { A: a1 + a3, B: b2 + b4 };
}

function dealingTeam(room) {
  if (!room.dealer_seat) return null;
  return teamForSeat(room.dealer_seat);
}

function nonDealingTeam(room) {
  const d = dealingTeam(room);
  if (!d) return null;
  return d === "A" ? "B" : "A";
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

    match: {
      hand_number: room.hand_number,
      score: room.match_score,
      target_score: room.match_config.target_score,
    },

    dealer_seat: room.dealer_seat,
    spades_broken: room.spades_broken,

    turn_seat: room.turn_seat,
    trick_index: room.trick_index,
    books: room.books,

    current_trick: {
      leaderSeat: room.current_trick.leaderSeat,
      leadSuit: room.current_trick.leadSuit,
      plays: room.current_trick.plays.map((p) => ({
        seat: p.seat,
        card_id: p.card.id,
      })),
    },

    trick_history: room.trickHistory.slice(-20),

    bidding: room.bidding
      ? {
          picks: room.bidding.picks,
          team_totals: room.bidding.team_totals,
          confirmed: room.bidding.confirmed,
          lock_order: room.bidding.lock_order,
          must_confirm_team: room.bidding.must_confirm_team,
          needs_min_total_resolution: room.bidding.needs_min_total_resolution,
          min_total_bid: room.match_config.min_total_bid,
          board: room.match_config.board,
        }
      : null,

    final_bids: room.final_bids,
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
  room.hand_number = 0;
  room.match_score = { A: 0, B: 0 };

  room.dealer_seat = null;

  room.spades_broken = false;
  room.turn_seat = null;
  room.trick_index = 0;
  room.books = { A: 0, B: 0 };

  room.hands = { 1: [], 2: [], 3: [], 4: [] };
  room.current_trick = { leaderSeat: null, leadSuit: null, plays: [] };
  room.trickHistory = [];

  room.bidding = null;
  room.final_bids = null;

  resetAllReady(room);

  broadcast(room, { type: "returned_to_lobby", room_id: room.roomId, reason });
  sendState(room);
}

function initBidding(room) {
  const nonDeal = nonDealingTeam(room);
  const deal = dealingTeam(room);

  room.bidding = {
    picks: { 1: null, 2: null, 3: null, 4: null },
    team_totals: { A: 0, B: 0 },
    confirmed: { A: false, B: false },
    lock_order: [nonDeal, deal], // non-dealing locks first
    must_confirm_team: nonDeal, // enforced
    needs_min_total_resolution: false,
  };

  room.final_bids = null;
}

function startHand(room) {
  // deal new hand
  const liveDeck = shuffleDeck(buildDeck(room.config));
  room.hands = dealHands(liveDeck);

  // reset hand state
  room.spades_broken = false;
  room.trick_index = 0;
  room.books = { A: 0, B: 0 };
  room.trickHistory = [];
  room.current_trick = { leaderSeat: null, leadSuit: null, plays: [] };
  room.turn_seat = null;

  room.final_bids = null;

  // hand 1 bids itself?
  const isFirstHand = room.hand_number === 1 && room.match_config.first_hand_bids_itself;

  if (isFirstHand) {
    room.phase = "playing";
    room.bidding = null;

    // first leader = left of dealer
    const firstLeader = leftOfDealer(room.dealer_seat);
    room.trick_index = 1;
    room.current_trick = { leaderSeat: firstLeader, leadSuit: null, plays: [] };
    room.turn_seat = firstLeader;

    broadcast(room, {
      type: "hand_started",
      room_id: room.roomId,
      hand_number: room.hand_number,
      mode: "first_hand_bids_itself",
      dealer_seat: room.dealer_seat,
      first_turn_seat: room.turn_seat,
    });

    sendState(room);

    for (const clientWs of room.clients) {
      sendHandUpdate(clientWs, room);
      sendYouAre(clientWs, room);
    }

    return;
  }

  // normal bidding hand
  room.phase = "bidding";
  initBidding(room);

  broadcast(room, {
    type: "hand_started",
    room_id: room.roomId,
    hand_number: room.hand_number,
    mode: "bidding",
    dealer_seat: room.dealer_seat,
    non_dealing_team_locks_first: nonDealingTeam(room),
  });

  sendState(room);

  // send hands now (server-authoritative; later we can hide during bidding if desired)
  for (const clientWs of room.clients) {
    sendHandUpdate(clientWs, room);
    sendYouAre(clientWs, room);
  }
}

function startMatch(room) {
  // first diamond deals to determine initial dealer
  const probeDeck = shuffleDeck(buildDeck(room.config));
  const probe = determineFirstDealerSeat(probeDeck);
  room.dealer_seat = probe.dealer_seat;

  room.hand_number = 1;
  room.match_score = { A: 0, B: 0 };
  room.phase = "bidding";
  room.final_bids = null;

  startHand(room);
}

function maybeStartMatch(room) {
  if (room.phase !== "lobby") return;
  if (!allFourSeatsOccupied(room)) return;
  if (!allFourSeatsReady(room)) return;
  startMatch(room);
}

function rotateDealer(room) {
  room.dealer_seat = nextSeatClockwise(room.dealer_seat);
}

function finishHandAndAdvance(room) {
  // scoring
  const isFirstHand = room.hand_number === 1 && room.match_config.first_hand_bids_itself;

  let deltaA = 0;
  let deltaB = 0;

  if (isFirstHand) {
    // first hand bids itself: tricks*10
    deltaA = (room.books.A || 0) * 10;
    deltaB = (room.books.B || 0) * 10;

    room.match_score.A += deltaA;
    room.match_score.B += deltaB;

    broadcast(room, {
      type: "hand_scored",
      room_id: room.roomId,
      hand_number: room.hand_number,
      mode: "first_hand_bids_itself",
      books: room.books,
      delta: { A: deltaA, B: deltaB },
      match_score: room.match_score,
    });

    // instant win if 10+ tricks on first hand
    if ((room.books.A || 0) >= 10 || (room.books.B || 0) >= 10) {
      const winner = (room.books.A || 0) >= 10 ? "A" : "B";
      room.phase = "complete";
      broadcast(room, {
        type: "match_complete",
        room_id: room.roomId,
        winner_team: winner,
        reason: "first_hand_10_plus",
        match_score: room.match_score,
      });
      sendState(room);
      return;
    }
  } else {
    // normal bidding hand
    const bids = room.final_bids || { A: 0, B: 0 };
    const booksA = room.books.A || 0;
    const booksB = room.books.B || 0;

    function scoreTeam(team, bid, books) {
      const made = books >= bid;
      if (bid >= 10) {
        // make = +200, miss = -bid*10 (not doubled)
        return made ? 200 : -bid * 10;
      }
      return made ? bid * 10 : -bid * 10;
    }

    deltaA = scoreTeam("A", Number(bids.A || 0), booksA);
    deltaB = scoreTeam("B", Number(bids.B || 0), booksB);

    room.match_score.A += deltaA;
    room.match_score.B += deltaB;

    broadcast(room, {
      type: "hand_scored",
      room_id: room.roomId,
      hand_number: room.hand_number,
      mode: "bidding",
      bids,
      books: room.books,
      delta: { A: deltaA, B: deltaB },
      match_score: room.match_score,
    });
  }

  // match win check (target score)
  const target = Number(room.match_config.target_score || 500);
  if (room.match_score.A >= target || room.match_score.B >= target) {
    const winner = room.match_score.A >= target ? "A" : "B";
    room.phase = "complete";
    broadcast(room, {
      type: "match_complete",
      room_id: room.roomId,
      winner_team: winner,
      reason: "target_score_reached",
      match_score: room.match_score,
      target_score: target,
    });
    sendState(room);
    return;
  }

  // next hand
  rotateDealer(room);
  room.hand_number += 1;
  startHand(room);
}

/**
 * strict legality (renege OFF):
 * - must follow suit using effectiveSuit
 * - cannot lead spade/trump until broken, unless leader has only spades/trump
 * - if you cannot follow suit, you may play anything (including spades)
 */
function checkLegality(room, hand, card, isLeaderPlay) {
  if (room.config && room.config.renege_enabled) return { ok: true };

  const cardSuitEff = effectiveSuit(card);

  if (isLeaderPlay) {
    if (cardSuitEff === "S" && !room.spades_broken) {
      const hasNonTrump = hand.some((c) => effectiveSuit(c) !== "S");
      if (hasNonTrump) return { ok: false, error: "illegal_lead_spade_unbroken" };
    }
    return { ok: true };
  }

  const leadSuit = room.current_trick.leadSuit;
  if (!leadSuit) return { ok: true };

  const hasLeadSuit = hand.some((c) => effectiveSuit(c) === leadSuit);
  if (hasLeadSuit && effectiveSuit(card) !== leadSuit) {
    return { ok: false, error: "illegal_must_follow_suit" };
  }

  return { ok: true };
}

function requirePhase(room, ws, phase) {
  if (room.phase !== phase) {
    safeSend(ws, { type: "error", error: `not_in_${phase}` });
    return false;
  }
  return true;
}

function handleBidSet(room, ws, bidRaw) {
  if (!requirePhase(room, ws, "bidding")) return;

  const seatObj = findSeatForClient(room, ws._clientId);
  if (!seatObj) return safeSend(ws, { type: "error", error: "no_seat" });

  const seatNum = seatObj.seat;

  const bid = Number(bidRaw);
  if (!Number.isFinite(bid) || bid < 0 || bid > 13) {
    return safeSend(ws, { type: "error", error: "invalid_bid" });
  }

  // if team already confirmed, disallow changes (simple + safe)
  const team = teamForSeat(seatNum);
  if (room.bidding.confirmed[team]) {
    return safeSend(ws, { type: "error", error: "team_already_confirmed" });
  }

  room.bidding.picks[seatNum] = bid;
  room.bidding.team_totals = computeTeamTotalsFromPicks(room.bidding.picks);

  sendState(room);
}

function handleBidConfirm(room, ws) {
  if (!requirePhase(room, ws, "bidding")) return;

  const seatObj = findSeatForClient(room, ws._clientId);
  if (!seatObj) return safeSend(ws, { type: "error", error: "no_seat" });

  const seatNum = seatObj.seat;
  const team = teamForSeat(seatNum);

  // enforce lock order: non-dealing team must confirm first
  if (team !== room.bidding.must_confirm_team) {
    return safeSend(ws, { type: "error", error: "not_your_team_turn_to_confirm" });
  }

  // both teammates must have picks
  const teammateSeat = team === "A" ? (seatNum === 1 ? 3 : 1) : (seatNum === 2 ? 4 : 2);
  const myPick = room.bidding.picks[seatNum];
  const matePick = room.bidding.picks[teammateSeat];

  if (myPick === null || myPick === undefined || matePick === null || matePick === undefined) {
    return safeSend(ws, { type: "error", error: "both_teammates_must_pick" });
  }

  // team total must be >= board
  room.bidding.team_totals = computeTeamTotalsFromPicks(room.bidding.picks);
  const teamTotal = room.bidding.team_totals[team] || 0;
  const board = Number(room.match_config.board || 4);

  if (teamTotal < board) {
    return safeSend(ws, { type: "error", error: "team_bid_below_board" });
  }

  // lock it
  room.bidding.confirmed[team] = true;

  // advance lock order
  const [first, second] = room.bidding.lock_order;
  room.bidding.must_confirm_team = team === first ? second : null;

  sendState(room);

  // if both confirmed, validate min total
  if (room.bidding.confirmed.A && room.bidding.confirmed.B) {
    const minTotal = Number(room.match_config.min_total_bid || 11);
    const total = (room.bidding.team_totals.A || 0) + (room.bidding.team_totals.B || 0);

    if (total < minTotal) {
      // we stop here until we implement the “increase / books made” prompt flow
      room.bidding.needs_min_total_resolution = true;

      broadcast(room, {
        type: "bidding_needs_min_total_resolution",
        room_id: room.roomId,
        total_bid: total,
        min_total_bid: minTotal,
        team_totals: room.bidding.team_totals,
      });

      sendState(room);
      return;
    }

    // bidding complete -> lock final bids
    room.final_bids = { ...room.bidding.team_totals };
    room.bidding = null;

    // enter play
    room.phase = "playing";
    room.trick_index = 1;

    const firstLeader = leftOfDealer(room.dealer_seat);
    room.current_trick = { leaderSeat: firstLeader, leadSuit: null, plays: [] };
    room.turn_seat = firstLeader;

    broadcast(room, {
      type: "bidding_complete",
      room_id: room.roomId,
      hand_number: room.hand_number,
      final_bids: room.final_bids,
      dealer_seat: room.dealer_seat,
      first_turn_seat: room.turn_seat,
    });

    sendState(room);
  }
}

function handlePlayCard(room, ws, cardIdRaw) {
  if (!requirePhase(room, ws, "playing")) return;

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

  const card = hand[idx];

  const isLeaderPlay = room.current_trick.plays.length === 0;
  const legality = checkLegality(room, hand, card, isLeaderPlay);
  if (!legality.ok) return safeSend(ws, { type: "error", error: legality.error });

  // remove after legality
  hand.splice(idx, 1);

  // set lead suit if first play
  if (room.current_trick.plays.length === 0) {
    room.current_trick.leaderSeat = seatNum;
    room.current_trick.leadSuit = effectiveSuit(card);
  }

  // spades broken if any trump is played
  if (!room.spades_broken && effectiveSuit(card) === "S") {
    room.spades_broken = true;
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

    // hand complete
    if (room.trick_index >= 13) {
      broadcast(room, {
        type: "hand_complete",
        room_id: room.roomId,
        hand_number: room.hand_number,
        books: room.books,
        t: Date.now(),
      });

      // advance match loop
      finishHandAndAdvance(room);
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

  // private update to player who just played
  sendHandUpdate(ws, room);

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
      maybeStartMatch(room);
      return;
    }

    // ===== bidding messages =====
    if (msg.type === "bid_set") {
      handleBidSet(room, ws, msg.bid);
      return;
    }

    if (msg.type === "bid_confirm") {
      handleBidConfirm(room, ws);
      return;
    }
    // ===========================

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