export function requireExpectedRevision(body, {
  field = "expectedRevision",
  minimum = 0,
  maximum = 1_000_000,
} = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("body must be an object");
    error.name = "ValidationError";
    error.field = "body";
    throw error;
  }
  if (!Object.hasOwn(body, field)) {
    const error = new Error(`${field} is required`);
    error.name = "ValidationError";
    error.field = field;
    throw error;
  }
  const value = body[field];
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    const error = new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
    error.name = "ValidationError";
    error.field = field;
    throw error;
  }
  return value;
}
