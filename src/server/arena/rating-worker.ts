import { parentPort } from "node:worker_threads";
import { replayRatings, type RatingBallot } from "./rating.js";
parentPort?.on("message", (message: { id: number; ballots: RatingBallot[] }) => {
  try { parentPort?.postMessage({ id: message.id, rows: replayRatings(message.ballots) }); }
  catch { parentPort?.postMessage({ id: message.id, error: true }); }
});
