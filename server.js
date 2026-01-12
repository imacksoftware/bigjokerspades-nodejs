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
      // optional override:
      // min_total_bid: 11,
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

function maybeStartFromLobby(room) {
  if (room.phase !== 'lobby') return;
  if (!allSeatedAndReady(room)) return;
  startNewHand(room);
}

function maybeAutoResolveNegotiation(room) {
  // only do anything if we're negotiating
  if (room.phase !== 'negotiating') return;

  // if both teams picked books_made, bidding.js marks negotiation as resolved
  if (bidding.negotiationIsResolvedBooksMade(room)) {
    // apply score (based on current team_totals)
    const r = bidding.scoreBooksMadeHand(room);
    if (!r?.ok) {
      // if something unexpected happens, don't crash the server
      console.error('scoreBooksMadeHand failed:', r?.error);
      return;
    }

    // immediately start next hand (keeps game flowing)
    startNewHand(room);
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

      sendState(room);
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

      sendState(room);
      maybeAutoResolveNegotiation(room);
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