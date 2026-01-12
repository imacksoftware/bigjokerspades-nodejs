// functions/scoring.js

function scoreTeam({ bid, made, bags, cfg }) {
  const tenForTwo = !!cfg.ten_for_two_enabled;

  // 10-for-2 / bubble rule: bid >= 10 → 200 points if make, -200 if set
  if (tenForTwo && bid >= 10) {
    if (made >= bid) {
      return { points: 200, bags_add: made - bid };
    }
    return { points: -200, bags_add: 0 };
  }

  // standard spades scoring
  if (made >= bid) {
    return { points: (bid * 10), bags_add: (made - bid) };
  }
  return { points: -(bid * 10), bags_add: 0 };
}

function applyBagsPenalty({ bags, cfg }) {
  if (!cfg.bags_enabled) return { bags, penalty: 0 };

  const at = Number(cfg.bags_penalty_at ?? 10);
  const penaltyPts = Number(cfg.bags_penalty_points ?? 100);

  let penalty = 0;
  let newBags = bags;

  while (newBags >= at) {
    newBags -= at;
    penalty -= penaltyPts;
  }

  return { bags: newBags, penalty };
}

function scoreHand({ bidA, bidB, madeA, madeB, match, cfg }) {
  const curBagsA = Number(match.bags?.A ?? 0);
  const curBagsB = Number(match.bags?.B ?? 0);

  const rA = scoreTeam({ bid: bidA, made: madeA, bags: curBagsA, cfg });
  const rB = scoreTeam({ bid: bidB, made: madeB, bags: curBagsB, cfg });

  let nextBagsA = curBagsA + (cfg.bags_enabled ? rA.bags_add : 0);
  let nextBagsB = curBagsB + (cfg.bags_enabled ? rB.bags_add : 0);

  const pA = applyBagsPenalty({ bags: nextBagsA, cfg });
  const pB = applyBagsPenalty({ bags: nextBagsB, cfg });

  nextBagsA = pA.bags;
  nextBagsB = pB.bags;

  const deltaA = rA.points + pA.penalty;
  const deltaB = rB.points + pB.penalty;

  return {
    delta: { A: deltaA, B: deltaB },
    bags: { A: nextBagsA, B: nextBagsB },
    detail: {
      A: { bid: bidA, made: madeA, base: rA.points, bags_add: rA.bags_add, bag_penalty: pA.penalty },
      B: { bid: bidB, made: madeB, base: rB.points, bags_add: rB.bags_add, bag_penalty: pB.penalty },
    },
  };
}

module.exports = { scoreHand };