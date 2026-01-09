/**
 * "First diamond deals":
 * - shuffle full deck
 * - deal one card at a time to seats 1..4 repeating
 * - first seat to receive a diamond (suit === "D") becomes dealer
 * - then you reshuffle for the real game
 *
 * Note: D2 still has suit "D", so it counts as a diamond here (correct).
 */
function determineFirstDealerSeat(shuffledDeck) {
  if (!Array.isArray(shuffledDeck) || shuffledDeck.length !== 52) {
    throw new Error(`probe_invalid_deck: expected 52, got ${shuffledDeck?.length}`);
  }

  for (let i = 0; i < shuffledDeck.length; i++) {
    const card = shuffledDeck[i];
    const seat = (i % 4) + 1;

    if (card && card.suit === "D") {
      return { dealer_seat: seat, found_card_id: card.id, dealt_index: i };
    }
  }

  // should never happen in a standard deck
  throw new Error("probe_no_diamond_found");
}

module.exports = { determineFirstDealerSeat };