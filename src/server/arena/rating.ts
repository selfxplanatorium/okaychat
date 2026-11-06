import { ARENA_LIMITS, type ArenaChoice, type LeaderboardRow } from "../../shared/arena.js";

export interface RatingModel { key: string; label: string; available: boolean }
export interface RatingBallot { seq: number; choice: ArenaChoice; a: RatingModel; b: RatingModel }
const ascii = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function eloPair(a: number, b: number, choice: ArenaChoice): readonly [number, number] {
  const expected = 1 / (1 + 10 ** ((b - a) / 400));
  const score = choice === "A" ? 1 : choice === "B" ? 0 : 0.5;
  const delta = ARENA_LIMITS.k * (score - expected);
  return [a + delta, b - delta];
}

/** Replay only compact, authorized ballots; never load prompts or responses for rating work. */
export function replayRatings(ballots: readonly RatingBallot[]): LeaderboardRow[] {
  const models = new Map<string, LeaderboardRow>();
  const get = (model: RatingModel): LeaderboardRow => {
    let row = models.get(model.key);
    if (!row) {
      row = { modelKey: model.key, label: model.label, available: model.available, rank: null, rating: 1000,
        battles: 0, wins: 0, losses: 0, ties: 0, bothBad: 0, winRate: null, scoreRate: null, provisional: true };
      models.set(model.key, row);
    }
    return row;
  };
  let previous = 0;
  for (const ballot of [...ballots].sort((a, b) => a.seq - b.seq)) {
    if (!Number.isSafeInteger(ballot.seq) || ballot.seq <= previous || ballot.a.key === ballot.b.key) throw new Error("Invalid Arena ballot sequence or pair");
    previous = ballot.seq;
    const a = get(ballot.a), b = get(ballot.b);
    [a.rating, b.rating] = eloPair(a.rating, b.rating, ballot.choice);
    a.battles++; b.battles++;
    if (ballot.choice === "A") { a.wins++; b.losses++; }
    else if (ballot.choice === "B") { b.wins++; a.losses++; }
    else { a.ties++; b.ties++; if (ballot.choice === "both_bad") { a.bothBad++; b.bothBad++; } }
  }
  const rows = [...models.values()];
  for (const row of rows) {
    row.winRate = row.wins / row.battles;
    row.scoreRate = (row.wins + 0.5 * row.ties) / row.battles;
    row.provisional = row.battles < ARENA_LIMITS.minimumBattles;
  }
  rows.sort((a, b) => Number(a.provisional) - Number(b.provisional) || b.rating - a.rating || b.battles - a.battles || ascii(a.modelKey, b.modelKey));
  let rank = 0;
  for (const row of rows) if (!row.provisional) row.rank = ++rank;
  return rows;
}
