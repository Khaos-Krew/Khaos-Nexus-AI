const notationPattern = /^(\d{1,3})d(\d{1,4})(kh1|kl1)?([+-]\d+)?$/i;

export function rollDice(rawNotation, random = Math.random) {
  const notation = rawNotation.replaceAll(" ", "").toLowerCase();
  const match = notationPattern.exec(notation);
  if (!match) {
    throw new Error("Use dice notation such as 1d20+5, 2d20kh1+3, or 4d6");
  }

  const count = Number(match[1]);
  const sides = Number(match[2]);
  const keep = match[3];
  const modifier = Number(match[4] ?? 0);
  if (count < 1 || count > 100) throw new Error("Dice count must be between 1 and 100");
  if (sides < 2 || sides > 1000) throw new Error("Die sides must be between 2 and 1000");

  const rolls = Array.from({ length: count }, () => Math.floor(random() * sides) + 1);
  let kept = [...rolls];
  if (keep === "kh1") kept = [Math.max(...rolls)];
  if (keep === "kl1") kept = [Math.min(...rolls)];

  return {
    notation,
    rolls,
    kept,
    modifier,
    total: kept.reduce((sum, value) => sum + value, modifier),
  };
}
