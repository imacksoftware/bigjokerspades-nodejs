// ./bots/default.js

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isJoker(c) {
  return !!c.is_joker || String(c.rank).toUpperCase() === 'JOKER';
}
function isDeuce(c) {
  return String(c.rank) === '2';
}

function cardPowerScore(c) {
  // very simple “strength” heuristic
  if (!c) return 0;
  if (isJoker(c)) return 6;
  if (isDeuce(c)) return 4;
  if (c.is_trump) return 2;
  return 1;
}

function chooseBid(room, seat, hand) {
  // NO NIL: minimum 1
  // heuristic: base=2, add power/rough length signals
  const cards = Array.isArray(hand) ? hand : [];
  let power = 0;
  for (const c of cards) power += cardPowerScore(c);

  // typical power range ~13–35. map that into 2–6-ish
  let bid = 2 + Math.floor(power / 10);

  // slight bump if lots of trump
  const trumpCount = cards.filter(c => !!c.is_trump).length;
  if (trumpCount >= 6) bid += 1;

  bid = clamp(bid, 1, 13);
  return bid;
}

function chooseNegotiationChoice(room, myTeam, negotiation) {
  // basic: if “increase” team and required is close, choose increase; else books_made
  if (!negotiation) return 'books_made';

  const required = Number(negotiation.required_increasing_team_total ?? 0);
  const totals = room?.bidding?.team_totals || room?.bidding?.teamTotals || null;

  const myTotal =
    totals && myTeam ? Number(totals[myTeam] ?? 0) : 0;

  if (myTeam && negotiation.increasing_team === myTeam) {
    if (required && (required - myTotal) <= 1) return 'increase';
  }

  return 'books_made';
}

function chooseNegotiationResponse(room, myTeam, negotiation) {
  // if my team is increasing team, accept if we can plausibly relock (always yes for v1)
  if (!negotiation) return true;
  if (myTeam && negotiation.increasing_team === myTeam) return true;
  return false;
}

module.exports = {
  chooseBid,
  chooseNegotiationChoice,
  chooseNegotiationResponse,
};