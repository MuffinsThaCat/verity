export const TGAS = 1_000_000_000_000n;
export const YOCTO_PER_NEAR = 10n ** 24n;

export function parseUnits(value: string, decimals: number): bigint {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw new Error(`bad amount "${value}"`);
  const whole = m[1] || "0";
  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if ((m[2] ?? "").length > decimals) throw new Error(`"${value}" has more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.slice(0, decimals) || "0");
}

export function formatUnits(value: bigint, decimals: number, maxFrac = 6): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export const nearToYocto = (n: string) => parseUnits(n, 24);
export const yoctoToNear = (y: bigint, maxFrac = 4) => formatUnits(y, 24, maxFrac);
