// Централизованный клиент для новых/будущих API-вызовов.
// Существующие разрозненные fetch(...) по всему приложению пока НЕ переводятся на этот клиент — 
// это отдельная задача, требующая аккуратной замены всех ~108 мест с проверкой каждого.
const API_ACCESS_KEY = (import.meta as any).env?.VITE_API_ACCESS_KEY || '';

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers: HeadersInit = {
    ...(options.headers || {}),
    ...(API_ACCESS_KEY ? { 'X-API-Key': API_ACCESS_KEY } : {})
  };
  return fetch(url, { ...options, headers });
}
