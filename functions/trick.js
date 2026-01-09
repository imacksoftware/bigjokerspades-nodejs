// functions/trick.js

function nextSeatClockwise(seat) {
  const s = Number(seat);
  return s === 4 ? 1 : s + 1;
}

function leftOfDealer(dealerSeat) {
  return nextSeatClockwise(dealerSeat);
}

// for trick logic: any trump (spade / jokers / D2 treated as spade) acts like suit "S"
function effectiveSuit(card) {
  if (!card) return null;
  return card.is_trump ? "S" : card.suit;
}

const NON_TRUMP_RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
function nonTrumpRankValue(card) {
  const idx = NON_TRUMP_RANKS.indexOf(card.rank);
  return idx === -1 ? -1 : idx; // higher = stronger because A is last
}

function teamForSeat(seat) {
  const s = Number(seat);
  return (s === 1 || s === 3) ? "A" : "B";
}

// returns true if cardA beats cardB given leadSuit (already effective suit)
function beats(cardA, cardB, leadSuit) {
  const aTrump = !!cardA.is_trump;
  const bTrump = !!cardB.is_trump;

  // trump beats non-trump
  if (aTrump && !bTrump) return true;
  if (!aTrump && bTrump) return false;

  // both trump: compare trump_rank_value (bigger wins)
  if (aTrump && bTrump) {
    return (cardA.trump_rank_value || 0) > (cardB.trump_rank_value || 0);
  }

  // neither trump: only lead suit is eligible
  const aSuit = effectiveSuit(cardA);
  const bSuit = effectiveSuit(cardB);

  if (aSuit === leadSuit && bSuit !== leadSuit) return true;
  if (aSuit !== leadSuit && bSuit === leadSuit) return false;

  // both same suit (usually lead suit): compare rank
  return nonTrumpRankValue(cardA) > nonTrumpRankValue(cardB);
}

function determineTrickWinner(trick) {
  // trick = { leaderSeat, leadSuit, plays: [{seat, card}] }
  if (!trick || !Array.isArray(trick.plays) || trick.plays.length === 0) {
    return null;
  }

  let best = trick.plays[0];

  for (let i = 1; i < trick.plays.length; i++) {
    const cur = trick.plays[i];
    if (beats(cur.card, best.card, trick.leadSuit)) best = cur;
  }

  return best.seat;
}

module.exports = {
  nextSeatClockwise,
  leftOfDealer,
  effectiveSuit,
  teamForSeat,
  determineTrickWinner,
};