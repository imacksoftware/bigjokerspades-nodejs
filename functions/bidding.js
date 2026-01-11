// bidding.js

function computeMinTotalBid(board) {
  // classic “board” minimum (4 => 11)
  // your earlier UI/log shows board=4 min_total=11
  // formula: 2*board + 3
  return (Number(board) * 2) + 3;
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

function ensureBidding(room) {
  if (!room.bidding) {
    room.bidding = initBidding(room);
  }
  return room.bidding;
}

function initBidding(room) {
  // board comes from match_config.board if present, else default 4
  const board = Number(room?.match_config?.board ?? room?.match_config?.board_value ?? 4);

  // lock order: NON-dealing confirms first, then dealing confirms
  const deal = dealingTeamFromDealerSeat(room.dealer_seat);
  const nonDeal = nonDealingTeamFromDealerSeat(room.dealer_seat);

  // hard fallback if dealer not known yet (prevents null lock_order)
  const lockOrder = (nonDeal && deal) ? [nonDeal, deal] : ['A', 'B'];

  const minTotal = computeMinTotalBid(board);

  const b = {
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

    // when totals < min_total_bid
    needs_min_total_resolution: false,

    // placeholder for negotiation object (you can expand this later)
    negotiation: null,
  };

  return b;
}

function recomputeTotals(biddingState) {
  const p = biddingState.picks || {};
  const a1 = Number(p[1] ?? 0);
  const a3 = Number(p[3] ?? 0);
  const b2 = Number(p[2] ?? 0);
  const b4 = Number(p[4] ?? 0);

  biddingState.team_totals = {
    A: a1 + a3,
    B: b2 + b4,
  };
}

function biddingPublicState(room) {
  const b = room?.bidding ? room.bidding : null;
  if (!b) return null;

  // keep it JSON-safe + UI-friendly
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

function seatToTeam(seat) {
  const s = Number(seat);
  if (s === 1 || s === 3) return 'A';
  if (s === 2 || s === 4) return 'B';
  return null;
}

function handleBidSet(room, seat, bid) {
  const b = ensureBidding(room);

  const s = Number(seat);
  if (![1, 2, 3, 4].includes(s)) {
    return { ok: false, error: 'invalid_seat' };
  }

  const team = seatToTeam(s);
  if (!team) return { ok: false, error: 'invalid_team' };

  if (b.confirmed?.[team]) {
    return { ok: false, error: 'team_already_confirmed' };
  }

  const v = Number(bid);
  if (!Number.isFinite(v) || v < 0 || v > 13) {
    return { ok: false, error: 'invalid_bid' };
  }

  b.picks[s] = v;

  recomputeTotals(b);

  // if both teams confirmed already, or bidding is locked, you can decide later
  // here we only flag negotiation if BOTH teams are confirmed and totals below min
  const totalAll = Number(b.team_totals.A ?? 0) + Number(b.team_totals.B ?? 0);
  b.needs_min_total_resolution = (b.confirmed.A && b.confirmed.B && totalAll < Number(b.min_total_bid));

  return { ok: true };
}

function handleBidConfirm(room, seat) {
  const b = ensureBidding(room);

  const s = Number(seat);
  const team = seatToTeam(s);
  if (!team) return { ok: false, error: 'invalid_team' };

  // must be that team's turn to confirm
  if (!b.must_confirm_team || team !== b.must_confirm_team) {
    return { ok: false, error: 'not_your_team_turn_to_confirm' };
  }

  // confirm them
  b.confirmed[team] = true;

  // advance must_confirm_team according to lock_order
  const [first, second] = b.lock_order || [null, null];

  if (team === first) {
    // after first confirms, second should be up next
    b.must_confirm_team = second ?? null;
  } else {
    // after second confirms, no one left
    b.must_confirm_team = null;
  }

  // once both confirmed, determine if min total is met
  recomputeTotals(b);
  const totalAll = Number(b.team_totals.A ?? 0) + Number(b.team_totals.B ?? 0);
  b.needs_min_total_resolution = (b.confirmed.A && b.confirmed.B && totalAll < Number(b.min_total_bid));

  return { ok: true };
}

module.exports = {
  initBidding,
  biddingPublicState,
  handleBidSet,
  handleBidConfirm,
};
