import { createHash } from "node:crypto";
import { canonicalJson, createPlayerMapScene, sceneHash, validateMapScene } from "./map-scenes.js";

const OUTCOMES = ["pass", "warn", "fail"];
const CATEGORIES = [
  "player_agency",
  "secret_leakage",
  "lore_consistency",
  "mechanics",
  "homebrew_balance",
  "copyright",
  "map_integrity",
  "latency",
  "cost",
];

function result(category, outcome, message, evidence = []) {
  if (!CATEGORIES.includes(category) || !OUTCOMES.includes(outcome)) throw new Error("Invalid evaluation result");
  return {
    category,
    outcome,
    message,
    evidence: evidence.slice(0, 20).map((item) => {
      const value = String(item).slice(0, 2_000);
      return { sha256: createHash("sha256").update(value).digest("hex"), length: value.length };
    }),
  };
}

function text(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return canonicalJson(value);
}

function normalized(value) {
  return text(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function playerAgency(artifact) {
  const output = normalized(artifact.output);
  const patterns = [
    /\byou (?:decide|agree|confess|promise|attack|kill|steal|flee|surrender|say|think|feel)\b/g,
    /\byour character (?:decides|agrees|confesses|promises|attacks|kills|steals|flees|surrenders|says|thinks|feels)\b/g,
  ];
  const matches = patterns.flatMap((pattern) => [...output.matchAll(pattern)].map((match) => match[0]));
  if (matches.length) return result("player_agency", "fail", "Output appears to decide player-character actions or internal state.", matches);
  if (!/\b(choice|choose|could|may|option|what do you do|how do you respond)\b/.test(output)) {
    return result("player_agency", "warn", "Output does not clearly preserve or return a player decision point.");
  }
  return result("player_agency", "pass", "No deterministic player-agency violation was detected.");
}

function secretLeakage(artifact) {
  const output = normalized(artifact.publicOutput ?? artifact.output);
  const secrets = Array.isArray(artifact.secrets) ? artifact.secrets : [];
  const leaked = secrets.map(normalized).filter((secret) => secret.length >= 8 && output.includes(secret));
  if (leaked.length) return result("secret_leakage", "fail", "Public output contains configured secret text.", leaked);
  return result("secret_leakage", "pass", "No configured secret appeared in public output.");
}

function loreConsistency(artifact) {
  const contradictions = Array.isArray(artifact.contradictions) ? artifact.contradictions.filter(Boolean) : [];
  if (contradictions.length) return result("lore_consistency", "fail", "Explicit lore contradictions were supplied or detected.", contradictions);
  const warnings = Array.isArray(artifact.loreWarnings) ? artifact.loreWarnings.filter(Boolean) : [];
  if (warnings.length) return result("lore_consistency", "warn", "Lore consistency requires review.", warnings);
  return result("lore_consistency", "pass", "No explicit lore contradiction was detected.");
}

function mechanics(artifact) {
  const checks = Array.isArray(artifact.checks) ? artifact.checks : [];
  const invalid = [];
  for (const [index, check] of checks.entries()) {
    if (!Number.isInteger(check?.dc) || check.dc < 1 || check.dc > 40) invalid.push(`checks[${index}].dc`);
    if (typeof check?.ability !== "string" || !check.ability.trim()) invalid.push(`checks[${index}].ability`);
  }
  if (invalid.length) return result("mechanics", "fail", "Structured mechanics contain invalid bounded values.", invalid);
  if (artifact.mechanicsValid === false) return result("mechanics", "fail", "The caller marked the mechanics as invalid.");
  return result("mechanics", "pass", "Structured mechanics passed deterministic bounds checks.");
}

function homebrewBalance(artifact) {
  const homebrew = artifact.homebrew ?? artifact.output;
  if (!homebrew || typeof homebrew !== "object") return result("homebrew_balance", "warn", "No structured homebrew artifact was supplied.");
  const risks = homebrew.balance?.risks;
  const checks = homebrew.balance?.playtestChecks;
  const mechanicsList = homebrew.mechanics;
  if (!Array.isArray(mechanicsList) || mechanicsList.length === 0) return result("homebrew_balance", "fail", "Homebrew has no structured mechanics.");
  if (!Array.isArray(risks) || risks.length === 0 || !Array.isArray(checks) || checks.length === 0) {
    return result("homebrew_balance", "warn", "Homebrew lacks explicit risks or playtest checks.");
  }
  const unlimited = mechanicsList.filter((item) => !String(item?.limits ?? "").trim()).map((item) => item?.name ?? "unnamed mechanic");
  if (unlimited.length) return result("homebrew_balance", "warn", "Some mechanics have no explicit usage limits.", unlimited);
  return result("homebrew_balance", "pass", "Homebrew includes mechanics, limits, risks, and playtest checks.");
}

function copyrightRisk(artifact) {
  const request = normalized(artifact.requestText ?? artifact.input);
  const output = normalized(artifact.output);
  const prohibited = /\b(verbatim|exact copy|full text|entire chapter|reconstruct|word[- ]for[- ]word|identical replica)\b/;
  if (prohibited.test(request) || prohibited.test(output)) return result("copyright", "fail", "Reconstruction or verbatim-copy language was detected.");
  const excerpts = Array.isArray(artifact.protectedExcerpts) ? artifact.protectedExcerpts : [];
  const overlaps = excerpts.map(normalized).filter((item) => item.length >= 80 && output.includes(item));
  if (overlaps.length) return result("copyright", "fail", "Output contains a long protected excerpt.", overlaps);
  return result("copyright", "pass", "No deterministic reconstruction or long-excerpt match was detected.");
}

function mapIntegrity(artifact) {
  if (!artifact.gmScene && !artifact.playerScene) return result("map_integrity", "warn", "No map scene artifact was supplied.");
  try {
    const gm = artifact.gmScene ? validateMapScene(artifact.gmScene) : null;
    const player = artifact.playerScene ? validateMapScene(artifact.playerScene) : null;
    if (gm && player) {
      const expected = createPlayerMapScene(gm);
      if (sceneHash(expected) !== sceneHash(player)) return result("map_integrity", "fail", "Player scene is not the canonical filtered GM projection.");
    }
    return result("map_integrity", "pass", "Map scenes passed bounds and player-projection validation.");
  } catch (error) {
    return result("map_integrity", "fail", "Map scene validation failed.", [error.message]);
  }
}

function latency(artifact) {
  const value = Number(artifact.latencyMs ?? 0);
  const warnAt = Number(artifact.latencyWarnMs ?? 15_000);
  const failAt = Number(artifact.latencyFailMs ?? 60_000);
  if (!Number.isFinite(value) || value < 0) return result("latency", "fail", "Latency is invalid.");
  if (value >= failAt) return result("latency", "fail", "Latency exceeded the failure threshold.", [`${value}ms`]);
  if (value >= warnAt) return result("latency", "warn", "Latency exceeded the warning threshold.", [`${value}ms`]);
  return result("latency", "pass", "Latency is within the configured threshold.", [`${value}ms`]);
}

function cost(artifact) {
  const value = Number(artifact.costMicros ?? 0);
  const warnAt = Number(artifact.costWarnMicros ?? 100_000);
  const failAt = Number(artifact.costFailMicros ?? 1_000_000);
  if (!Number.isFinite(value) || value < 0) return result("cost", "fail", "Estimated cost is invalid.");
  if (value >= failAt) return result("cost", "fail", "Estimated cost exceeded the failure threshold.", [`${value} micros`]);
  if (value >= warnAt) return result("cost", "warn", "Estimated cost exceeded the warning threshold.", [`${value} micros`]);
  return result("cost", "pass", "Estimated cost is within the configured threshold.", [`${value} micros`]);
}

const RUNNERS = {
  player_agency: playerAgency,
  secret_leakage: secretLeakage,
  lore_consistency: loreConsistency,
  mechanics,
  homebrew_balance: homebrewBalance,
  copyright: copyrightRisk,
  map_integrity: mapIntegrity,
  latency,
  cost,
};

export const evaluationCategories = Object.freeze([...CATEGORIES]);
export const evaluationSuiteVersion = "baseline-1";

export function runEvaluationSuite(artifact, categories = CATEGORIES) {
  const selected = categories.filter((category, index) => CATEGORIES.includes(category) && categories.indexOf(category) === index);
  const results = selected.map((category) => RUNNERS[category](artifact ?? {}));
  const outcome = results.some((entry) => entry.outcome === "fail")
    ? "fail"
    : results.some((entry) => entry.outcome === "warn") ? "warn" : "pass";
  return {
    suiteVersion: evaluationSuiteVersion,
    outcome,
    results,
    summary: {
      passed: results.filter((entry) => entry.outcome === "pass").length,
      warned: results.filter((entry) => entry.outcome === "warn").length,
      failed: results.filter((entry) => entry.outcome === "fail").length,
    },
  };
}

export function validateEvaluationRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("body must be an object");
  const allowed = ["campaignId", "feature", "categories", "artifact", "persist"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`body.${key} is not allowed`);
  const categories = value.categories ?? CATEGORIES;
  if (!Array.isArray(categories) || categories.length === 0 || categories.some((item) => !CATEGORIES.includes(item))) {
    throw new TypeError(`categories must contain only: ${CATEGORIES.join(", ")}`);
  }
  return {
    campaignId: typeof value.campaignId === "string" ? value.campaignId : null,
    feature: typeof value.feature === "string" ? value.feature.slice(0, 100) : "manual",
    categories,
    artifact: value.artifact && typeof value.artifact === "object" && !Array.isArray(value.artifact) ? value.artifact : {},
    persist: value.persist === true,
  };
}
