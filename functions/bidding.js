// functions/bidding.js
const scoring = require('./scoring');

function computeMinTotalBidFromBoard(board) {
  // classic “board” minimum (4 => 11)
  // formula: 2*board + 3
  return (Number(board) * 2) + 3;
}

function getBoard(room) {
  return Number(room?.match_config?.board ?? room?.match_config?.board_value ?? 4);
}

function getMinTotal(room, board) {
  // allow explicit override if you ever add it
  const override = room?.match_config?.min_total_bid;
  if (override !== null && override !== undefined) return Number(override);
  return computeMinTotalBidFromBoard(board);
}

function dealingTeamFromDealerSeat(dealerSeat) {
  const s = Number(dealerSeat);
  if (s === 1 || s === 3) return 'A';
  if (s === 2 || s === 4) return 'B';
  return null;
}

function nonDealingTeamFromDealerSeat(dealerSeat) {
  const deal = dealingTeamFromDealerSeat(dealerSeat);
  if (!deal) return null;
  return deal === 'A' ? 'B' : 'A';
}

function seatToTeam(seat) {
  const s = Number(seat);
  if (s === 1 || s === 3) return 'A';
  if (s === 2 || s === 4) return 'B';
  return null;
}

function ensureBidding(room) {
  if (!room.bidding) {
    room.bidding = initBidding(room);
  }
  return room.bidding;
}

function initBidding(room) {
  const board = getBoard(room);

  // lock order: NON-dealing confirms first, then dealing confirms
  const deal = dealingTeamFromDealerSeat(room.dealer_seat);
  const nonDeal = nonDealingTeamFromDealerSeat(room.dealer_seat);

  // hard fallback if dealer not known yet (prevents null lock_order)
  const lockOrder = (nonDeal && deal) ? [nonDeal, deal] : ['A', 'B'];

  const minTotal = getMinTotal(room, board);

  return {
    board,
    min_total_bid: minTotal,

    // seat picks
    picks: { 1: null, 2: null, 3: null, 4: null },

    // totals by team
    team_totals: { A: 0, B: 0 },

    // lock state per team
    confirmed: { A: false, B: false },

    // which team should confirm next
    lock_order: lockOrder,
    must_confirm_team: lockOrder[0] ?? null,

    // below-min indicator for UI
    needs_min_total_resolution: false,

    // negotiation state
    negotiation: null,

    // used to enforce “increase only” during negotiation
    min_picks: null,

    // if set, only that team can edit bids in negotiation
    editable_team: null,
  };
}

function recomputeTotals(b) {
  const p = b.picks || {};
  const a1 = Number(p[1] ?? 0);
  const a3 = Number(p[3] ?? 0);
  const b2 = Number(p[2] ?? 0);
  const b4 = Number(p[4] ?? 0);

  b.team_totals = {
    A: a1 + a3,
    B: b2 + b4,
  };
}

function totalAll(b) {
  return Number(b.team_totals?.A ?? 0) + Number(b.team_totals?.B ?? 0);
}

function biddingPublicState(room) {
  const b = room?.bidding ? room.bidding : null;
  if (!b) return null;

  return {
    picks: b.picks,
    team_totals: b.team_totals,
    confirmed: b.confirmed,
    lock_order: b.lock_order,
    must_confirm_team: b.must_confirm_team,
    needs_min_total_resolution: !!b.needs_min_total_resolution,
    negotiation: b.negotiation,
    min_total_bid: b.min_total_bid,
    board: b.board,
  };
}

function enterNegotiation(room) {
  const b = ensureBidding(room);

  room.phase = 'negotiating';

  b.needs_min_total_resolution = true;
  b.min_picks = { ...b.picks }; // baseline for “increase only”
  b.editable_team = null;

  b.negotiation = {
    stage: 'choose', // choose | one_books_waiting_accept | both_increase_relock | resolved_books_made | resolved_to_play
    choices: { A: null, B: null }, // 'books_made' | 'increase'
    books_made_team: null,
    increasing_team: null,
    required_increasing_team_total: null,
    min_total_bid: b.min_total_bid,
  };

  // during choose stage, nobody edits bids (only chooses)
  b.confirmed = { A: false, B: false };
  b.must_confirm_team = null;
}

function resolveToPlaying(room) {
  const b = ensureBidding(room);
  room.final_bids = { ...b.team_totals };

  // if you wire playing later, this is where you’d transition cleanly
  room.phase = 'playing';

  // negotiation over / bidding over
  b.needs_min_total_resolution = false;
  b.editable_team = null;

  if (b.negotiation) {
    b.negotiation.stage = 'resolved_to_play';
  }
}

function resolveBooksMade(room) {
  const b = ensureBidding(room);
  room.final_bids = { ...b.team_totals };

  // this is a terminal outcome (you can hook “score as books made” later)
  // for now, we keep the room in negotiating but with a resolved stage,
  // so UI can see the result and you can decide what next.
  room.phase = 'negotiating';
  b.needs_min_total_resolution = false;
  b.editable_team = null;

  if (b.negotiation) {
    b.negotiation.stage = 'resolved_books_made';
  }
}

/**
 * bid_set
 * - allowed in phase bidding
 * - allowed in phase negotiating only when stage permits editing
 */
function handleBidSet(room, seat, bid) {
  const b = ensureBidding(room);

  const s = Number(seat);
  if (![1, 2, 3, 4].includes(s)) return { ok: false, error: 'invalid_seat' };

  const team = seatToTeam(s);
  if (!team) return { ok: false, error: 'invalid_team' };

  const v = Number(bid);
  if (!Number.isFinite(v) || v < 0 || v > 13) return { ok: false, error: 'invalid_bid' };

  // negotiation gating
  if (room.phase === 'negotiating') {
    const stage = b.negotiation?.stage;

    // in choose stage, no bid editing (only choose increase/books made)
    if (stage === 'choose') return { ok: false, error: 'negotiation_choose_stage_no_bid_edit' };

    // in one-books-made flow, only increasing team may edit bids
    if (stage === 'one_books_waiting_accept') {
      if (!b.negotiation?.increasing_team || team !== b.negotiation.increasing_team) {
        return { ok: false, error: 'negotiation_other_team_locked' };
      }
    }

    // if editable_team is set, enforce it
    if (b.editable_team && b.editable_team !== team) {
      return { ok: false, error: 'negotiation_other_team_locked' };
    }

    // “increase only” (or hold) baseline
    if (b.min_picks) {
      const baseline = Number(b.min_picks?.[s] ?? 0);
      if (v < baseline) return { ok: false, error: 'negotiation_must_increase_or_hold' };
    }
  }

  // once a team confirms in current lock cycle, it can't change
  if (b.confirmed?.[team]) {
    return { ok: false, error: 'team_already_confirmed' };
  }

  b.picks[s] = v;
  recomputeTotals(b);

  // update below-min flag if we’re in bidding and already both confirmed (rare)
  if (b.confirmed.A && b.confirmed.B) {
    b.needs_min_total_resolution = (totalAll(b) < Number(b.min_total_bid));
  }

  return { ok: true };
}

/**
 * bid_confirm
 * - in bidding: normal lock order A/B depending on dealer
 * - in negotiating: only used in stage both_increase_relock (re-lock loop)
 */
function handleBidConfirm(room, seat) {
  const b = ensureBidding(room);

  const s = Number(seat);
  const team = seatToTeam(s);
  if (!team) return { ok: false, error: 'invalid_team' };

  if (room.phase === 'negotiating') {
    const stage = b.negotiation?.stage;
    if (stage !== 'both_increase_relock') {
      return { ok: false, error: 'bid_confirm_not_allowed_in_this_negotiation_stage' };
    }
  }

  // must be that team's turn to confirm
  if (!b.must_confirm_team || team !== b.must_confirm_team) {
    return { ok: false, error: 'not_your_team_turn_to_confirm' };
  }

  // require BOTH teammates have picks before confirming
  const mateSeat = (team === 'A') ? (s === 1 ? 3 : 1) : (s === 2 ? 4 : 2);
  const myPick = b.picks?.[s];
  const matePick = b.picks?.[mateSeat];

  if (myPick === null || myPick === undefined || matePick === null || matePick === undefined) {
    return { ok: false, error: 'both_teammates_must_pick' };
  }

  // enforce team total >= board
  recomputeTotals(b);
  const teamTotal = Number(b.team_totals?.[team] ?? 0);
  if (teamTotal < Number(b.board ?? 4)) {
    return { ok: false, error: 'team_bid_below_board' };
  }

  // lock it
  b.confirmed[team] = true;

  // advance must_confirm_team according to lock_order
  const [first, second] = b.lock_order || [null, null];
  if (team === first) {
    b.must_confirm_team = second ?? null;
  } else {
    b.must_confirm_team = null;
  }

  // if both confirmed, decide next step
  if (b.confirmed.A && b.confirmed.B) {
    recomputeTotals(b);
    const t = totalAll(b);

    // normal bidding -> if below min, enter negotiation
    if (room.phase === 'bidding') {
      if (t < Number(b.min_total_bid)) {
        enterNegotiation(room);
        return { ok: true };
      }

      // otherwise bidding done -> playing (for later)
      resolveToPlaying(room);
      return { ok: true };
    }

    // negotiation relock loop
    if (room.phase === 'negotiating' && b.negotiation?.stage === 'both_increase_relock') {
      if (t >= Number(b.min_total_bid)) {
        resolveToPlaying(room);
        return { ok: true };
      }

      // still below -> back to choose again, update baseline
      b.min_picks = { ...b.picks };
      b.needs_min_total_resolution = true;

      b.negotiation.stage = 'choose';
      b.negotiation.choices = { A: null, B: null };
      b.negotiation.books_made_team = null;
      b.negotiation.increasing_team = null;
      b.negotiation.required_increasing_team_total = null;

      // reset lock state for next round
      b.confirmed = { A: false, B: false };
      b.must_confirm_team = null;
      b.editable_team = null;

      return { ok: true };
    }
  }

  // update below-min flag for UI
  recomputeTotals(b);
  b.needs_min_total_resolution = (b.confirmed.A && b.confirmed.B && totalAll(b) < Number(b.min_total_bid));

  return { ok: true };
}

/**
 * negotiation_choice: team selects 'books_made' or 'increase'
 */
function handleNegotiationChoice(room, seat, choiceRaw) {
  const b = ensureBidding(room);

  if (room.phase !== 'negotiating') return { ok: false, error: 'not_in_negotiating' };
  if (!b.negotiation || b.negotiation.stage !== 'choose') return { ok: false, error: 'negotiation_not_in_choose_stage' };

  const team = seatToTeam(seat);
  if (!team) return { ok: false, error: 'invalid_team' };

  const choice = String(choiceRaw || '').trim();
  if (choice !== 'books_made' && choice !== 'increase') return { ok: false, error: 'invalid_negotiation_choice' };

  b.negotiation.choices[team] = choice;

  const a = b.negotiation.choices.A;
  const bb = b.negotiation.choices.B;
  if (!a || !bb) return { ok: true };

  // both books made -> resolve now
  if (a === 'books_made' && bb === 'books_made') {
    resolveBooksMade(room);
    return { ok: true };
  }

  // one books, one increase -> increasing team edits bids (increase-only), then yes/no
  if ((a === 'books_made' && bb === 'increase') || (a === 'increase' && bb === 'books_made')) {
    recomputeTotals(b);

    const booksTeam = (a === 'books_made') ? 'A' : 'B';
    const incTeam = (booksTeam === 'A') ? 'B' : 'A';

    const locked = Number(b.team_totals?.[booksTeam] ?? 0);
    const required = Math.max(0, Number(b.min_total_bid) - locked);

    b.negotiation.stage = 'one_books_waiting_accept';
    b.negotiation.books_made_team = booksTeam;
    b.negotiation.increasing_team = incTeam;
    b.negotiation.required_increasing_team_total = required;

    // only increasing team can edit bids
    b.editable_team = incTeam;

    // confirmation not used here; decision is via negotiation_response yes/no
    b.confirmed = { A: false, B: false };
    b.must_confirm_team = null;

    return { ok: true };
  }

  // both increase -> both teams increase, then re-lock
  if (a === 'increase' && bb === 'increase') {
    const deal = dealingTeamFromDealerSeat(room.dealer_seat);
    const nonDeal = nonDealingTeamFromDealerSeat(room.dealer_seat);

    const lockOrder = (nonDeal && deal) ? [nonDeal, deal] : ['A', 'B'];

    b.negotiation.stage = 'both_increase_relock';
    b.editable_team = null;

    // reset lock state and enforce non-dealing confirms first
    b.confirmed = { A: false, B: false };
    b.lock_order = lockOrder;
    b.must_confirm_team = lockOrder[0] ?? null;

    return { ok: true };
  }

  return { ok: true };
}

/**
 * negotiation_response: only used when one team chose books_made and the other chose increase
 * increasing team answers yes/no
 */
function handleNegotiationResponse(room, seat, acceptRaw) {
  const b = ensureBidding(room);

  if (room.phase !== 'negotiating') return { ok: false, error: 'not_in_negotiating' };
  if (!b.negotiation || b.negotiation.stage !== 'one_books_waiting_accept') {
    return { ok: false, error: 'negotiation_not_waiting_for_accept' };
  }

  const team = seatToTeam(seat);
  if (!team) return { ok: false, error: 'invalid_team' };

  // only increasing team may respond
  if (team !== b.negotiation.increasing_team) {
    return { ok: false, error: 'only_increasing_team_can_respond' };
  }

  const accept = !!acceptRaw;

  // if no -> books made resolves immediately at current totals
  if (!accept) {
    resolveBooksMade(room);
    return { ok: true };
  }

  // yes -> must meet required team total
  recomputeTotals(b);

  const required = Number(b.negotiation.required_increasing_team_total ?? 0);
  const incTotal = Number(b.team_totals?.[b.negotiation.increasing_team] ?? 0);

  if (incTotal < required) {
    return {
      ok: false,
      error: 'negotiation_increase_not_enough',
    };
  }

  // success -> proceed to playing
  resolveToPlaying(room);
  return { ok: true };
}

function scoreBooksMadeHand(room) {
  const b = room?.bidding;
  if (!b) return { ok: false, error: 'no_bidding_state' };

  const bidA = Number(b.team_totals?.A ?? 0);
  const bidB = Number(b.team_totals?.B ?? 0);

  // books-made means made == bid
  const madeA = bidA;
  const madeB = bidB;

  const cfg = room.match_config || {};
  const res = scoring.scoreHand({
    bidA, bidB,
    madeA, madeB,
    match: room.match,
    cfg,
  });

  room.match.score.A = Number(room.match.score.A ?? 0) + res.delta.A;
  room.match.score.B = Number(room.match.score.B ?? 0) + res.delta.B;

  // bags update
  if (!room.match.bags) room.match.bags = { A: 0, B: 0 };
  room.match.bags.A = res.bags.A;
  room.match.bags.B = res.bags.B;

  return { ok: true, mode: 'books_made', ...res };
}

function negotiationIsResolvedBooksMade(room) {
  const n = room?.bidding?.negotiation;
  return !!n && n.stage === 'resolved_books_made';
}

module.exports = {
  initBidding,
  biddingPublicState,
  handleBidSet,
  handleBidConfirm,
  handleNegotiationChoice,
  handleNegotiationResponse,
  scoreBooksMadeHand,
  negotiationIsResolvedBooksMade,
};



