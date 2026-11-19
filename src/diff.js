/**
 * Minimal line diff for showing proposed changes in the terminal.
 * Returns lines prefixed with " ", "-" or "+", with unchanged runs collapsed.
 */
export function lineDiff(before, after, { context = 3, maxCells = 4_000_000 } = {}) {
  const a = before === "" ? [] : before.split(/\r?\n/);
  const b = after === "" ? [] : after.split(/\r?\n/);

  // Trim the common prefix/suffix so the LCS table only covers the changed middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  let ops;
  if (midA.length * midB.length > maxCells) {
    ops = [...midA.map((l) => ["-", l]), ...midB.map((l) => ["+", l])];
  } else {
    ops = lcsOps(midA, midB);
  }
  const all = [
    ...a.slice(0, start).map((l) => [" ", l]),
    ...ops,
    ...a.slice(endA).map((l) => [" ", l]),
  ];
  return collapse(all, context);
}

function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([" ", a[i++]]);
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(["-", a[i++]]);
    } else {
      ops.push(["+", b[j++]]);
    }
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);
  return ops;
}

function collapse(ops, context) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach(([kind], idx) => {
    if (kind === " ") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });
  const out = [];
  let skipped = 0;
  ops.forEach(([kind, line], idx) => {
    if (keep[idx]) {
      if (skipped) out.push(`  ... ${skipped} unchanged line${skipped === 1 ? "" : "s"} ...`);
      skipped = 0;
      out.push(`${kind} ${line}`);
    } else {
      skipped++;
    }
  });
  return out;
}
