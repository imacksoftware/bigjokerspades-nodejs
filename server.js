// server.js
const http = require('http');
const { WebSocketServer } = require('ws');

// root-level requires (IMPORTANT)
const deck = require('./functions/deck');
const deal = require('./functions/deal');
const dealer = require('./functions/dealer');
const trick = require('./functions/trick');
const bidding = require('./functions/bidding');
const scoring = require('./functions/scoring');

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
    trick_history: (room.trick_history || []).map(t => ({
      ...t,
      renege_calls: (room.renege?.calls || []).filter(c =>
        Number(c.hand_number) === Number(room.hand_number) &&
        Number(c.trick_index) === Number(t.trick_index)
      ),
    })),

    config: room.config,
    match_config: room.match_config,

    // UI reads negotiation under state.bidding.negotiation
    bidding: bidding.biddingPublicState(room),

    renege: {
      adjustment: room.renege?.adjustment || { A: 0, B: 0 },
      calls: room.renege?.calls || [],
    },
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
      bags: { A: 0, B: 0 },
      target_score: 500,
    },

    hand_number: 0,

    current_trick: { leaderSeat: null, leadSuit: null, plays: [] },
    trick_history: [],

    renege: {
      calls: [],
      adjustment: { A: 0, B: 0 },
      next_id: 1,
    },

    config: {
      big_joker: 'color', // "color" | "bw"
      big_deuce: 'D2',    // "D2" | "S2"
    },

    match_config: {
      target_score: 500,
      board: 4,
      first_hand_bids_itself: true,
      renege_on: true,               // if true, legality is NOT enforced
      bot_takeover_on_disconnect: false,
      // optional override:
      // min_total_bid: 11,

      // scoring toggles (lock these later)
      bags_enabled: false,
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

function seatToTeam(seat) {
  const s = Number(seat);
  if (s === 1 || s === 3) return 'A';
  if (s === 2 || s === 4) return 'B';
  return null;
}

function otherTeam(team) {
  if (team === 'A') return 'B';
  if (team === 'B') return 'A';
  return null;
}

function ensureRenegeState(room) {
  if (!room.renege) {
    room.renege = { calls: [], adjustment: { A: 0, B: 0 }, next_id: 1 };
  }
  if (!room.renege.calls) room.renege.calls = [];
  if (!room.renege.adjustment) room.renege.adjustment = { A: 0, B: 0 };
  if (!room.renege.next_id) room.renege.next_id = 1;
  return room.renege;
}

function applyRenegeDelta(room, team, deltaTricks) {
  ensureRenegeState(room);
  room.renege.adjustment[team] = Number(room.renege.adjustment[team] ?? 0) + Number(deltaTricks ?? 0);
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

function validateAndApplyRenegeCall(room, accuserSeat, payload) {
  ensureRenegeState(room);

  if (room.phase !== 'playing') return { ok: false, error: 'not_in_playing' };

  // once all 13 tricks are recorded, lock renege calls for this hand
  if (Array.isArray(room.trick_history) && room.trick_history.length >= 13) {
    return { ok: false, error: 'hand_already_complete' };
  }

  const accSeat = Number(accuserSeat);
  const accusedSeat = Number(payload?.accused_seat);
  const handNumber = Number(payload?.hand_number);
  const trickIndex = Number(payload?.trick_index);

  if (![1, 2, 3, 4].includes(accSeat)) return { ok: false, error: 'invalid_accuser_seat' };
  if (![1, 2, 3, 4].includes(accusedSeat)) return { ok: false, error: 'invalid_accused_seat' };

  const accTeam = seatToTeam(accSeat);
  const accusedTeam = seatToTeam(accusedSeat);
  if (!accTeam || !accusedTeam) return { ok: false, error: 'invalid_team' };
  if (accTeam === accusedTeam) return { ok: false, error: 'cannot_accuse_own_team' };

  // validate hand number
  if (!Number.isFinite(handNumber) || handNumber !== Number(room.hand_number)) {
    return { ok: false, error: 'invalid_hand_number' };
  }

  // max 3 renege calls per accuser team per hand
  const accTeamCalls = room.renege.calls.filter(c =>
    Number(c.hand_number) === handNumber && c.accuser_team === accTeam
  ).length;
  if (accTeamCalls >= 3) return { ok: false, error: 'renege_call_limit_reached_for_team' };

  // trick must exist and be completed (in history)
  if (!Number.isFinite(trickIndex) || trickIndex < 0 || trickIndex > 12) {
    return { ok: false, error: 'invalid_trick_index' };
  }

  const trickRow = room.trick_history?.find(t => Number(t.trick_index) === trickIndex);
  if (!trickRow) return { ok: false, error: 'trick_not_found_or_not_completed' };

  const leadSuit = trickRow.lead_suit;
  if (!leadSuit) return { ok: false, error: 'trick_missing_lead_suit' };

  const plays = Array.isArray(trickRow.plays) ? trickRow.plays : [];
  if (plays.length !== 4) return { ok: false, error: 'trick_incomplete' };

  const playIndexRaw = payload?.play_index;
  const hasPlayIndex = playIndexRaw !== null && playIndexRaw !== undefined;
  if (!hasPlayIndex) return { ok: false, error: 'missing_play_index' };

  const pi = Number(playIndexRaw);
  if (!Number.isFinite(pi) || pi < 0 || pi > 3) return { ok: false, error: 'invalid_play_index' };

  // prevent duplicates for same hand/trick/accused/play_index
  const existing = room.renege.calls.find(c =>
    Number(c.hand_number) === handNumber &&
    Number(c.trick_index) === trickIndex &&
    Number(c.accused_seat) === accusedSeat &&
    Number(c.play_index) === pi
  );
  if (existing) return { ok: false, error: 'renege_already_called_for_this_target' };

  const accusedPlay = plays[pi];
  if (!accusedPlay || Number(accusedPlay.seat) !== accusedSeat) {
    return { ok: false, error: 'play_index_does_not_match_accused_seat' };
  }

  const playedEffSuit = accusedPlay.played_eff_suit;
  if (!playedEffSuit) return { ok: false, error: 'missing_played_eff_suit' };

  const hadLed = accusedPlay.had_led_suit_before_play === true;
  const isOffSuit = String(playedEffSuit) !== String(leadSuit);

  const confirmedRenege = hadLed && isOffSuit;

  const deltaTeam = accTeam;
  const delta = confirmedRenege ? +3 : -3;

  applyRenegeDelta(room, deltaTeam, delta);

  const callId = room.renege.next_id++;
  const record = {
    id: callId,
    ts: Date.now(),
    hand_number: handNumber,
    trick_index: trickIndex,
    accuser_seat: accSeat,
    accuser_team: accTeam,
    accused_seat: accusedSeat,
    accused_team: accusedTeam,
    play_index: pi,
    lead_suit: leadSuit,
    played_eff_suit: playedEffSuit,
    had_led_suit_before_play: accusedPlay.had_led_suit_before_play,
    confirmed: confirmedRenege,
    delta_tricks: delta,
  };

  room.renege.calls.push(record);

  return { ok: true, record, adjustment: room.renege.adjustment };
}

function scorePlayedHand(room) {
  const bids = room.final_bids || { A: 0, B: 0 };
  const books = room.books || { A: 0, B: 0 };

  const cfg = room.match_config || {};

  const res = scoring.scoreHand({
    bidA: Number(bids.A ?? 0),
    bidB: Number(bids.B ?? 0),
    madeA: Number(books.A ?? 0) + Number(room?.renege?.adjustment?.A ?? 0),
    madeB: Number(books.B ?? 0) + Number(room?.renege?.adjustment?.B ?? 0),
    match: room.match,
    cfg,
  });

  // apply to match
  room.match.score.A = Number(room.match.score.A ?? 0) + res.delta.A;
  room.match.score.B = Number(room.match.score.B ?? 0) + res.delta.B;

  // bags update (scoring.js already applied the bag-penalty rollover)
  if (!room.match.bags) room.match.bags = { A: 0, B: 0 };
  room.match.bags.A = res.bags.A;
  room.match.bags.B = res.bags.B;

  return { ok: true, mode: 'played', ...res };
}

function startNewHand(room) {
  room.hand_number += 1;

  // create + shuffle deck
  const d = deck.buildDeck(room.config);
  const shuffled = deck.shuffleDeck(d);

  // choose dealer seat based on big deuce
  const bigDeuceId = room.config.big_deuce || 'D2';
  const found = dealer.determineFirstDealerSeat(shuffled, bigDeuceId);

  room.dealer_seat = found.dealer_seat;

  // deal hands
  const hands = deal.dealHands(shuffled);
  room.hands[1] = hands['1'] || [];
  room.hands[2] = hands['2'] || [];
  room.hands[3] = hands['3'] || [];
  room.hands[4] = hands['4'] || [];

  // reset trick/hand state
  room.trick_index = 0;
  room.current_trick = trick.startTrick();
  room.trick_history = [];
  room.spades_broken = false;
  room.books = { A: 0, B: 0 };

  // reset bids
  room.final_bids = null;
  room.bidding = null;

  // reset renege state (per-hand)
  room.renege = {
    calls: [],
    adjustment: { A: 0, B: 0 },
    next_id: 1,
  };

  // ✅ if first hand bids itself -> skip bidding entirely
  if (shouldFirstHandBidItself(room)) {
    room.phase = 'playing';

    const first = trick.leftOfDealer(room.dealer_seat);
    room.turn_seat = first;
    room.current_trick = trick.startTrick(first);

    sendState(room);
    [1, 2, 3, 4].forEach((s) => sendHandToSeat(room, s));
    return;
  }

  // normal flow
  room.phase = 'bidding';
  room.turn_seat = null;
  room.bidding = bidding.initBidding(room);

  sendState(room);
  [1, 2, 3, 4].forEach((s) => sendHandToSeat(room, s));
}

function shouldFirstHandBidItself(room) {
  return !!room?.match_config?.first_hand_bids_itself && Number(room.hand_number) === 1;
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

  // HARD RULE: first hand bids itself → 10+ books ends match immediately
  const firstHandAuto =
    room.hand_number === 1 && !!room.match_config?.first_hand_bids_itself;

  if (firstHandAuto) {
    const aBooks = Number(room.books?.A ?? 0);
    const bBooks = Number(room.books?.B ?? 0);

    if (aBooks >= 10 || bBooks >= 10) {
      broadcastRoom(room, {
        type: 'match_complete',
        winner_team: aBooks === bBooks ? 'tie' : (aBooks > bBooks ? 'A' : 'B'),
        reason: 'first_hand_10plus_books',
        final_score: room.match.score,
      });
      return;
    }
  }

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
      // capture whether player HAD the lead suit BEFORE this play (for renege proof)
      // NOTE: leadSuit is stored as an "effective suit" in your engine
      const leadSuitNow = room.current_trick?.leadSuit || null;
      const hadLedSuitBeforePlay = leadSuitNow ? handHasEffectiveSuit(hand, leadSuitNow) : null;

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

        // renege proof (only meaningful when leadSuitNow is non-null)
        had_led_suit_before_play: hadLedSuitBeforePlay,
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
        plays: room.current_trick.plays.map((p, i) => ({
          seat: p.seat,
          card_id: p.card_id,

          // optional but helpful: deterministic index of the play within the trick
          play_index: i,

          // renege proof flag
          had_led_suit_before_play: p.had_led_suit_before_play,
          played_eff_suit: trick.effectiveSuit(p.card),
        })),
      });

      // ---- HAND END CHECK (THIS IS WHERE YOUR “handIsOver” SNIPPET GOES) ----
      const handIsOver = (room.trick_history.length >= 13); // 13 tricks

      if (handIsOver) {
        
        const isFirstHandBidsItself =
          room.hand_number === 1 && !!room.match_config?.first_hand_bids_itself;

        let r;

        if (isFirstHandBidsItself) {
          const delta = {
            A: Number(room.books.A ?? 0) * 10,
            B: Number(room.books.B ?? 0) * 10,
          };

          room.match.score.A = Number(room.match.score.A ?? 0) + delta.A;
          room.match.score.B = Number(room.match.score.B ?? 0) + delta.B;

          r = {
            ok: true,
            mode: 'first_hand_bids_itself',
            delta,
            bags: room.match.bags,
            detail: { books: room.books },
          };
        } else {
          r = scorePlayedHand(room); // now uses scoring.js (bubble/bags)
        }

        if (!r?.ok) {
          console.error('scorePlayedHand failed:', r?.error);
          return;
        }
        endHandAndMaybeStartNext(room, r);
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

    if (type === 'renege_call') {
      if (!mySeat) {
        safeJsonSend(ws, { type: 'error', error: 'not_seated' });
        return;
      }

      const r = validateAndApplyRenegeCall(room, mySeat, msg);
      if (!r.ok) {
        safeJsonSend(ws, { type: 'error', error: r.error });
        return;
      }

      // broadcast result so UI updates instantly
      broadcastRoom(room, {
        type: 'renege_result',
        record: r.record,
        adjustment: r.adjustment,
      });

      sendState(room);
      return;
    }

    // unknown
    safeJsonSend(ws, { type: 'error', error: 'unknown_message_type' });
  });

  ws.on('close', () => {
    const seat = findSeatByWs(room, ws);
    if (!seat) return;

    // clear socket
    room.seats[seat].ws = null;
    room.seats[seat].ready = false;

    // only enforce during active gameplay phases
    const activePhases = new Set(['bidding', 'negotiating', 'playing']);
    if (!activePhases.has(room.phase)) {
      sendState(room);
      return;
    }

    const takeover = !!room?.match_config?.bot_takeover_on_disconnect;

    // DEFAULT OFF => forfeit
    if (!takeover) {
      const forfeitingTeam = seatToTeam(seat);
      const winnerTeam = otherTeam(forfeitingTeam);

      broadcastRoom(room, {
        type: 'match_complete',
        winner_team: winnerTeam || 'tie',
        reason: 'forfeit_disconnect',
        forfeiting_team: forfeitingTeam,
        forfeiting_seat: seat,
        final_score: room.match?.score,
      });

      // freeze the room so nothing continues after match_complete
      room.phase = 'complete';
      sendState(room);
      return;
    }

    // later (milestone 6): bot takeover path
    sendState(room);
  });


});

server.listen(PORT, () => {
  console.log(`Big Joker Spades WS server running on ws://localhost:${PORT}`);
});