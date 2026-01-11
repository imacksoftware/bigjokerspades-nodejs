// functions/bidding.js
// milestone 8: “books made” negotiation loop

/**
 * This module mutates `room` state.
 *
 * server.js should pass a `helpers` object:
 * {
 *   safeSend, broadcast, sendState,
 *   findSeatForClient, teamForSeat,
 *   dealingTeam, nonDealingTeam,
 *   enterPlayingFromBids(room, finalBids),
 *   resolveBooksMadeHand(room, finalBids),
 * }
 */

function computeTeamTotalsFromPicks(picks) {
  const a1 = Number(picks?.[1] ?? 0);
  const a3 = Number(picks?.[3] ?? 0);
  const b2 = Number(picks?.[2] ?? 0);
  const b4 = Number(picks?.[4] ?? 0);
  return { A: a1 + a3, B: b2 + b4 };
}

function teammateSeatFor(team, seatNum) {
  if (team === "A") return seatNum === 1 ? 3 : 1;
  return seatNum === 2 ? 4 : 2;
}

function requirePhase(room, ws, helpers, allowed) {
  const ok = Array.isArray(allowed) ? allowed.includes(room.phase) : room.phase === allowed;
  if (!ok) {
    helpers.safeSend(ws, { type: "error", error: `not_in_${Array.isArray(allowed) ? allowed.join("_or_") : allowed}` });
    return false;
  }
  return true;
}

function initBidding(room, helpers) {
  const nonDeal = helpers.nonDealingTeam(room);
  const deal = helpers.dealingTeam(room);

  room.bidding = {
    picks: { 1: null, 2: null, 3: null, 4: null },
    team_totals: { A: 0, B: 0 },

    // team-level lock for normal bidding
    confirmed: { A: false, B: false },
    lock_order: [nonDeal, deal], // non-dealing locks first
    must_confirm_team: nonDeal,

    // negotiation state (set when needed)
    needs_min_total_resolution: false,
    negotiation: null,

    // negotiation constraints:
    // - during “one team books_made, one team increases”: only that team is editable
    // - players can only edit their own seat bid (never teammate)
    editable_team: null, // 'A' | 'B' | null
    min_picks: null, // baseline picks to enforce “increase only”
  };

  room.final_bids = null;
}

function biddingPublicState(room) {
  const b = room.bidding;
  if (!b) return null;

  return {
    picks: b.picks,
    team_totals: b.team_totals,
    confirmed: b.confirmed,
    lock_order: b.lock_order,
    must_confirm_team: b.must_confirm_team,
    needs_min_total_resolution: b.needs_min_total_resolution,
    negotiation: b.negotiation ? { ...b.negotiation } : null,
    min_total_bid: room.match_config?.min_total_bid ?? 11,
    board: room.match_config?.board ?? 4,
  };
}

/**
 * Called after BOTH teams confirmed their bids and we discover total < min_total_bid.
 */
function enterNegotiation(room, helpers) {
  room.phase = "negotiating";

  const minTotal = Number(room.match_config?.min_total_bid ?? 11);
  room.bidding.needs_min_total_resolution = true;

  // baseline for “increase only”
  room.bidding.min_picks = { ...room.bidding.picks };

  room.bidding.negotiation = {
    stage: "choose", // choose | one_books_waiting_accept | both_increase_relock | resolved_books_made
    choices: { A: null, B: null }, // 'books_made' | 'increase'
    books_made_team: null,
    increasing_team: null,
    required_increasing_team_total: null,
    min_total_bid: minTotal,
  };

  helpers.broadcast(room, {
    type: "negotiation_started",
    room_id: room.roomId,
    min_total_bid: minTotal,
    team_totals: room.bidding.team_totals,
  });

  helpers.sendState(room);
}

function handleBidSet(room, ws, bidRaw, helpers) {
  if (!requirePhase(room, ws, helpers, ["bidding", "negotiating"])) return;

  const seatObj = helpers.findSeatForClient(room, ws._clientId);
  if (!seatObj) return helpers.safeSend(ws, { type: "error", error: "no_seat" });

  const seatNum = seatObj.seat;
  const team = helpers.teamForSeat(seatNum);

  // if we are in negotiation and only 1 team is allowed to edit, enforce it
  if (room.phase === "negotiating" && room.bidding?.editable_team && room.bidding.editable_team !== team) {
    return helpers.safeSend(ws, { type: "error", error: "negotiation_other_team_locked" });
  }

  const bid = Number(bidRaw);
  if (!Number.isFinite(bid) || bid < 0 || bid > 13) {
    return helpers.safeSend(ws, { type: "error", error: "invalid_bid" });
  }

  // if team already confirmed (normal bidding / re-lock), disallow changes
  if (room.bidding.confirmed?.[team]) {
    return helpers.safeSend(ws, { type: "error", error: "team_already_confirmed" });
  }

  // “increase only” constraint if negotiation has started
  if (room.phase === "negotiating" && room.bidding.min_picks) {
    const baseline = Number(room.bidding.min_picks?.[seatNum] ?? 0);
    if (bid < baseline) {
      return helpers.safeSend(ws, { type: "error", error: "negotiation_must_increase_or_hold" });
    }
  }

  room.bidding.picks[seatNum] = bid;
  room.bidding.team_totals = computeTeamTotalsFromPicks(room.bidding.picks);

  helpers.sendState(room);
}

function handleBidConfirm(room, ws, helpers) {
  if (!requirePhase(room, ws, helpers, ["bidding", "negotiating"])) return;

  // during negotiation, bid_confirm is only used in “both_increase_relock”
  if (room.phase === "negotiating") {
    const stage = room.bidding?.negotiation?.stage;
    if (stage !== "both_increase_relock") {
      return helpers.safeSend(ws, { type: "error", error: "bid_confirm_not_allowed_in_this_negotiation_stage" });
    }
  }

  const seatObj = helpers.findSeatForClient(room, ws._clientId);
  if (!seatObj) return helpers.safeSend(ws, { type: "error", error: "no_seat" });

  const seatNum = seatObj.seat;
  const team = helpers.teamForSeat(seatNum);

  // enforce lock order: non-dealing team must confirm first (and in relock too)
  if (team !== room.bidding.must_confirm_team) {
    return helpers.safeSend(ws, { type: "error", error: "not_your_team_turn_to_confirm" });
  }

  // teammate picks must exist
  const mateSeat = teammateSeatFor(team, seatNum);
  const myPick = room.bidding.picks[seatNum];
  const matePick = room.bidding.picks[mateSeat];

  if (myPick === null || myPick === undefined || matePick === null || matePick === undefined) {
    return helpers.safeSend(ws, { type: "error", error: "both_teammates_must_pick" });
  }

  // team total >= board always
  room.bidding.team_totals = computeTeamTotalsFromPicks(room.bidding.picks);
  const teamTotal = Number(room.bidding.team_totals[team] ?? 0);
  const board = Number(room.match_config?.board ?? 4);

  if (teamTotal < board) {
    return helpers.safeSend(ws, { type: "error", error: "team_bid_below_board" });
  }

  // lock it
  room.bidding.confirmed[team] = true;

  // advance lock order
  const [first, second] = room.bidding.lock_order;
  room.bidding.must_confirm_team = team === first ? second : null;

  helpers.sendState(room);

  // if both confirmed, evaluate totals
  if (room.bidding.confirmed.A && room.bidding.confirmed.B) {
    const minTotal = Number(room.match_config?.min_total_bid ?? 11);
    const total = Number(room.bidding.team_totals.A ?? 0) + Number(room.bidding.team_totals.B ?? 0);

    if (total < minTotal) {
      enterNegotiation(room, helpers);
      return;
    }

    // bidding complete -> enter play
    const finalBids = { ...room.bidding.team_totals };
    room.final_bids = { ...room.bidding.team_totals };
    room.bidding = null;

    helpers.broadcast(room, {
      type: "bidding_complete",
      room_id: room.roomId,
      hand_number: room.hand_number,
      final_bids: finalBids,
      dealer_seat: room.dealer_seat,
    });

    helpers.enterPlayingFromBids(room, finalBids);
    helpers.sendState(room);
  }
}

/**
 * negotiation_choice: team chooses 'books_made' or 'increase'
 */
function handleNegotiationChoice(room, ws, choiceRaw, helpers) {
  if (!requirePhase(room, ws, helpers, "negotiating")) return;

  const b = room.bidding;
  if (!b?.negotiation || b.negotiation.stage !== "choose") {
    return helpers.safeSend(ws, { type: "error", error: "negotiation_not_in_choose_stage" });
  }

  const seatObj = helpers.findSeatForClient(room, ws._clientId);
  if (!seatObj) return helpers.safeSend(ws, { type: "error", error: "no_seat" });

  const team = helpers.teamForSeat(seatObj.seat);
  const choice = String(choiceRaw || "").trim();

  if (choice !== "books_made" && choice !== "increase") {
    return helpers.safeSend(ws, { type: "error", error: "invalid_negotiation_choice" });
  }

  // store team choice (idempotent)
  b.negotiation.choices[team] = choice;

  helpers.broadcast(room, {
    type: "negotiation_choice_update",
    room_id: room.roomId,
    choices: b.negotiation.choices,
  });

  helpers.sendState(room);

  const a = b.negotiation.choices.A;
  const bb = b.negotiation.choices.B;
  if (!a || !bb) return;

  // both chose books made -> resolve immediately
  if (a === "books_made" && bb === "books_made") {
    const finalBids = { ...b.team_totals };
    b.negotiation.stage = "resolved_books_made";
    helpers.broadcast(room, {
      type: "negotiation_resolved_books_made",
      room_id: room.roomId,
      final_bids: finalBids,
    });
    helpers.resolveBooksMadeHand(room, finalBids);
    return;
  }

  // one books made, one increases -> no loop
  if ((a === "books_made" && bb === "increase") || (a === "increase" && bb === "books_made")) {
    const booksTeam = a === "books_made" ? "A" : "B";
    const incTeam = booksTeam === "A" ? "B" : "A";

    const minTotal = Number(room.match_config?.min_total_bid ?? 11);
    const locked = Number(b.team_totals[booksTeam] ?? 0);
    const requiredIncTeamTotal = Math.max(0, minTotal - locked);

    b.negotiation.stage = "one_books_waiting_accept";
    b.negotiation.books_made_team = booksTeam;
    b.negotiation.increasing_team = incTeam;
    b.negotiation.required_increasing_team_total = requiredIncTeamTotal;

    // lock the books-made team from editing; allow only incTeam to edit bids (their own seats only)
    b.editable_team = incTeam;

    // reset confirmed for safety (we are now editing again)
    b.confirmed = { A: false, B: false };
    // enforce lock order for the “accept” step by forcing must_confirm_team to incTeam
    b.must_confirm_team = incTeam;

    helpers.broadcast(room, {
      type: "negotiation_one_team_books_made",
      room_id: room.roomId,
      books_made_team: booksTeam,
      increasing_team: incTeam,
      required_increasing_team_total: requiredIncTeamTotal,
      current_team_totals: b.team_totals,
      min_total_bid: minTotal,
      note: "increasing team may adjust bids (increase only). then send negotiation_response yes/no.",
    });

    helpers.sendState(room);
    return;
  }

  // both chose increase -> relock loop
  if (a === "increase" && bb === "increase") {
    const nonDeal = helpers.nonDealingTeam(room);

    b.negotiation.stage = "both_increase_relock";
    b.editable_team = null; // both can edit (still only their own seats)
    b.confirmed = { A: false, B: false };
    b.lock_order = [nonDeal, nonDeal === "A" ? "B" : "A"];
    b.must_confirm_team = nonDeal;

    helpers.broadcast(room, {
      type: "negotiation_both_increase",
      room_id: room.roomId,
      min_total_bid: b.negotiation.min_total_bid,
      current_team_totals: b.team_totals,
      note: "both teams may increase (increase only). then lock bids again.",
    });

    helpers.sendState(room);
  }
}

/**
 * negotiation_response: only used in stage 'one_books_waiting_accept'
 * increasing team says yes/no.
 * - yes: only if team_total >= required_increasing_team_total
 * - no: resolve books made immediately with current totals
 */
function handleNegotiationResponse(room, ws, acceptRaw, helpers) {
  if (!requirePhase(room, ws, helpers, "negotiating")) return;

  const b = room.bidding;
  const n = b?.negotiation;
  if (!n || n.stage !== "one_books_waiting_accept") {
    return helpers.safeSend(ws, { type: "error", error: "negotiation_not_waiting_for_accept" });
  }

  const seatObj = helpers.findSeatForClient(room, ws._clientId);
  if (!seatObj) return helpers.safeSend(ws, { type: "error", error: "no_seat" });

  const team = helpers.teamForSeat(seatObj.seat);

  // only increasing team can respond
  if (team !== n.increasing_team) {
    return helpers.safeSend(ws, { type: "error", error: "only_increasing_team_can_respond" });
  }

  const accept = Boolean(acceptRaw);

  // if no: accept books made outcome immediately
  if (!accept) {
    const finalBids = { ...b.team_totals };
    n.stage = "resolved_books_made";
    helpers.broadcast(room, {
      type: "negotiation_increasing_team_declined",
      room_id: room.roomId,
      final_bids: finalBids,
    });
    helpers.resolveBooksMadeHand(room, finalBids);
    return;
  }

  // accept = yes: must satisfy required team total
  b.team_totals = computeTeamTotalsFromPicks(b.picks);
  const incTotal = Number(b.team_totals[n.increasing_team] ?? 0);
  const required = Number(n.required_increasing_team_total ?? 0);

  if (incTotal < required) {
    return helpers.safeSend(ws, {
      type: "error",
      error: "negotiation_increase_not_enough",
      required_increasing_team_total: required,
      current_increasing_team_total: incTotal,
    });
  }

  // success: finalize bids and enter play
  const finalBids = { ...b.team_totals };
  room.final_bids = { ...finalBids };
  room.bidding = null;

  helpers.broadcast(room, {
    type: "negotiation_increasing_team_accepted",
    room_id: room.roomId,
    final_bids: finalBids,
  });

  helpers.enterPlayingFromBids(room, finalBids);
  helpers.sendState(room);
}

/**
 * If both chose increase, teams re-lock with bid_confirm.
 * When they both confirm again, we either:
 * - proceed to play if >= min_total
 * - or we remain in negotiating and force another increase round
 */
function maybeFinalizeAfterBothIncreaseRelock(room, helpers) {
  if (room.phase !== "negotiating") return;
  const b = room.bidding;
  const n = b?.negotiation;
  if (!b || !n || n.stage !== "both_increase_relock") return;

  if (!b.confirmed?.A || !b.confirmed?.B) return;

  const minTotal = Number(room.match_config?.min_total_bid ?? 11);
  b.team_totals = computeTeamTotalsFromPicks(b.picks);
  const total = Number(b.team_totals.A ?? 0) + Number(b.team_totals.B ?? 0);

  if (total >= minTotal) {
    const finalBids = { ...b.team_totals };
    room.final_bids = { ...finalBids };
    room.bidding = null;

    helpers.broadcast(room, {
      type: "negotiation_both_increase_resolved",
      room_id: room.roomId,
      final_bids: finalBids,
    });

    helpers.enterPlayingFromBids(room, finalBids);
    helpers.sendState(room);
    return;
  }

  // still below: start another choose round
  b.negotiation.stage = "choose";
  b.negotiation.choices = { A: null, B: null };
  b.negotiation.books_made_team = null;
  b.negotiation.increasing_team = null;
  b.negotiation.required_increasing_team_total = null;

  b.needs_min_total_resolution = true;

  // baseline updated to current picks to enforce “increase only” from here
  b.min_picks = { ...b.picks };

  const nonDeal = helpers.nonDealingTeam(room);
  b.confirmed = { A: false, B: false };
  b.lock_order = [nonDeal, nonDeal === "A" ? "B" : "A"];
  b.must_confirm_team = nonDeal;
  b.editable_team = null;

  helpers.broadcast(room, {
    type: "negotiation_still_below_min_total",
    room_id: room.roomId,
    min_total_bid: minTotal,
    team_totals: b.team_totals,
    note: "still below minimum total. choose again: books_made or increase.",
  });

  helpers.sendState(room);
}

module.exports = {
  initBidding,
  biddingPublicState,

  handleBidSet,
  handleBidConfirm,

  handleNegotiationChoice,
  handleNegotiationResponse,

  maybeFinalizeAfterBothIncreaseRelock,
};