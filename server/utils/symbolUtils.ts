import { normalizeSymbol, cleanSymbol } from '../quant.ts';

export { normalizeSymbol, cleanSymbol };

export function findTickerInMap(sym: string, map: Record<string, any> | undefined): any {
  if (!sym || !map) return undefined;
  if (map[sym]) return map[sym];

  const clean = cleanSymbol(sym);
  if (map[clean]) return map[clean];

  for (const k in map) {
    if (cleanSymbol(k) === clean) {
      return map[k];
    }
  }
  return undefined;
}
