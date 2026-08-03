import { createHash } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPORT_TARGETS = ["khaos_scene", "universal_vtt_style", "foundry_scene_data"];

function fail(message, field = "request") {
  const error = new Error(message);
  error.name = "ValidationError";
  error.field = field;
  throw error;
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`, field);
  return value;
}

function strictKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field}.${key} is not allowed`, `${field}.${key}`);
  }
}

function text(value, field, { required = false, max = 4_000, defaultValue = "" } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`${field} is required`, field);
    return defaultValue;
  }
  if (typeof value !== "string") fail(`${field} must be text`, field);
  const normalized = value.trim();
  if (required && !normalized) fail(`${field} is required`, field);
  if (normalized.length > max) fail(`${field} must be ${max} characters or fewer`, field);
  return normalized;
}

function boolean(value, field, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "boolean") fail(`${field} must be boolean`, field);
  return value;
}

function integer(value, field, { min = 0, max = 10_000, defaultValue = 0 } = {}) {
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`, field);
  }
  return value;
}

function number(value, field, { min = -100_000, max = 100_000, defaultValue = 0 } = {}) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${field} must be a number between ${min} and ${max}`, field);
  }
  return value;
}

function enumValue(value, field, allowed, defaultValue) {
  const normalized = value ?? defaultValue;
  if (!allowed.includes(normalized)) fail(`${field} must be one of: ${allowed.join(", ")}`, field);
  return normalized;
}

function uuid(value, field, required = false) {
  const normalized = text(value, field, { required, max: 36 });
  if (!normalized) return null;
  if (!UUID_PATTERN.test(normalized)) fail(`${field} must be a UUID`, field);
  return normalized;
}

function array(value, field, max = 1_000) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array`, field);
  if (value.length > max) fail(`${field} must contain ${max} items or fewer`, field);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function sceneHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function stableId(seed, kind, index, extra = "") {
  const hex = createHash("sha256").update(`${seed}:${kind}:${index}:${extra}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "scene";
}

function point(value, field, width, height) {
  const item = object(value, field);
  strictKeys(item, ["x", "y"], field);
  return {
    x: number(item.x, `${field}.x`, { min: 0, max: width }),
    y: number(item.y, `${field}.y`, { min: 0, max: height }),
  };
}

function rectangle(value, field, width, height) {
  const item = object(value, field);
  strictKeys(item, ["x", "y", "width", "height"], field);
  const result = {
    x: number(item.x, `${field}.x`, { min: 0, max: width }),
    y: number(item.y, `${field}.y`, { min: 0, max: height }),
    width: number(item.width, `${field}.width`, { min: 0.1, max: width }),
    height: number(item.height, `${field}.height`, { min: 0.1, max: height }),
  };
  if (result.x + result.width > width || result.y + result.height > height) {
    fail(`${field} must remain inside scene bounds`, field);
  }
  return result;
}

function wall(value, field, width, height) {
  const item = object(value, field);
  strictKeys(item, ["id", "a", "b", "blocksMovement", "blocksSight", "secret"], field);
  return {
    id: uuid(item.id, `${field}.id`, true),
    a: point(item.a, `${field}.a`, width, height),
    b: point(item.b, `${field}.b`, width, height),
    blocksMovement: boolean(item.blocksMovement, `${field}.blocksMovement`, true),
    blocksSight: boolean(item.blocksSight, `${field}.blocksSight`, true),
    secret: boolean(item.secret, `${field}.secret`, false),
  };
}

function door(value, field, width, height) {
  const item = object(value, field);
  strictKeys(item, ["id", "a", "b", "state", "secret", "locked", "label"], field);
  return {
    id: uuid(item.id, `${field}.id`, true),
    a: point(item.a, `${field}.a`, width, height),
    b: point(item.b, `${field}.b`, width, height),
    state: enumValue(item.state, `${field}.state`, ["open", "closed"], "closed"),
    secret: boolean(item.secret, `${field}.secret`, false),
    locked: boolean(item.locked, `${field}.locked`, false),
    label: text(item.label, `${field}.label`, { max: 200 }),
  };
}

function light(value, field, width, height) {
  const item = object(value, field);
  strictKeys(item, ["id", "position", "brightRadius", "dimRadius", "hidden", "label"], field);
  return {
    id: uuid(item.id, `${field}.id`, true),
    position: point(item.position, `${field}.position`, width, height),
    brightRadius: number(item.brightRadius, `${field}.brightRadius`, { min: 0, max: Math.max(width, height) }),
    dimRadius: number(item.dimRadius, `${field}.dimRadius`, { min: 0, max: Math.max(width, height) }),
    hidden: boolean(item.hidden, `${field}.hidden`, false),
    label: text(item.label, `${field}.label`, { max: 200 }),
  };
}

function token(value, field, width, height) {
  const item = object(value, field);
  strictKeys(item, ["id", "name", "position", "size", "disposition", "hidden", "encounterId", "metadata"], field);
  const metadata = item.metadata === undefined ? {} : object(item.metadata, `${field}.metadata`);
  if (JSON.stringify(metadata).length > 8_000) fail(`${field}.metadata is too large`, `${field}.metadata`);
  return {
    id: uuid(item.id, `${field}.id`, true),
    name: text(item.name, `${field}.name`, { required: true, max: 200 }),
    position: point(item.position, `${field}.position`, width, height),
    size: number(item.size, `${field}.size`, { min: 0.25, max: 20, defaultValue: 1 }),
    disposition: enumValue(item.disposition, `${field}.disposition`, ["friendly", "neutral", "hostile"], "neutral"),
    hidden: boolean(item.hidden, `${field}.hidden`, false),
    encounterId: uuid(item.encounterId, `${field}.encounterId`),
    metadata: structuredClone(metadata),
  };
}

function pointOfInterest(value, field, width, height) {
  const item = object(value, field);
  strictKeys(item, ["id", "name", "description", "position", "secret", "revealed"], field);
  return {
    id: uuid(item.id, `${field}.id`, true),
    name: text(item.name, `${field}.name`, { required: true, max: 200 }),
    description: text(item.description, `${field}.description`, { max: 2_000 }),
    position: point(item.position, `${field}.position`, width, height),
    secret: boolean(item.secret, `${field}.secret`, false),
    revealed: boolean(item.revealed, `${field}.revealed`, false),
  };
}

function terrain(value, field, width, height) {
  const item = object(value, field);
  strictKeys(item, ["id", "name", "bounds", "movementMultiplier", "elevation", "hidden"], field);
  return {
    id: uuid(item.id, `${field}.id`, true),
    name: text(item.name, `${field}.name`, { required: true, max: 200 }),
    bounds: rectangle(item.bounds, `${field}.bounds`, width, height),
    movementMultiplier: number(item.movementMultiplier, `${field}.movementMultiplier`, { min: 0, max: 10, defaultValue: 1 }),
    elevation: number(item.elevation, `${field}.elevation`, { min: -10_000, max: 10_000 }),
    hidden: boolean(item.hidden, `${field}.hidden`, false),
  };
}

function fogRegion(value, field, width, height) {
  const item = object(value, field);
  strictKeys(item, ["id", "bounds", "revealed", "label"], field);
  return {
    id: uuid(item.id, `${field}.id`, true),
    bounds: rectangle(item.bounds, `${field}.bounds`, width, height),
    revealed: boolean(item.revealed, `${field}.revealed`, false),
    label: text(item.label, `${field}.label`, { max: 200 }),
  };
}

function level(value, field, width, height) {
  const item = object(value, field);
  strictKeys(item, [
    "id", "name", "index", "elevation", "walls", "doors", "windows", "terrain",
    "lights", "fogRegions", "tokens", "pointsOfInterest", "gmNotes",
  ], field);
  const levelValue = {
    id: uuid(item.id, `${field}.id`, true),
    name: text(item.name, `${field}.name`, { required: true, max: 200 }),
    index: integer(item.index, `${field}.index`, { min: 0, max: 15 }),
    elevation: number(item.elevation, `${field}.elevation`, { min: -10_000, max: 10_000 }),
    walls: array(item.walls, `${field}.walls`, 5_000).map((entry, index) => wall(entry, `${field}.walls[${index}]`, width, height)),
    doors: array(item.doors, `${field}.doors`, 1_000).map((entry, index) => door(entry, `${field}.doors[${index}]`, width, height)),
    windows: array(item.windows, `${field}.windows`, 1_000).map((entry, index) => wall(entry, `${field}.windows[${index}]`, width, height)),
    terrain: array(item.terrain, `${field}.terrain`, 1_000).map((entry, index) => terrain(entry, `${field}.terrain[${index}]`, width, height)),
    lights: array(item.lights, `${field}.lights`, 1_000).map((entry, index) => light(entry, `${field}.lights[${index}]`, width, height)),
    fogRegions: array(item.fogRegions, `${field}.fogRegions`, 1_000).map((entry, index) => fogRegion(entry, `${field}.fogRegions[${index}]`, width, height)),
    tokens: array(item.tokens, `${field}.tokens`, 2_000).map((entry, index) => token(entry, `${field}.tokens[${index}]`, width, height)),
    pointsOfInterest: array(item.pointsOfInterest, `${field}.pointsOfInterest`, 2_000).map((entry, index) => pointOfInterest(entry, `${field}.pointsOfInterest[${index}]`, width, height)),
    gmNotes: text(item.gmNotes, `${field}.gmNotes`, { max: 8_000 }),
  };
  const ids = new Set();
  for (const collection of ["walls", "doors", "windows", "terrain", "lights", "fogRegions", "tokens", "pointsOfInterest"]) {
    for (const entry of levelValue[collection]) {
      if (ids.has(entry.id)) fail(`${field} contains duplicate object id ${entry.id}`, field);
      ids.add(entry.id);
    }
  }
  return levelValue;
}

export function validateMapSceneOptions(value = {}) {
  const input = object(value, "sceneOptions");
  strictKeys(input, ["levelCount", "levelHeight", "defaultFogRevealed", "includeLights", "tokenMode"], "sceneOptions");
  return {
    levelCount: integer(input.levelCount, "sceneOptions.levelCount", { min: 1, max: 8, defaultValue: 1 }),
    levelHeight: integer(input.levelHeight, "sceneOptions.levelHeight", { min: 0, max: 1_000, defaultValue: 10 }),
    defaultFogRevealed: boolean(input.defaultFogRevealed, "sceneOptions.defaultFogRevealed", false),
    includeLights: boolean(input.includeLights, "sceneOptions.includeLights", true),
    tokenMode: enumValue(input.tokenMode, "sceneOptions.tokenMode", ["encounters", "none"], "encounters"),
  };
}

export function validateMapScene(value) {
  const input = object(value, "scene");
  strictKeys(input, [
    "schemaVersion", "projection", "id", "title", "seed", "mapType", "width", "height",
    "grid", "levels", "fogEnabled", "gmNotes", "sourceMapHash", "metadata",
  ], "scene");
  const width = integer(input.width, "scene.width", { min: 12, max: 500 });
  const height = integer(input.height, "scene.height", { min: 12, max: 500 });
  const grid = object(input.grid, "scene.grid");
  strictKeys(grid, ["type", "size", "units"], "scene.grid");
  const metadata = input.metadata === undefined ? {} : object(input.metadata, "scene.metadata");
  if (JSON.stringify(metadata).length > 20_000) fail("scene.metadata is too large", "scene.metadata");
  const scene = {
    schemaVersion: integer(input.schemaVersion, "scene.schemaVersion", { min: 1, max: 1, defaultValue: 1 }),
    projection: enumValue(input.projection, "scene.projection", ["gm", "player"], "gm"),
    id: uuid(input.id, "scene.id", true),
    title: text(input.title, "scene.title", { required: true, max: 300 }),
    seed: text(String(input.seed ?? ""), "scene.seed", { required: true, max: 200 }),
    mapType: text(input.mapType, "scene.mapType", { required: true, max: 100 }),
    width,
    height,
    grid: {
      type: enumValue(grid.type, "scene.grid.type", ["square", "hex", "none"], "square"),
      size: number(grid.size, "scene.grid.size", { min: 0.1, max: 100, defaultValue: 1 }),
      units: text(grid.units, "scene.grid.units", { max: 50, defaultValue: "ft" }),
    },
    levels: array(input.levels, "scene.levels", 8).map((entry, index) => level(entry, `scene.levels[${index}]`, width, height)),
    fogEnabled: boolean(input.fogEnabled, "scene.fogEnabled", true),
    gmNotes: text(input.gmNotes, "scene.gmNotes", { max: 12_000 }),
    sourceMapHash: text(input.sourceMapHash, "scene.sourceMapHash", { required: true, max: 64 }),
    metadata: structuredClone(metadata),
  };
  if (!scene.levels.length) fail("scene.levels must contain at least one level", "scene.levels");
  const indexes = new Set(scene.levels.map((entry) => entry.index));
  if (indexes.size !== scene.levels.length) fail("scene level indexes must be unique", "scene.levels");
  if (scene.projection === "player") {
    if (scene.gmNotes) fail("player scenes cannot contain gmNotes", "scene.gmNotes");
    for (const [levelIndex, current] of scene.levels.entries()) {
      if (current.gmNotes) fail("player levels cannot contain gmNotes", `scene.levels[${levelIndex}].gmNotes`);
      if (current.walls.some((entry) => entry.secret) || current.doors.some((entry) => entry.secret)) {
        fail("player scenes cannot contain secret walls or doors", `scene.levels[${levelIndex}]`);
      }
      if (current.tokens.some((entry) => entry.hidden) || current.lights.some((entry) => entry.hidden)) {
        fail("player scenes cannot contain hidden tokens or lights", `scene.levels[${levelIndex}]`);
      }
      if (current.pointsOfInterest.some((entry) => entry.secret || !entry.revealed)) {
        fail("player scenes cannot contain secret or unrevealed points of interest", `scene.levels[${levelIndex}].pointsOfInterest`);
      }
      if (current.fogRegions.some((entry) => !entry.revealed)) {
        fail("player scenes cannot contain unrevealed fog geometry", `scene.levels[${levelIndex}].fogRegions`);
      }
    }
  }
  if (canonicalJson(scene).length > 1_500_000) fail("scene package is too large", "scene");
  return scene;
}

function mapDimensions(map) {
  const grid = map.grid ?? {};
  return {
    width: Math.max(12, Math.min(500, Number(grid.width ?? map.width ?? 30))),
    height: Math.max(12, Math.min(500, Number(grid.height ?? map.height ?? 30))),
    type: ["square", "hex", "none"].includes(grid.type) ? grid.type : "square",
    scale: Number(grid.scale ?? grid.cellSize ?? 5) || 5,
    units: text(grid.units ?? "ft", "map.grid.units", { max: 50 }),
  };
}

function zoneBounds(zone, width, height) {
  const x = Math.max(0, Math.min(width - 1, Number(zone.x ?? zone.bounds?.x ?? 0)));
  const y = Math.max(0, Math.min(height - 1, Number(zone.y ?? zone.bounds?.y ?? 0)));
  const zoneWidth = Math.max(1, Math.min(width - x, Number(zone.width ?? zone.bounds?.width ?? 4)));
  const zoneHeight = Math.max(1, Math.min(height - y, Number(zone.height ?? zone.bounds?.height ?? 4)));
  return { x, y, width: zoneWidth, height: zoneHeight };
}

function center(bounds) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function rectangularWalls(seed, zone, zoneIndex, width, height) {
  const bounds = zoneBounds(zone, width, height);
  const { x, y } = bounds;
  const right = x + bounds.width;
  const bottom = y + bounds.height;
  return [
    [{ x, y }, { x: right, y }],
    [{ x: right, y }, { x: right, y: bottom }],
    [{ x: right, y: bottom }, { x, y: bottom }],
    [{ x, y: bottom }, { x, y }],
  ].map(([a, b], index) => ({
    id: stableId(seed, "wall", zoneIndex * 4 + index),
    a,
    b,
    blocksMovement: true,
    blocksSight: true,
    secret: false,
  }));
}

function connectionDoor(seed, connection, index, zonesById, width, height) {
  const from = zonesById.get(connection.from ?? connection.source ?? connection.a);
  const to = zonesById.get(connection.to ?? connection.target ?? connection.b);
  if (!from || !to) return null;
  const aCenter = center(zoneBounds(from, width, height));
  const bCenter = center(zoneBounds(to, width, height));
  const mid = { x: (aCenter.x + bCenter.x) / 2, y: (aCenter.y + bCenter.y) / 2 };
  const horizontal = Math.abs(aCenter.x - bCenter.x) >= Math.abs(aCenter.y - bCenter.y);
  return {
    id: stableId(seed, "door", index),
    a: horizontal ? { x: mid.x, y: Math.max(0, mid.y - 0.5) } : { x: Math.max(0, mid.x - 0.5), y: mid.y },
    b: horizontal ? { x: mid.x, y: Math.min(height, mid.y + 0.5) } : { x: Math.min(width, mid.x + 0.5), y: mid.y },
    state: "closed",
    secret: Boolean(connection.secret),
    locked: Boolean(connection.locked),
    label: text(connection.label ?? connection.type ?? "Door", "connection.label", { max: 200 }),
  };
}

export function createAdvancedMapScene(mapResult, optionsValue = {}) {
  const map = object(mapResult, "mapResult");
  const options = validateMapSceneOptions(optionsValue);
  const dimensions = mapDimensions(map);
  const seed = String(map.seed ?? "scene-seed");
  const sceneId = stableId(seed, "scene", 0, map.title ?? "map");
  const zones = array(map.zones, "mapResult.zones", 500);
  const zonesById = new Map(zones.map((zone, index) => [String(zone.id ?? zone.name ?? index), zone]));
  const levels = Array.from({ length: options.levelCount }, (_, index) => ({
    id: stableId(seed, "level", index),
    name: options.levelCount === 1 ? "Main Level" : `Level ${index + 1}`,
    index,
    elevation: index * options.levelHeight,
    walls: [],
    doors: [],
    windows: [],
    terrain: [],
    lights: [],
    fogRegions: [],
    tokens: [],
    pointsOfInterest: [],
    gmNotes: "",
  }));

  zones.forEach((zone, index) => {
    const level = levels[index % levels.length];
    const bounds = zoneBounds(zone, dimensions.width, dimensions.height);
    level.walls.push(...rectangularWalls(seed, zone, index, dimensions.width, dimensions.height));
    level.terrain.push({
      id: stableId(seed, "terrain", index),
      name: text(zone.name ?? `Zone ${index + 1}`, `mapResult.zones[${index}].name`, { max: 200 }),
      bounds,
      movementMultiplier: Number(zone.movementMultiplier ?? 1) || 1,
      elevation: level.elevation + Number(zone.elevation ?? 0),
      hidden: Boolean(zone.secret),
    });
    level.fogRegions.push({
      id: stableId(seed, "fog", index),
      bounds,
      revealed: options.defaultFogRevealed || Boolean(zone.revealed),
      label: text(zone.name ?? `Zone ${index + 1}`, `mapResult.zones[${index}].name`, { max: 200 }),
    });
  });

  array(map.connections ?? map.routes, "mapResult.connections", 1_000).forEach((connection, index) => {
    const doorValue = connectionDoor(seed, connection, index, zonesById, dimensions.width, dimensions.height);
    if (doorValue) levels[index % levels.length].doors.push(doorValue);
  });

  array(map.pointsOfInterest ?? map.pois, "mapResult.pointsOfInterest", 1_000).forEach((poi, index) => {
    const zone = zonesById.get(String(poi.zoneId ?? poi.zone ?? ""));
    const bounds = zone ? zoneBounds(zone, dimensions.width, dimensions.height) : {
      x: Math.max(0, Math.min(dimensions.width - 1, Number(poi.x ?? 0))),
      y: Math.max(0, Math.min(dimensions.height - 1, Number(poi.y ?? 0))),
      width: 1,
      height: 1,
    };
    const position = poi.position ? point(poi.position, `mapResult.pointsOfInterest[${index}].position`, dimensions.width, dimensions.height) : center(bounds);
    const level = levels[index % levels.length];
    level.pointsOfInterest.push({
      id: stableId(seed, "poi", index),
      name: text(poi.name ?? `Point ${index + 1}`, `mapResult.pointsOfInterest[${index}].name`, { max: 200 }),
      description: text(poi.description ?? "", `mapResult.pointsOfInterest[${index}].description`, { max: 2_000 }),
      position,
      secret: Boolean(poi.secret),
      revealed: Boolean(poi.revealed) || !poi.secret,
    });
    if (options.includeLights) {
      level.lights.push({
        id: stableId(seed, "light", index),
        position,
        brightRadius: Math.max(1, Math.min(20, Number(poi.brightRadius ?? 3))),
        dimRadius: Math.max(2, Math.min(40, Number(poi.dimRadius ?? 6))),
        hidden: Boolean(poi.secret),
        label: text(poi.name ?? `Light ${index + 1}`, `mapResult.pointsOfInterest[${index}].name`, { max: 200 }),
      });
    }
  });

  if (options.tokenMode === "encounters") {
    array(map.encounters, "mapResult.encounters", 1_000).forEach((encounter, index) => {
      const zone = zonesById.get(String(encounter.zoneId ?? encounter.zone ?? ""));
      const position = encounter.position
        ? point(encounter.position, `mapResult.encounters[${index}].position`, dimensions.width, dimensions.height)
        : center(zone ? zoneBounds(zone, dimensions.width, dimensions.height) : { x: index % dimensions.width, y: index % dimensions.height, width: 1, height: 1 });
      levels[index % levels.length].tokens.push({
        id: stableId(seed, "token", index),
        name: text(encounter.name ?? `Encounter ${index + 1}`, `mapResult.encounters[${index}].name`, { max: 200 }),
        position,
        size: Number(encounter.size ?? 1) || 1,
        disposition: "hostile",
        hidden: Boolean(encounter.hidden ?? true),
        encounterId: UUID_PATTERN.test(String(encounter.id ?? "")) ? encounter.id : null,
        metadata: { description: text(encounter.description ?? "", `mapResult.encounters[${index}].description`, { max: 2_000 }) },
      });
    });
  }

  const sourceMapHash = sceneHash(map);
  const gmScene = validateMapScene({
    schemaVersion: 1,
    projection: "gm",
    id: sceneId,
    title: text(map.title ?? "Generated Scene", "mapResult.title", { required: true, max: 300 }),
    seed,
    mapType: text(map.mapType ?? "encounter", "mapResult.mapType", { required: true, max: 100 }),
    width: Math.round(dimensions.width),
    height: Math.round(dimensions.height),
    grid: { type: dimensions.type, size: dimensions.scale, units: dimensions.units },
    levels,
    fogEnabled: true,
    gmNotes: text(Array.isArray(map.gmNotes) ? map.gmNotes.join("\n") : map.gmNotes ?? "", "mapResult.gmNotes", { max: 12_000 }),
    sourceMapHash,
    metadata: { originality: map.originality ?? null },
  });
  const playerScene = createPlayerMapScene(gmScene);
  return { gmScene, playerScene, sourceMapHash };
}

export function createPlayerMapScene(gmValue) {
  const gm = validateMapScene(gmValue);
  const player = {
    ...structuredClone(gm),
    projection: "player",
    gmNotes: "",
    levels: gm.levels.map((current) => ({
      ...structuredClone(current),
      gmNotes: "",
      walls: current.walls.filter((entry) => !entry.secret),
      doors: current.doors.filter((entry) => !entry.secret),
      windows: current.windows.filter((entry) => !entry.secret),
      terrain: current.terrain.filter((entry) => !entry.hidden),
      lights: current.lights.filter((entry) => !entry.hidden),
      fogRegions: current.fogRegions.filter((entry) => entry.revealed),
      tokens: current.tokens.filter((entry) => !entry.hidden).map((entry) => ({ ...entry, metadata: {} })),
      pointsOfInterest: current.pointsOfInterest.filter((entry) => !entry.secret && entry.revealed),
    })),
    metadata: {},
  };
  return validateMapScene(player);
}

export function validateMapSceneSaveRequest(value) {
  const input = object(value, "body");
  strictKeys(input, ["sceneId", "name", "gmScene", "playerScene", "expectedRevision"], "body");
  const gmScene = validateMapScene(input.gmScene);
  const playerScene = validateMapScene(input.playerScene);
  if (gmScene.projection !== "gm") fail("gmScene must use the gm projection", "gmScene.projection");
  if (playerScene.projection !== "player") fail("playerScene must use the player projection", "playerScene.projection");
  if (gmScene.id !== playerScene.id || gmScene.sourceMapHash !== playerScene.sourceMapHash) {
    fail("GM and player scenes must describe the same scene", "playerScene");
  }
  const expectedPlayer = createPlayerMapScene(gmScene);
  if (sceneHash(expectedPlayer) !== sceneHash(playerScene)) {
    fail("playerScene must be the canonical filtered projection of gmScene", "playerScene");
  }
  return {
    sceneId: uuid(input.sceneId, "sceneId"),
    name: text(input.name ?? gmScene.title, "name", { required: true, max: 300 }),
    gmScene,
    playerScene,
    expectedRevision: integer(input.expectedRevision, "expectedRevision", { min: 0, max: 1_000_000 }),
  };
}

export function validateMapSceneApprovalRequest(value) {
  const input = object(value, "body");
  strictKeys(input, ["expectedRevision"], "body");
  if (!Object.hasOwn(input, "expectedRevision")) fail("expectedRevision is required", "expectedRevision");
  return { expectedRevision: integer(input.expectedRevision, "expectedRevision", { min: 1, max: 1_000_000 }) };
}

export function validateMapSceneExportRequest(value) {
  const input = object(value, "body");
  strictKeys(input, ["target", "projection"], "body");
  return {
    target: enumValue(input.target, "target", EXPORT_TARGETS, "khaos_scene"),
    projection: enumValue(input.projection, "projection", ["gm", "player"], "player"),
  };
}

function exportPayload(sceneValue, target) {
  const scene = validateMapScene(sceneValue);
  if (target === "khaos_scene") return { format: "khaos_scene", version: 1, scene };
  if (target === "universal_vtt_style") {
    return {
      format: "universal_vtt_style",
      version: 1,
      resolution: { map_size: { x: scene.width, y: scene.height }, pixels_per_grid: 100 },
      line_of_sight: scene.levels.flatMap((levelValue) => levelValue.walls.filter((entry) => entry.blocksSight).map((entry) => [entry.a, entry.b])),
      portals: scene.levels.flatMap((levelValue) => levelValue.doors.map((entry) => ({
        id: entry.id,
        bounds: [entry.a, entry.b],
        closed: entry.state === "closed",
        locked: entry.locked,
      }))),
      lights: scene.levels.flatMap((levelValue) => levelValue.lights.map((entry) => ({
        id: entry.id,
        position: entry.position,
        range: entry.dimRadius,
      }))),
      environment: { levels: scene.levels.map((entry) => ({ id: entry.id, name: entry.name, elevation: entry.elevation })) },
      metadata: { sceneId: scene.id, projection: scene.projection, sourceMapHash: scene.sourceMapHash },
    };
  }
  return {
    format: "foundry_scene_data",
    version: 1,
    scene: {
      _id: scene.id,
      name: scene.title,
      width: scene.width * 100,
      height: scene.height * 100,
      grid: { type: scene.grid.type, size: 100, distance: scene.grid.size, units: scene.grid.units },
      walls: scene.levels.flatMap((levelValue) => [
        ...levelValue.walls.map((entry) => ({ _id: entry.id, c: [entry.a.x * 100, entry.a.y * 100, entry.b.x * 100, entry.b.y * 100], move: entry.blocksMovement ? 1 : 0, sight: entry.blocksSight ? 1 : 0, door: 0 })),
        ...levelValue.doors.map((entry) => ({ _id: entry.id, c: [entry.a.x * 100, entry.a.y * 100, entry.b.x * 100, entry.b.y * 100], move: 1, sight: 1, door: 1, ds: entry.state === "open" ? 1 : 0, locked: entry.locked })),
      ]),
      lights: scene.levels.flatMap((levelValue) => levelValue.lights.map((entry) => ({ _id: entry.id, x: entry.position.x * 100, y: entry.position.y * 100, bright: entry.brightRadius, dim: entry.dimRadius }))),
      tokens: scene.levels.flatMap((levelValue) => levelValue.tokens.map((entry) => ({ _id: entry.id, name: entry.name, x: entry.position.x * 100, y: entry.position.y * 100, width: entry.size, height: entry.size, disposition: entry.disposition }))),
      flags: { khaosNexus: { schemaVersion: scene.schemaVersion, projection: scene.projection, sourceMapHash: scene.sourceMapHash, levels: scene.levels.map((entry) => ({ id: entry.id, name: entry.name, elevation: entry.elevation })) } },
    },
  };
}

export function createMapSceneExport(sceneValue, targetValue, revision = 1) {
  const target = enumValue(targetValue, "target", EXPORT_TARGETS, "khaos_scene");
  const scene = validateMapScene(sceneValue);
  const payload = exportPayload(scene, target);
  const hash = sceneHash(payload);
  return {
    target,
    projection: scene.projection,
    filename: `${slug(scene.title)}-r${revision}-${scene.projection}-${target}.json`,
    contentType: "application/json",
    hashAlgorithm: "sha256",
    hash,
    payload,
  };
}

export function renderMapSceneSvg(sceneValue, levelIndex = 0) {
  const scene = validateMapScene(sceneValue);
  const levelValue = scene.levels.find((entry) => entry.index === levelIndex) ?? scene.levels[0];
  const scale = 20;
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const lines = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width * scale}" height="${scene.height * scale}" viewBox="0 0 ${scene.width * scale} ${scene.height * scale}">`);
  lines.push(`<rect width="100%" height="100%" fill="white"/>`);
  if (scene.grid.type !== "none") {
    for (let x = 0; x <= scene.width; x += 1) lines.push(`<line x1="${x * scale}" y1="0" x2="${x * scale}" y2="${scene.height * scale}" stroke="currentColor" stroke-opacity="0.12"/>`);
    for (let y = 0; y <= scene.height; y += 1) lines.push(`<line x1="0" y1="${y * scale}" x2="${scene.width * scale}" y2="${y * scale}" stroke="currentColor" stroke-opacity="0.12"/>`);
  }
  for (const entry of levelValue.terrain) lines.push(`<rect x="${entry.bounds.x * scale}" y="${entry.bounds.y * scale}" width="${entry.bounds.width * scale}" height="${entry.bounds.height * scale}" fill="none" stroke="currentColor" stroke-dasharray="4 2"><title>${escape(entry.name)}</title></rect>`);
  for (const entry of levelValue.walls) lines.push(`<line x1="${entry.a.x * scale}" y1="${entry.a.y * scale}" x2="${entry.b.x * scale}" y2="${entry.b.y * scale}" stroke="currentColor" stroke-width="3"/>`);
  for (const entry of levelValue.doors) lines.push(`<line x1="${entry.a.x * scale}" y1="${entry.a.y * scale}" x2="${entry.b.x * scale}" y2="${entry.b.y * scale}" stroke="currentColor" stroke-width="5" stroke-dasharray="3 2"><title>${escape(entry.label)}</title></line>`);
  for (const entry of levelValue.pointsOfInterest) lines.push(`<circle cx="${entry.position.x * scale}" cy="${entry.position.y * scale}" r="5" fill="currentColor"><title>${escape(entry.name)}</title></circle>`);
  for (const entry of levelValue.tokens) lines.push(`<circle cx="${entry.position.x * scale}" cy="${entry.position.y * scale}" r="8" fill="none" stroke="currentColor" stroke-width="2"><title>${escape(entry.name)}</title></circle>`);
  lines.push(`<text x="8" y="18" font-family="sans-serif" font-size="14">${escape(scene.title)} — ${escape(levelValue.name)}</text>`);
  lines.push("</svg>");
  return lines.join("");
}
