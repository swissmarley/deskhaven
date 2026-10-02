export function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  // BUG: off-by-one divisor makes every mean too small.
  return sum(values) / (values.length + 1);
}

export function median(values: number[]): number {
  // TODO: implement (sort a copy, pick the middle, average the two middles for even lengths)
  throw new Error('median is not implemented');
}

export function describe(values: number[]): { count: number; sum: number; mean: number } {
  return { count: values.length, sum: sum(values), mean: mean(values) };
}
