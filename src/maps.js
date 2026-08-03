import { randomUUID } from "node:crypto";

const MAP_TYPES = ["encounter", "dungeon", "settlement", "region", "travel"];
const GRID_TYPES = ["square", "hex", "none"];
const DENSITIES = ["sparse", "standard", "dense"];
const THEMES = ["parchment", "blueprint", "dark", "minimal"];

function fail(message, field = "request") {
  const error = new Error(message);
  error.name = "ValidationError";
  error.field = field;
  throw error;
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`, field);
  }
  return value;
}

function string(value, field, { defaultValue, max = 4_000, allowEmpty = false } = {}) {
  if ((value === undefined || value === null) && defaultValue !== undefined) {
    return defaultValue;
  }
  if (typeof value !== "string") fail(`${field} must be a string`, field);
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) fail(`${field} must be a non-empty string`, field);
  if (trimmed.length > max) fail(`${field} must be ${max} characters or fewer`, field);
  return trimmed;
}

function enumValue(value, field, allowed, defaultValue) {
  const candidate = value ?? defaultValue;
  if (!allowed.includes(candidate)) fail(`${field} must be one of: ${allowed.join(", ")}`, field);
  return candidate;
}

function integer(value, field, { defaultValue, min, max }) {
  const candidate = value ?? defaultValue;
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    fail(`${field} must be an integer from ${min} to ${max}`, field);
  }
  return candidate;
}

function boolean(value, field, defaultValue = false) {
  const candidate = value ?? defaultValue;
  if (typeof candidate !== "boolean") fail(`${field} must be a boolean`, field);
  return candidate;
}

function stringArray(value, field, { maxItems = 20, maxLength = 300 } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array`, field);
  if (value.length > maxItems) fail(`${field} may contain at most ${maxItems} items`, field);
  return value.map((item, index) => string(item, `${field}[${index}]`, { max: maxLength }));
}

function includesProtectedRecreationRequest(text) {
  return [
    /\b(recreate|replicate|copy|trace|duplicate)\b.{0,60}\b(exact|identical|official|published|commercial)\b/i,
    /\b(exact|identical)\b.{0,60}\b(layout|map|dungeon|region|adventure)\b/i,
    /\b(from|out of)\b.{0,60}\b(paid module|paid adventure|commercial sourcebook)\b/i,
    /\b(ignore|bypass|evade)\b.{0,30}\bcopyright\b/i,
  ].some((pattern) => pattern.test(text));
}

function defaultsForMapType(mapType) {
  switch (mapType) {
    case "encounter":
      return { width: 24, height: 18, scale: "5 feet per cell" };
    case "dungeon":
      return { width: 36, height: 28, scale: "5 feet per cell" };
    case "settlement":
      return { width: 48, height: 36, scale: "25 feet per cell" };
    case "region":
      return { width: 60, height: 45, scale: "1 mile per cell" };
    case "travel":
      return { width: 50, height: 30, scale: "1 mile per cell" };
    default:
      return { width: 36, height: 28, scale: "5 feet per cell" };
  }
}

export function validateMapRequest(value) {
  const input = object(value, "body");
  const mapType = enumValue(input.mapType, "mapType", MAP_TYPES);
  const defaults = defaultsForMapType(mapType);
  const prompt = string(input.prompt, "prompt", { max: 4_000 });
  const features = stringArray(input.features, "features", { maxItems: 24, maxLength: 300 });
  const constraints = stringArray(input.constraints, "constraints", {
    maxItems: 20,
    maxLength: 400,
  });
  const biomes = stringArray(input.biomes, "biomes", { maxItems: 8, maxLength: 120 });
  const combined = [prompt, ...features, ...constraints, ...biomes].join("\n");
  if (includesProtectedRecreationRequest(combined)) {
    fail(
      "Exact reconstruction of a published or commercial map is not supported; describe the terrain, encounter goals, and atmosphere for a new original layout",
      "prompt",
    );
  }

  const seedValue = input.seed ?? randomUUID();
  if (!["string", "number"].includes(typeof seedValue)) {
    fail("seed must be a string or number", "seed");
  }

  return {
    mapType,
    prompt,
    seed: string(String(seedValue), "seed", { max: 128 }),
    width: integer(input.width, "width", { defaultValue: defaults.width, min: 12, max: 80 }),
    height: integer(input.height, "height", { defaultValue: defaults.height, min: 12, max: 80 }),
    gridType: enumValue(input.gridType, "gridType", GRID_TYPES, mapType === "region" ? "hex" : "square"),
    scale: string(input.scale ?? defaults.scale, "scale", { max: 80 }),
    density: enumValue(input.density, "density", DENSITIES, "standard"),
    theme: enumValue(input.theme, "theme", THEMES, "parchment"),
    biomes,
    features,
    constraints,
  };
}

function validateCoordinate(value, field, maximum) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    fail(`${field} must be an integer from 0 to ${maximum}`, field);
  }
  return value;
}

export function validateMapResult(value) {
  const result = object(value, "mapResult");
  const grid = object(result.grid, "grid");
  const width = integer(grid.width, "grid.width", { min: 12, max: 80 });
  const height = integer(grid.height, "grid.height", { min: 12, max: 80 });
  const zonesInput = result.zones ?? [];
  const connectionsInput = result.connections ?? [];
  const pointsInput = result.pointsOfInterest ?? [];
  const encountersInput = result.encounters ?? [];
  const hazardsInput = result.hazards ?? [];
  const exitsInput = result.exits ?? [];
  for (const [name, candidate, maximum] of [
    ["zones", zonesInput, 40],
    ["connections", connectionsInput, 80],
    ["pointsOfInterest", pointsInput, 60],
    ["encounters", encountersInput, 30],
    ["hazards", hazardsInput, 30],
    ["exits", exitsInput, 12],
  ]) {
    if (!Array.isArray(candidate) || candidate.length > maximum) {
      fail(`${name} must be an array with at most ${maximum} entries`, name);
    }
  }

  const zones = zonesInput.map((entry, index) => {
    const zone = object(entry, `zones[${index}]`);
    const x = validateCoordinate(zone.x, `zones[${index}].x`, width - 1);
    const y = validateCoordinate(zone.y, `zones[${index}].y`, height - 1);
    const zoneWidth = integer(zone.width, `zones[${index}].width`, { min: 1, max: width });
    const zoneHeight = integer(zone.height, `zones[${index}].height`, { min: 1, max: height });
    if (x + zoneWidth > width || y + zoneHeight > height) {
      fail(`zones[${index}] must fit inside the grid`, `zones[${index}]`);
    }
    return {
      id: string(zone.id, `zones[${index}].id`, { max: 80 }),
      name: string(zone.name, `zones[${index}].name`, { max: 120 }),
      kind: string(zone.kind, `zones[${index}].kind`, { max: 80 }),
      x,
      y,
      width: zoneWidth,
      height: zoneHeight,
      description: string(zone.description, `zones[${index}].description`, { max: 1_200 }),
    };
  });
  const zoneIds = new Set(zones.map((zone) => zone.id));

  const connections = connectionsInput.map((entry, index) => {
    const connection = object(entry, `connections[${index}]`);
    const from = string(connection.from, `connections[${index}].from`, { max: 80 });
    const to = string(connection.to, `connections[${index}].to`, { max: 80 });
    if (!zoneIds.has(from) || !zoneIds.has(to)) {
      fail(`connections[${index}] references an unknown zone`, `connections[${index}]`);
    }
    return {
      from,
      to,
      kind: string(connection.kind, `connections[${index}].kind`, { max: 80 }),
      locked: boolean(connection.locked, `connections[${index}].locked`),
      description: string(connection.description, `connections[${index}].description`, {
        max: 600,
        allowEmpty: true,
      }),
    };
  });

  const pointsOfInterest = pointsInput.map((entry, index) => {
    const point = object(entry, `pointsOfInterest[${index}]`);
    return {
      id: string(point.id, `pointsOfInterest[${index}].id`, { max: 80 }),
      name: string(point.name, `pointsOfInterest[${index}].name`, { max: 120 }),
      kind: string(point.kind, `pointsOfInterest[${index}].kind`, { max: 80 }),
      x: validateCoordinate(point.x, `pointsOfInterest[${index}].x`, width - 1),
      y: validateCoordinate(point.y, `pointsOfInterest[${index}].y`, height - 1),
      description: string(point.description, `pointsOfInterest[${index}].description`, { max: 900 }),
      secret: boolean(point.secret, `pointsOfInterest[${index}].secret`),
    };
  });

  const encounters = encountersInput.map((entry, index) => {
    const encounter = object(entry, `encounters[${index}]`);
    const zoneId = string(encounter.zoneId, `encounters[${index}].zoneId`, { max: 80 });
    if (!zoneIds.has(zoneId)) fail(`encounters[${index}] references an unknown zone`, `encounters[${index}].zoneId`);
    return {
      name: string(encounter.name, `encounters[${index}].name`, { max: 120 }),
      zoneId,
      difficulty: enumValue(
        encounter.difficulty,
        `encounters[${index}].difficulty`,
        ["easy", "moderate", "hard", "deadly", "variable"],
      ),
      description: string(encounter.description, `encounters[${index}].description`, { max: 1_000 }),
    };
  });

  const hazards = hazardsInput.map((entry, index) => {
    const hazard = object(entry, `hazards[${index}]`);
    const zoneId = string(hazard.zoneId, `hazards[${index}].zoneId`, { max: 80 });
    if (!zoneIds.has(zoneId)) fail(`hazards[${index}] references an unknown zone`, `hazards[${index}].zoneId`);
    return {
      name: string(hazard.name, `hazards[${index}].name`, { max: 120 }),
      zoneId,
      trigger: string(hazard.trigger, `hazards[${index}].trigger`, { max: 700 }),
      effect: string(hazard.effect, `hazards[${index}].effect`, { max: 900 }),
    };
  });

  const exits = exitsInput.map((entry, index) => {
    const exit = object(entry, `exits[${index}]`);
    return {
      name: string(exit.name, `exits[${index}].name`, { max: 120 }),
      x: validateCoordinate(exit.x, `exits[${index}].x`, width - 1),
      y: validateCoordinate(exit.y, `exits[${index}].y`, height - 1),
      destination: string(exit.destination, `exits[${index}].destination`, { max: 300 }),
    };
  });

  const originality = object(result.originality, "originality");
  return {
    title: string(result.title, "title", { max: 160 }),
    mapType: enumValue(result.mapType, "mapType", MAP_TYPES),
    seed: string(result.seed, "seed", { max: 128 }),
    summary: string(result.summary, "summary", { max: 1_500 }),
    grid: {
      type: enumValue(grid.type, "grid.type", GRID_TYPES),
      width,
      height,
      scale: string(grid.scale, "grid.scale", { max: 80 }),
    },
    zones,
    connections,
    pointsOfInterest,
    encounters,
    hazards,
    exits,
    gmNotes: stringArray(result.gmNotes, "gmNotes", { maxItems: 20, maxLength: 700 }),
    originality: {
      status: enumValue(originality.status, "originality.status", ["original", "needs-review"]),
      concerns: stringArray(originality.concerns, "originality.concerns", { maxItems: 12, maxLength: 500 }),
    },
  };
}

function hashSeed(seed) {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRandom(seed) {
  let state = hashSeed(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(random, min, max) {
  return Math.floor(random() * (max - min + 1)) + min;
}

function pick(random, values) {
  return values[randomInt(random, 0, values.length - 1)];
}

function overlaps(candidate, zones, margin = 1) {
  return zones.some(
    (zone) =>
      candidate.x < zone.x + zone.width + margin &&
      candidate.x + candidate.width + margin > zone.x &&
      candidate.y < zone.y + zone.height + margin &&
      candidate.y + candidate.height + margin > zone.y,
  );
}

function zoneKinds(mapType) {
  const kinds = {
    encounter: ["cover", "objective", "hazard", "high-ground", "approach"],
    dungeon: ["chamber", "corridor-hub", "sanctum", "storage", "trap-room", "lair"],
    settlement: ["district", "market", "residential", "civic", "industrial", "defense"],
    region: ["biome", "landmark", "frontier", "waterway", "ruin", "territory"],
    travel: ["route-segment", "camp", "crossing", "landmark", "danger-zone", "shelter"],
  };
  return kinds[mapType];
}

function zoneCountFor(request) {
  const base = {
    encounter: 5,
    dungeon: 9,
    settlement: 8,
    region: 10,
    travel: 7,
  }[request.mapType];
  return Math.max(3, base + (request.density === "dense" ? 3 : request.density === "sparse" ? -2 : 0));
}

function buildTitle(request) {
  const words = request.prompt
    .replace(/[^a-zA-Z0-9' -]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(" ");
  const label = request.mapType[0].toUpperCase() + request.mapType.slice(1);
  return words ? `${label}: ${words}` : `Original ${label} Map`;
}

export function generateProceduralMap(request) {
  const random = createRandom(request.seed);
  const zones = [];
  const count = zoneCountFor(request);
  const kinds = zoneKinds(request.mapType);

  for (let index = 0; index < count; index += 1) {
    const maxZoneWidth = Math.max(4, Math.floor(request.width / (request.mapType === "region" ? 3 : 4)));
    const maxZoneHeight = Math.max(4, Math.floor(request.height / (request.mapType === "region" ? 3 : 4)));
    let candidate = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const width = randomInt(random, 3, maxZoneWidth);
      const height = randomInt(random, 3, maxZoneHeight);
      const proposed = {
        x: randomInt(random, 0, request.width - width),
        y: randomInt(random, 0, request.height - height),
        width,
        height,
      };
      if (!overlaps(proposed, zones, request.mapType === "region" ? 0 : 1)) {
        candidate = proposed;
        break;
      }
    }
    if (!candidate) {
      const width = Math.max(2, Math.floor(request.width / 8));
      const height = Math.max(2, Math.floor(request.height / 8));
      candidate = {
        x: (index * (width + 1)) % Math.max(1, request.width - width),
        y: Math.floor(index / 5) * (height + 1) % Math.max(1, request.height - height),
        width,
        height,
      };
    }
    const kind = pick(random, kinds);
    zones.push({
      id: `zone-${index + 1}`,
      name: `${kind.replace(/-/g, " ")} ${index + 1}`,
      kind,
      ...candidate,
      description: `An original ${kind.replace(/-/g, " ")} shaped by the prompt: ${request.prompt.slice(0, 180)}`,
    });
  }

  const connections = zones.slice(1).map((zone, index) => ({
    from: zones[index].id,
    to: zone.id,
    kind: request.mapType === "region" || request.mapType === "travel" ? "route" : "passage",
    locked: request.mapType === "dungeon" && random() > 0.82,
    description: "A traversable connection with enough space for the table to add a complication or clue.",
  }));
  if (zones.length > 4 && request.density === "dense") {
    connections.push({
      from: zones[0].id,
      to: zones[zones.length - 1].id,
      kind: "hidden-route",
      locked: false,
      description: "An optional route rewards exploration and changes encounter positioning.",
    });
  }

  const requestedFeatures = request.features.length > 0 ? request.features : ["distinct landmark", "interactive terrain"];
  const pointsOfInterest = zones.slice(0, Math.min(zones.length, request.density === "dense" ? 10 : 7)).map((zone, index) => ({
    id: `poi-${index + 1}`,
    name: requestedFeatures[index % requestedFeatures.length],
    kind: index % 3 === 0 ? "objective" : index % 3 === 1 ? "clue" : "landmark",
    x: zone.x + Math.floor(zone.width / 2),
    y: zone.y + Math.floor(zone.height / 2),
    description: `A table-ready point of interest connected to ${zone.name}.`,
    secret: index > 0 && index % 4 === 0,
  }));

  const encounters = zones
    .filter((_, index) => index % (request.density === "dense" ? 2 : 3) === 1)
    .slice(0, 8)
    .map((zone, index) => ({
      name: `Encounter ${index + 1}`,
      zoneId: zone.id,
      difficulty: pick(random, ["easy", "moderate", "hard", "variable"]),
      description: `Use the terrain and objective in ${zone.name}; creatures or social pressure should react to player positioning.`,
    }));

  const hazards = zones
    .filter((_, index) => index % (request.density === "dense" ? 3 : 5) === 2)
    .slice(0, 6)
    .map((zone, index) => ({
      name: `Environmental Hazard ${index + 1}`,
      zoneId: zone.id,
      trigger: "Triggered by careless movement, loud activity, or interacting without investigation.",
      effect: "Changes terrain or creates a temporary complication rather than dealing unavoidable damage.",
    }));

  const first = zones[0];
  const last = zones[zones.length - 1];
  const exits = [
    { name: "Primary entrance", x: first.x, y: first.y, destination: "Previous scene or safe approach" },
    {
      name: "Forward exit",
      x: Math.min(request.width - 1, last.x + last.width - 1),
      y: Math.min(request.height - 1, last.y + last.height - 1),
      destination: "Next scene, deeper area, or onward route",
    },
  ];

  return validateMapResult({
    title: buildTitle(request),
    mapType: request.mapType,
    seed: request.seed,
    summary: `A reproducible original ${request.mapType} map using a ${request.gridType} grid, ${request.density} detail, and the requested atmosphere.`,
    grid: {
      type: request.gridType,
      width: request.width,
      height: request.height,
      scale: request.scale,
    },
    zones,
    connections,
    pointsOfInterest,
    encounters,
    hazards,
    exits,
    gmNotes: [
      "Reveal secret points of interest only after relevant exploration or checks.",
      "Treat generated encounter difficulty as a planning label and adjust for the actual party.",
      ...request.constraints.slice(0, 6),
    ],
    originality: { status: "original", concerns: [] },
  });
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function palette(theme) {
  const palettes = {
    parchment: { background: "#f2e3bd", grid: "#b9a476", zone: "#d7c391", line: "#665739", text: "#2d281f", poi: "#8a3f2d" },
    blueprint: { background: "#163a5f", grid: "#4f7598", zone: "#28577f", line: "#dcefff", text: "#ffffff", poi: "#f2c14e" },
    dark: { background: "#161616", grid: "#343434", zone: "#292929", line: "#b7b7b7", text: "#f0f0f0", poi: "#d45c5c" },
    minimal: { background: "#ffffff", grid: "#dddddd", zone: "#f3f3f3", line: "#333333", text: "#111111", poi: "#555555" },
  };
  return palettes[theme] ?? palettes.parchment;
}

export function renderMapSvg(map, theme = "parchment") {
  const cell = 20;
  const width = map.grid.width * cell;
  const height = map.grid.height * cell;
  const colors = palette(theme);
  const zoneById = new Map(map.zones.map((zone) => [zone.id, zone]));
  const elements = [
    `<rect width="${width}" height="${height}" fill="${colors.background}"/>`,
  ];

  if (map.grid.type === "square") {
    for (let x = 0; x <= map.grid.width; x += 1) {
      elements.push(`<line x1="${x * cell}" y1="0" x2="${x * cell}" y2="${height}" stroke="${colors.grid}" stroke-width="1" opacity="0.55"/>`);
    }
    for (let y = 0; y <= map.grid.height; y += 1) {
      elements.push(`<line x1="0" y1="${y * cell}" x2="${width}" y2="${y * cell}" stroke="${colors.grid}" stroke-width="1" opacity="0.55"/>`);
    }
  } else if (map.grid.type === "hex") {
    const size = cell;
    const hexHeight = Math.sqrt(3) * size;
    for (let column = 0; column < Math.ceil(width / (size * 1.5)); column += 1) {
      for (let row = 0; row < Math.ceil(height / hexHeight) + 1; row += 1) {
        const cx = size + column * size * 1.5;
        const cy = hexHeight / 2 + row * hexHeight + (column % 2 ? hexHeight / 2 : 0);
        const points = Array.from({ length: 6 }, (_, index) => {
          const angle = Math.PI / 3 * index;
          return `${cx + size * Math.cos(angle)},${cy + size * Math.sin(angle)}`;
        }).join(" ");
        elements.push(`<polygon points="${points}" fill="none" stroke="${colors.grid}" stroke-width="1" opacity="0.45"/>`);
      }
    }
  }

  for (const connection of map.connections) {
    const from = zoneById.get(connection.from);
    const to = zoneById.get(connection.to);
    if (!from || !to) continue;
    const x1 = (from.x + from.width / 2) * cell;
    const y1 = (from.y + from.height / 2) * cell;
    const x2 = (to.x + to.width / 2) * cell;
    const y2 = (to.y + to.height / 2) * cell;
    elements.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${colors.line}" stroke-width="${connection.locked ? 5 : 3}" stroke-dasharray="${connection.kind.includes("hidden") ? "8 6" : "none"}" opacity="0.8"/>`);
  }

  for (const zone of map.zones) {
    const x = zone.x * cell;
    const y = zone.y * cell;
    const zoneWidth = zone.width * cell;
    const zoneHeight = zone.height * cell;
    elements.push(`<rect x="${x}" y="${y}" width="${zoneWidth}" height="${zoneHeight}" rx="6" fill="${colors.zone}" stroke="${colors.line}" stroke-width="3" opacity="0.92"/>`);
    elements.push(`<text x="${x + 7}" y="${y + 17}" fill="${colors.text}" font-family="sans-serif" font-size="12" font-weight="700">${escapeXml(zone.name)}</text>`);
  }

  for (const point of map.pointsOfInterest.filter((entry) => !entry.secret)) {
    const x = (point.x + 0.5) * cell;
    const y = (point.y + 0.5) * cell;
    elements.push(`<circle cx="${x}" cy="${y}" r="6" fill="${colors.poi}" stroke="${colors.text}" stroke-width="2"/>`);
    elements.push(`<title>${escapeXml(`${point.name}: ${point.description}`)}</title>`);
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="map-title map-description" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<title id="map-title">${escapeXml(map.title)}</title>`,
    `<desc id="map-description">${escapeXml(map.summary)}</desc>`,
    ...elements,
    "</svg>",
  ].join("");
}

const stringArraySchema = { type: "array", items: { type: "string" } };

export const mapResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "mapType",
    "seed",
    "summary",
    "grid",
    "zones",
    "connections",
    "pointsOfInterest",
    "encounters",
    "hazards",
    "exits",
    "gmNotes",
    "originality",
  ],
  properties: {
    title: { type: "string" },
    mapType: { type: "string", enum: MAP_TYPES },
    seed: { type: "string" },
    summary: { type: "string" },
    grid: {
      type: "object",
      additionalProperties: false,
      required: ["type", "width", "height", "scale"],
      properties: {
        type: { type: "string", enum: GRID_TYPES },
        width: { type: "integer", minimum: 12, maximum: 80 },
        height: { type: "integer", minimum: 12, maximum: 80 },
        scale: { type: "string" },
      },
    },
    zones: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "kind", "x", "y", "width", "height", "description"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          kind: { type: "string" },
          x: { type: "integer", minimum: 0 },
          y: { type: "integer", minimum: 0 },
          width: { type: "integer", minimum: 1 },
          height: { type: "integer", minimum: 1 },
          description: { type: "string" },
        },
      },
    },
    connections: {
      type: "array",
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to", "kind", "locked", "description"],
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          kind: { type: "string" },
          locked: { type: "boolean" },
          description: { type: "string" },
        },
      },
    },
    pointsOfInterest: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "kind", "x", "y", "description", "secret"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          kind: { type: "string" },
          x: { type: "integer", minimum: 0 },
          y: { type: "integer", minimum: 0 },
          description: { type: "string" },
          secret: { type: "boolean" },
        },
      },
    },
    encounters: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "zoneId", "difficulty", "description"],
        properties: {
          name: { type: "string" },
          zoneId: { type: "string" },
          difficulty: { type: "string", enum: ["easy", "moderate", "hard", "deadly", "variable"] },
          description: { type: "string" },
        },
      },
    },
    hazards: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "zoneId", "trigger", "effect"],
        properties: {
          name: { type: "string" },
          zoneId: { type: "string" },
          trigger: { type: "string" },
          effect: { type: "string" },
        },
      },
    },
    exits: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "x", "y", "destination"],
        properties: {
          name: { type: "string" },
          x: { type: "integer", minimum: 0 },
          y: { type: "integer", minimum: 0 },
          destination: { type: "string" },
        },
      },
    },
    gmNotes: stringArraySchema,
    originality: {
      type: "object",
      additionalProperties: false,
      required: ["status", "concerns"],
      properties: {
        status: { type: "string", enum: ["original", "needs-review"] },
        concerns: stringArraySchema,
      },
    },
  },
};
