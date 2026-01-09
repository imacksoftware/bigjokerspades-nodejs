/**
 * Deal 13 cards to each seat (1..4).
 * Assumes deck is already shuffled and has 52 cards.
 * index 0 = top of deck.
 *
 * Returns:
 * {
 *   1: [13 card objects],
 *   2: [13 card objects],
 *   3: [13 card objects],
 *   4: [13 card objects],
 * }
 */
function dealHands(shuffledDeck) {
  if (!Array.isArray(shuffledDeck) || shuffledDeck.length !== 52) {
    throw new Error(`deal_invalid_deck: expected 52, got ${shuffledDeck?.length}`);
  }

  const hands = { 1: [], 2: [], 3: [], 4: [] };

  // simplest deal: 13 each in seat order (1->2->3->4 repeating)
  let seat = 1;
  for (let i = 0; i < shuffledDeck.length; i++) {
    hands[seat].push(shuffledDeck[i]);
    seat++;
    if (seat > 4) seat = 1;
  }

  // sanity
  for (const s of [1, 2, 3, 4]) {
    if (hands[s].length !== 13) throw new Error(`deal_bad_hand_size: seat ${s} got ${hands[s].length}`);
  }

  return hands;
}

module.exports = { dealHands };