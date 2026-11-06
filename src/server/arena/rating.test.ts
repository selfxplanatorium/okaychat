import assert from "node:assert/strict";
import { test } from "node:test";
import { eloPair, replayRatings, type RatingBallot } from "./rating.js";
const a = { key: "a", label: "A", available: true }, b = { key: "b", label: "B", available: false };
const ballot = (seq: number, choice: RatingBallot["choice"]): RatingBallot => ({ seq, choice, a, b });
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
test("equal win/loss and draws match hand calculated constants", () => {
  assert.deepEqual(eloPair(1000, 1000, "A"), [1016, 984]);
  assert.deepEqual(eloPair(1000, 1000, "B"), [984, 1016]);
  assert.deepEqual(eloPair(1000, 1000, "tie"), [1000, 1000]);
  assert.deepEqual(eloPair(1000, 1000, "both_bad"), [1000, 1000]);
});
test("upset moves more than 16 points, conserves total and uses both old ratings", () => {
  const pair = eloPair(1200, 1000, "B");
  near(pair[0], 1175.6880983472654); near(pair[1], 1024.3119016527346);
  near(pair[0] + pair[1], 2200);
  assert.ok(pair[1] - 1000 > 16);
  const next = eloPair(1016, 984, "A");
  near(next[0], 1030.5304984710244); near(next[1], 969.4695015289755);
});
test("no votes means no rows; each draw increments ties, both-bad also increments its own counter", () => {
  assert.deepEqual(replayRatings([]), []);
  const rows = replayRatings([ballot(1, "tie"), ballot(2, "both_bad")]);
  for (const row of rows) {
    assert.equal(row.rating, 1000); assert.equal(row.battles, 2); assert.equal(row.ties, 2);
    assert.equal(row.bothBad, 1); assert.equal(row.losses, 0); assert.equal(row.wins, 0);
    assert.equal(row.winRate, 0); assert.equal(row.scoreRate, 0.5);
    assert.equal(row.rank, null); assert.equal(row.provisional, true);
  }
});
test("sequence is authoritative and repeated replay is bit exact without rounding drift", () => {
  const ballots = Array.from({ length: 301 }, (_, i) => ballot(i + 1, i % 3 === 0 ? "A" : i % 3 === 1 ? "B" : "tie"));
  const expected = replayRatings(ballots);
  assert.deepEqual(replayRatings([...ballots].reverse()), expected);
  assert.deepEqual(replayRatings(ballots), expected);
  near(expected.reduce((n, row) => n + row.rating, 0), 2000);
  for (const row of expected) assert.equal(row.battles, row.wins + row.losses + row.ties);
  assert.throws(() => replayRatings([ballot(1, "A"), ballot(1, "B")]));
  assert.throws(() => replayRatings([{ seq: 1, choice: "A", a, b: a }]));
});
test("19 is provisional, 20 is ranked; tied ratings use battle count and ASCII keys", () => {
  const ballots = Array.from({ length: 19 }, (_, i) => ballot(i + 1, "tie"));
  assert.ok(replayRatings(ballots).every(row => row.provisional && row.rank === null));
  const ranked = replayRatings([...ballots, ballot(20, "tie")]);
  assert.deepEqual(ranked.map(row => [row.modelKey, row.rank, row.provisional]), [["a", 1, false], ["b", 2, false]]);
  assert.deepEqual(replayRatings([ballot(1, "B")]).map(row => [row.modelKey, row.wins, row.losses, row.winRate]), [["b", 1, 0, 1], ["a", 0, 1, 0]]);
});
