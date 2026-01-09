const crypto = require("crypto");

/**
 * Big Joker Spades deck rules:
 * - Start with 52 standard cards
 * - Remove 2♥ and 2♣
 * - Add 2 jokers: one "color", one "bw"
 * - Treat 2♦ as trump (spade) via is_trump metadata (but keep suit/rank as D/2)
 *
 * Config:
 * - big_joker: "color" | "bw"
 * - big_deuce: "D2" | "S2"
 */
function defaultConfig() {
  return {
    big_joker: "color",
    big_deuce: "D2",
  };
}

function buildDeck(config) {
  const cfg = { ...defaultConfig(), ...(config || {}) };

  const suits = ["S", "H", "D", "C"];
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];

  /** @type {Array<Object>} */
  const deck = [];

  for (const suit of suits) {
    for (const rank of ranks) {
      // remove 2♥ and 2♣
      if (rank === "2" && (suit === "H" || suit === "C")) continue;

      deck.push({
        id: `${suit}${rank}`,          // e.g. "D2"
        suit,                          // "S"|"H"|"D"|"C"
        rank,                          // "2".. "A"
        is_joker: false,
        joker_color: null,             // "color"|"bw"|null
        is_trump: false,               // set later
        trump_rank_value: 0,           // set later
      });
    }
  }

  // add jokers
  deck.push({
    id: "JOKER_COLOR",
    suit: "J",
    rank: "JOKER",
    is_joker: true,
    joker_color: "color",
    is_trump: true,
    trump_rank_value: 0,
  });

  deck.push({
    id: "JOKER_BW",
    suit: "J",
    rank: "JOKER",
    is_joker: true,
    joker_color: "bw",
    is_trump: true,
    trump_rank_value: 0,
  });

  // apply trump metadata + ordering
  applyTrumpMeta(deck, cfg);

  // sanity: should be 52
  if (deck.length !== 52) {
    throw new Error(`deck_size_invalid: expected 52, got ${deck.length}`);
  }

  // sanity: removed cards absent
  if (deck.some((c) => c.id === "H2" || c.id === "C2")) {
    throw new Error("removed_cards_present: H2 or C2 found");
  }

  // sanity: jokers present
  if (!deck.some((c) => c.id === "JOKER_COLOR") || !deck.some((c) => c.id === "JOKER_BW")) {
    throw new Error("jokers_missing");
  }

  // sanity: D2 present
  if (!deck.some((c) => c.id === "D2")) {
    throw new Error("D2_missing");
  }

  return deck;
}

/**
 * Sets is_trump and trump_rank_value.
 * Ordering within trump (highest -> lowest):
 * 1) big joker
 * 2) little joker
 * 3) big deuce (D2 or S2)
 * 4) little deuce (the other one)
 * 5) A♠ ... 3♠
 *
 * Notes:
 * - D2 is trump even though suit stays "D"
 * - S2 is normal spade 2
 */
function applyTrumpMeta(deck, config) {
  const cfg = { ...defaultConfig(), ...(config || {}) };

  const bigJoker = cfg.big_joker === "bw" ? "JOKER_BW" : "JOKER_COLOR";
  const littleJoker = bigJoker === "JOKER_COLOR" ? "JOKER_BW" : "JOKER_COLOR";

  const bigDeuceId = cfg.big_deuce === "S2" ? "S2" : "D2";
  const littleDeuceId = bigDeuceId === "D2" ? "S2" : "D2";

  // reset
  for (const c of deck) {
    c.is_trump = false;
    c.trump_rank_value = 0;
  }

  // mark spades as trump
  for (const c of deck) {
    if (!c.is_joker && c.suit === "S") {
      c.is_trump = true;
    }
  }

  // mark D2 as trump regardless of suit
  const d2 = deck.find((c) => c.id === "D2");
  if (d2) d2.is_trump = true;

  // jokers are trump
  const jc = deck.find((c) => c.id === "JOKER_COLOR");
  const jb = deck.find((c) => c.id === "JOKER_BW");
  if (jc) jc.is_trump = true;
  if (jb) jb.is_trump = true;

  // assign trump rank values (bigger = stronger)
  // we’ll keep it simple + consistent.
  let value = 1000;

  const setTrump = (id) => {
    const card = deck.find((c) => c.id === id);
    if (!card) throw new Error(`missing_card_for_trump_ranking: ${id}`);
    card.is_trump = true;
    card.trump_rank_value = value--;
  };

  setTrump(bigJoker);
  setTrump(littleJoker);
  setTrump(bigDeuceId);
  setTrump(littleDeuceId);

  // remaining spades by rank: A K Q J 10 9 ... 3
  const spadeOrder = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3"];
  for (const r of spadeOrder) {
    const id = `S${r}`;
    const card = deck.find((c) => c.id === id);
    if (!card) throw new Error(`missing_spade: ${id}`);
    card.is_trump = true;
    card.trump_rank_value = value--;
  }

  return deck;
}

/**
 * Fisher–Yates shuffle using crypto.randomInt
 * index 0 = top of deck
 */
function shuffleDeck(deck) {
  const a = deck.slice(); // don’t mutate original
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function deckSummary(deck, n = 8) {
  return {
    size: deck.length,
    top: deck.slice(0, n).map((c) => c.id),
    trump_top: deck
      .filter((c) => c.is_trump)
      .sort((x, y) => (y.trump_rank_value || 0) - (x.trump_rank_value || 0))
      .slice(0, n)
      .map((c) => `${c.id}:${c.trump_rank_value}`),
  };
}

module.exports = {
  defaultConfig,
  buildDeck,
  applyTrumpMeta,
  shuffleDeck,
  deckSummary,
};