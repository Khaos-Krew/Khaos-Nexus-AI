import { validateSessionIntelligenceResult } from "./session-intelligence.js";

export function projectPublicSessionIntelligence(value) {
  const result = validateSessionIntelligenceResult(value);
  return {
    version: result.version,
    sessionTitle: result.sessionTitle,
    playerRecap: result.playerRecap,
    canonFacts: result.canonFacts
      .filter((item) => item.public)
      .map((item) => ({
        statement: item.statement,
        confidence: item.confidence,
      })),
    unresolvedThreads: result.unresolvedThreads
      .filter((item) => item.public)
      .map((item) => ({
        thread: item.thread,
        status: item.status,
      })),
  };
}
