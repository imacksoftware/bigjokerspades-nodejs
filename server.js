// server.js
const http = require('http');
const { WebSocketServer } = require('ws');

// root-level requires (IMPORTANT)
const deck = require('./functions/deck');
const deal = require('./functions/deal');
const dealer = require('./functions/dealer');
const trick = require('./functions/trick');
const bidding = require('./functions/bidding');

const PORT = Number(process.env.PORT || 3001);

const rooms = new Map(); // roomId -> room object

function safeJsonSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcastRoom(room, obj) {
  for (const s of [1, 2, 3, 4]) {
    const seat = room.seats[s];
    if (seat?.ws) safeJsonSend(seat.ws, obj);
  }
}

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
      bags: room.match.bags,          // add this
      target_score: room.match.target_score,
    },

    current_trick: room.current_trick,
    trick_history: room.trick_history,

    config: room.config,
    match_config: room.match_config,

    // UI reads negotiation under state.bidding.negotiation
    bidding: bidding.biddingPublicState(room),
  };
}

function getOrCreateRoom(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);

  const room = {
    roomId,

    // phases: lobby -> bidding -> negotiating -> playing (you can wire playing later)
    phase: 'lobby',

    // seats: { 1:{ws,ready}, ... }
    seats: {
      1: { ws: null, ready: false },
      2: { ws: null, ready: false },
      3: { ws: null, ready: false },
      4: { ws: null, ready: false },
    },

    // game state
    dealer_seat: null,
    turn_seat: null,
    trick_index: 0,
    spades_broken: false,

    books: { A: 0, B: 0 },

    match: {
      score: { A: 0, B: 0 },
      bags: { A: 0, B: 0 }, // <— add
      target_score: 500,
    },

    hand_number: 0,

    current_trick: { leaderSeat: null, leadSuit: null, plays: [] },
    trick_history: [],

    config: {
      big_joker: 'color', // "color" | "bw"
      big_deuce: 'D2',    // "D2" | "S2"
    },

    match_config: {
      target_score: 500,
      board: 4,
      first_hand_bids_itself: true,
      renege_on: false,               // if true, legality is NOT enforced
      // optional override:
      // min_total_bid: 11,

      // scoring toggles (lock these later)
      bags_enabled: true,
      bags_penalty_at: 10,            // common: every 10 bags
      bags_penalty_points: 100,       // common: -100
      ten_for_two_enabled: true,      // >=10 bid special
    },

    // per-seat hands
    hands: {
      1: [],
      2: [],
      3: [],
      4: [],
    },

    bidding: null,
    final_bids: null, // set when bidding/negotiation resolves

    // NEW: store most recent hand summary so reconnects can see it
    last_hand_summary: null,
  };

  rooms.set(roomId, room);
  return room;
}

function findSeatByWs(room, ws) {
  for (const s of [1, 2, 3, 4]) {
    if (room.seats[s].ws === ws) return s;
  }
  return null;
}

function sendState(room) {
  broadcastRoom(room, { type: 'state_update', state: roomPublicState(room) });
}

function sendHandToSeat(room, seatNum) {
  const seat = room.seats[seatNum];
  if (!seat?.ws) return;
  safeJsonSend(seat.ws, {
    type: 'hand_update',
    seat: seatNum,
    hand: room.hands[seatNum] || [],
  });
}

function allSeatedAndReady(room) {
  for (const s of [1, 2, 3, 4]) {
    if (!room.seats[s].ws) return false;
    if (!room.seats[s].ready) return false;
  }
  return true;
}

function isRenegeOn(room) {
  return !!room?.match_config?.renege_on;
}

function cardEffectiveSuit(card) {
  return trick.effectiveSuit(card); // "S" if trump, else actual suit
}

function handHasEffectiveSuit(hand, suit) {
  return Array.isArray(hand) && hand.some(c => cardEffectiveSuit(c) === suit);
}

function handIsAllTrump(hand) {
  return Array.isArray(hand) && hand.length > 0 && hand.every(c => !!c.is_trump);
}

/**
 * returns { ok:true } or { ok:false, error:'...' }
 */
function validatePlayLegality(room, seat, card) {
  // if renege is ON, anything goes
  if (isRenegeOn(room)) return { ok: true };

  const s = Number(seat);
  const hand = room.hands?.[s] || [];

  const effSuit = cardEffectiveSuit(card); // lead suit comparisons use effective suit

  const leadSuit = room.current_trick?.leadSuit; // already an effective suit value when set

  // if not leading (leadSuit exists), must follow suit if possible
  if (leadSuit) {
    const mustFollow = handHasEffectiveSuit(hand, leadSuit);
    if (mustFollow && effSuit !== leadSuit) {
      return { ok: false, error: 'must_follow_suit' };
    }
    return { ok: true };
  }

  // leading a trick: cannot lead trump before spades broken unless hand is all trump
  if (!room.spades_broken && effSuit === 'S') {
    if (!handIsAllTrump(hand)) {
      return { ok: false, error: 'cannot_lead_trump_until_broken' };
    }
  }

  return { ok: true };
}

function scorePlayedHand(room) {
  const bids = room.final_bids || { A: 0, B: 0 };
  const books = room.books || { A: 0, B: 0 };

  function teamDelta(team) {
    const bid = Number(bids[team] ?? 0);
    const made = Number(books[team] ?? 0);

    if (made >= bid) {
      const bags = made - bid;
      return { delta: (bid * 10) + bags, bags_add: bags };
    }
    return { delta: -(bid * 10), bags_add: 0 };
  }

  const a = teamDelta('A');
  const b = teamDelta('B');

  // apply score
  room.match.score.A = Number(room.match.score.A ?? 0) + a.delta;
  room.match.score.B = Number(room.match.score.B ?? 0) + b.delta;

  // apply bags (optional rule: -100 per 10 bags)
  if (!room.match.bags) room.match.bags = { A: 0, B: 0 };
  room.match.bags.A = Number(room.match.bags.A ?? 0) + a.bags_add;
  room.match.bags.B = Number(room.match.bags.B ?? 0) + b.bags_add;

  // standard bags penalty
  while (room.match.bags.A >= 10) {
    room.match.bags.A -= 10;
    room.match.score.A -= 100;
  }
  while (room.match.bags.B >= 10) {
    room.match.bags.B -= 10;
    room.match.score.B -= 100;
  }

  return {
    ok: true,
    mode: 'played',
    delta: { A: a.delta, B: b.delta },
    detail: { bids, books, bags: room.match.bags },
  };
}

function startNewHand(room) {
  room.hand_number += 1;
  room.phase = 'bidding';
  room.final_bids = null;

  // create + shuffle deck
  const d = deck.buildDeck(room.config);
  const shuffled = deck.shuffleDeck(d);

  // choose dealer seat based on big deuce
  const bigDeuceId = room.config.big_deuce || 'D2';
  const found = dealer.determineFirstDealerSeat(shuffled, bigDeuceId);

  room.dealer_seat = found.dealer_seat;
  room.turn_seat = null;

  // deal hands
  const hands = deal.dealHands(shuffled);
  room.hands[1] = hands['1'] || [];
  room.hands[2] = hands['2'] || [];
  room.hands[3] = hands['3'] || [];
  room.hands[4] = hands['4'] || [];

  // reset trick
  room.trick_index = 0;
  room.current_trick = trick.startTrick();
  room.trick_history = [];
  room.spades_broken = false;
  room.books = { A: 0, B: 0 };

  // init bidding
  room.bidding = bidding.initBidding(room);

  // push state + each seat’s hand
  sendState(room);
  [1, 2, 3, 4].forEach((s) => sendHandToSeat(room, s));
}

function ensurePlayingTurnInitialized(room) {
  if (room.phase !== 'playing') return;
  if (room.turn_seat !== null && room.turn_seat !== undefined) return;

  const first = trick.leftOfDealer(room.dealer_seat);
  room.turn_seat = first;
  room.current_trick = trick.startTrick(first);
}

function endHandAndMaybeStartNext(room, scoredResult, meta = {}) {
  broadcastRoom(room, {
    type: 'hand_complete',
    hand_number: room.hand_number,
    mode: meta.mode || 'played',
    books: room.books,
    final_bids: room.final_bids,
  });

  broadcastRoom(room, {
    type: 'hand_scored',
    hand_number: room.hand_number,
    mode: scoredResult.mode || meta.mode || 'played',
    delta: scoredResult.delta,
    score: room.match.score,
    bags: room.match.bags,
    detail: scoredResult.detail,
  });

  const target = Number(room.match.target_score ?? 500);
  const a = Number(room.match.score.A ?? 0);
  const b = Number(room.match.score.B ?? 0);

  if (a >= target || b >= target) {
    broadcastRoom(room, {
      type: 'match_complete',
      winner_team: a === b ? 'tie' : (a > b ? 'A' : 'B'),
      reason: 'target_score',
      final_score: room.match.score,
    });
    return;
  }

  startNewHand(room);
}

function maybeStartFromLobby(room) {
  if (room.phase !== 'lobby') return;
  if (!allSeatedAndReady(room)) return;
  startNewHand(room);
}

function maybeAutoResolveNegotiation(room) {
  if (room.phase !== 'negotiating') return;

  if (bidding.negotiationIsResolvedBooksMade(room)) {
    const r = bidding.scoreBooksMadeHand(room);
    if (!r?.ok) {
      console.error('scoreBooksMadeHand failed:', r?.error);
      return;
    }

    endHandAndMaybeStartNext(room, r, { mode: 'books_made' });
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Big Joker Spades WS server\n');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');

  if (!roomId) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._roomId = roomId;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const roomId = ws._roomId;
  const room = getOrCreateRoom(roomId);

  // initial seat info
  safeJsonSend(ws, { type: 'you_are', seat: null });
  safeJsonSend(ws, { type: 'state_update', state: roomPublicState(room) });

  if (room.last_hand_summary) {
    safeJsonSend(ws, { type: 'hand_summary', summary: room.last_hand_summary });
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      safeJsonSend(ws, { type: 'error', error: 'invalid_json' });
      return;
    }

    const type = msg?.type;
    const mySeat = findSeatByWs(room, ws);

    // --- core lobby controls ---
    if (type === 'seat_choose') {
      const wanted = Number(msg.seat);
      if (![1, 2, 3, 4].includes(wanted)) {
        safeJsonSend(ws, { type: 'error', error: 'invalid_seat' });
        return;
      }

      // if already seated elsewhere, free old seat
      if (mySeat && mySeat !== wanted) {
        room.seats[mySeat].ws = null;
        room.seats[mySeat].ready = false;
      }

      // must be empty
      if (room.seats[wanted].ws && room.seats[wanted].ws !== ws) {
        safeJsonSend(ws, { type: 'error', error: 'seat_taken' });
        return;
      }

      room.seats[wanted].ws = ws;
      room.seats[wanted].ready = false;

      safeJsonSend(ws, { type: 'you_are', seat: wanted });
      sendState(room);
      return;
    }

    if (type === 'ready_set') {
      if (!mySeat) {
        safeJsonSend(ws, { type: 'error', error: 'not_seated' });
        return;
      }
      room.seats[mySeat].ready = !!msg.ready;
      sendState(room);
      maybeStartFromLobby(room);
      return;
    }

    if (type === 'leave_room') {
      if (mySeat) {
        room.seats[mySeat].ws = null;
        room.seats[mySeat].ready = false;
      }
      safeJsonSend(ws, { type: 'you_are', seat: null });
      sendState(room);
      return;
    }

    if (type === 'stay_in_sync') {
      safeJsonSend(ws, { type: 'state_update', state: roomPublicState(room) });
      if (mySeat) sendHandToSeat(room, mySeat);
      return;
    }

    // --- bidding + negotiating ---
    if (type === 'bid_set') {
      if (!mySeat) {
        safeJsonSend(ws, { type: 'error', error: 'not_seated' });
        return;
      }

      const r = bidding.handleBidSet(room, mySeat, msg.bid);
      if (!r.ok) {
        safeJsonSend(ws, { type: 'error', error: r.error });
        return;
      }

      sendState(room);
      return;
    }

    if (type === 'bid_confirm') {
      if (!mySeat) {
        safeJsonSend(ws, { type: 'error', error: 'not_seated' });
        return;
      }

      const r = bidding.handleBidConfirm(room, mySeat);
      if (!r.ok) {
        safeJsonSend(ws, { type: 'error', error: r.error });
        return;
      }

      ensurePlayingTurnInitialized(room);
      sendState(room);
      maybeAutoResolveNegotiation(room);
      return;
    }

    // negotiation choices
    if (type === 'negotiation_choice') {
      if (!mySeat) {
        safeJsonSend(ws, { type: 'error', error: 'not_seated' });
        return;
      }

      const r = bidding.handleNegotiationChoice(room, mySeat, msg.choice);
      if (!r.ok) {
        safeJsonSend(ws, { type: 'error', error: r.error });
        return;
      }

      sendState(room);
      maybeAutoResolveNegotiation(room);
      return;
    }

    if (type === 'negotiation_response') {
      if (!mySeat) {
        safeJsonSend(ws, { type: 'error', error: 'not_seated' });
        return;
      }

      const r = bidding.handleNegotiationResponse(room, mySeat, msg.accept);
      if (!r.ok) {
        safeJsonSend(ws, { type: 'error', error: r.error });
        return;
      }

      ensurePlayingTurnInitialized(room);
      sendState(room);
      maybeAutoResolveNegotiation(room);
      return;
    }

    // --- playing ---
    if (type === 'play_card') {
      if (!mySeat) {
        safeJsonSend(ws, { type: 'error', error: 'not_seated' });
        return;
      }

      if (room.phase !== 'playing') {
        safeJsonSend(ws, { type: 'error', error: 'not_in_playing' });
        return;
      }

      ensurePlayingTurnInitialized(room);

      if (Number(room.turn_seat) !== Number(mySeat)) {
        safeJsonSend(ws, { type: 'error', error: 'not_your_turn' });
        return;
      }

      const cardId = String(msg.card_id || '');
      if (!cardId) {
        safeJsonSend(ws, { type: 'error', error: 'missing_card_id' });
        return;
      }

      const hand = room.hands?.[mySeat] || [];
      const idx = hand.findIndex(c => String(c.id) === cardId);
      if (idx === -1) {
        safeJsonSend(ws, { type: 'error', error: 'card_not_in_hand' });
        return;
      }

      const card = hand[idx];

      // legality enforcement (unless renege_on)
      const legal = validatePlayLegality(room, mySeat, card);
      if (!legal.ok) {
        safeJsonSend(ws, { type: 'error', error: legal.error });
        return;
      }

      // remove from hand
      hand.splice(idx, 1);
      room.hands[mySeat] = hand;

      // set leader / lead suit on first play of trick
      if (!room.current_trick.leaderSeat) room.current_trick.leaderSeat = mySeat;

      if (!room.current_trick.leadSuit) {
        room.current_trick.leadSuit = trick.effectiveSuit(card); // "S" if trump, else actual suit
      }

      // record play (store BOTH card_id + card for winner logic)
      room.current_trick.plays.push({
        seat: mySeat,
        card_id: card.id,
        card,
      });

      // spades broken flag (simple: if any trump played)
      if (card.is_trump) room.spades_broken = true;

      // if trick not complete yet -> advance turn
      if (room.current_trick.plays.length < 4) {
        room.turn_seat = trick.nextSeatClockwise(mySeat);
        sendState(room);
        sendHandToSeat(room, mySeat);
        return;
      }

      // ---- trick finished (4 plays) ----
      const winnerSeat = trick.determineTrickWinner(room.current_trick);
      const winnerTeam = trick.teamForSeat(winnerSeat);

      // update books
      room.books[winnerTeam] = Number(room.books[winnerTeam] ?? 0) + 1;

      // push into history (keep UI-friendly fields)
      room.trick_history.push({
        trick_index: room.trick_index,
        leader_seat: room.current_trick.leaderSeat,
        lead_suit: room.current_trick.leadSuit,
        winner_seat: winnerSeat,
        winner_team: winnerTeam,
        plays: room.current_trick.plays.map(p => ({ seat: p.seat, card_id: p.card_id })),
      });

      // ---- HAND END CHECK (THIS IS WHERE YOUR “handIsOver” SNIPPET GOES) ----
      const handIsOver = (room.trick_history.length >= 13); // 13 tricks

      if (handIsOver) {
        const r = scorePlayedHand(room);
        if (!r?.ok) {
          console.error('scorePlayedHand failed:', r?.error);
          return;
        }
        endHandAndMaybeStartNext(room, r, { mode: 'played' });
        return;
      }

      // ---- start next trick (THIS IS WHERE YOUR “start next trick” SNIPPET GOES) ----
      room.trick_index += 1;
      room.current_trick = trick.startTrick(winnerSeat);
      room.turn_seat = winnerSeat;

      sendState(room);

      // send updated hand to the player who just played (so their card disappears immediately)
      sendHandToSeat(room, mySeat);
      return;
    }

    // unknown
    safeJsonSend(ws, { type: 'error', error: 'unknown_message_type' });
  });

  ws.on('close', () => {
    const seat = findSeatByWs(room, ws);
    if (seat) {
      room.seats[seat].ws = null;
      room.seats[seat].ready = false;
      sendState(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Big Joker Spades WS server running on ws://localhost:${PORT}`);
});