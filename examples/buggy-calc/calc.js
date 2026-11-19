// A tiny statistics module with real bugs in it, for trying out Debugger:
//   npm run demo
// (or: debugger fix "node --test examples/buggy-calc")

export function average(numbers) {
  if (numbers.length === 0) return 0;
  let total = 0;
  for (let i = 1; i < numbers.length; i++) {
    total += numbers[i];
  }
  return total / numbers.length;
}

export function median(numbers) {
  if (numbers.length === 0) return 0;
  const sorted = numbers.sort();
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
