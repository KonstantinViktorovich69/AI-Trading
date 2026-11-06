/**
 * Стабильное слияние сделок по ID: сохраняет полную историю и обеспечивает
 * сервер как абсолютный источник истины.
 * Если incoming.length > 0, сделки, отсутствующие на сервере, удаляются.
 */
export function mergeTradesById(existing: any[], incoming: any[]): any[] {
  if (!incoming || incoming.length === 0) return existing;

  const map = new Map<string, any>();
  for (const t of (existing || [])) {
    if (t && t.id) map.set(t.id, t);
  }
  for (const t of incoming) {
    if (t && t.id) {
      const prev = map.get(t.id);
      const { decisionTrace, gateDiagnostics, correlationContext, ...leanIncoming } = t;
      map.set(t.id, prev ? { ...prev, ...leanIncoming } : leanIncoming);
    }
  }

  // Сервер является абсолютным источником истины для статуса OPEN
  const serverOpenIds = new Set(incoming.filter((t: any) => t && t.status === 'OPEN').map((t: any) => t.id));
  const now = Date.now();
  for (const [id, t] of map.entries()) {
    if (t.status === 'OPEN' && !serverOpenIds.has(id)) {
      if (!t.openTime || (now - t.openTime >= 15000)) {
        map.set(id, { ...t, status: 'CLOSED', closeTime: t.closeTime || now });
      }
    }
  }

  // Если incoming.length > 0, сервер является источником истины:
  // удаляем из результата все сделки, id которых нет в incoming
  const incomingIds = new Set(incoming.filter((t: any) => t && t.id).map((t: any) => t.id));
  const validTrades = Array.from(map.values()).filter((t: any) => incomingIds.has(t.id));

  return validTrades.sort((a, b) => {
    if (a.status === 'OPEN' && b.status !== 'OPEN') return -1;
    if (a.status !== 'OPEN' && b.status === 'OPEN') return 1;
    const timeA = a.closeTime || a.openTime || 0;
    const timeB = b.closeTime || b.openTime || 0;
    return timeB - timeA;
  });
}
