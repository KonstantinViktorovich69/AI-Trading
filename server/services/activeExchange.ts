import ccxt from 'ccxt';

export const SUPPORTED_EXCHANGES = ['weex'] as const;
export type SupportedExchange = (typeof SUPPORTED_EXCHANGES)[number];
export const DEFAULT_EXCHANGE: SupportedExchange = 'weex';

export function normalizeExchangeId(raw: unknown): SupportedExchange {
  if (typeof raw !== 'string') return DEFAULT_EXCHANGE;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'weex') return 'weex';
  return DEFAULT_EXCHANGE;
}

export function resolveActiveExchange(settings?: any): SupportedExchange {
  return normalizeExchangeId(settings?.exchangeApiConfig?.exchange);
}

export function guessExchangeFromApiKey(apiKey?: string): SupportedExchange | null {
  if (typeof apiKey !== 'string') return null;
  if (/^weex_/i.test(apiKey.trim())) return 'weex';
  return null;
}

export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
  password?: string;
}

export interface DetectDeps {
  createClient?: (exchange: SupportedExchange, creds: ExchangeCredentials, opts?: { headers?: Record<string, string> }) => { fetchBalance: (params?: any) => Promise<any> };
  headers?: Record<string, string>;
  timeoutMs?: number; // по умолчанию 10000
}

export type DetectResult = { success: true; exchange: SupportedExchange } | { success: false; error: string };

function redactSecrets(msg: string, creds: ExchangeCredentials): string {
  let result = msg;
  if (creds.apiKey && creds.apiKey.trim()) {
    result = result.split(creds.apiKey.trim()).join('***');
  }
  if (creds.apiSecret && creds.apiSecret.trim()) {
    result = result.split(creds.apiSecret.trim()).join('***');
  }
  if (creds.password && creds.password.trim()) {
    result = result.split(creds.password.trim()).join('***');
  }
  return result;
}

function defaultCreateClient(exchange: SupportedExchange, creds: ExchangeCredentials, opts?: { headers?: Record<string, string> }) {
  const exClass = (ccxt.pro as any)[exchange] || (ccxt as any)[exchange];
  if (!exClass) {
    throw new Error(`Биржа не поддерживается: ${exchange}`);
  }
  return new exClass({
    apiKey: creds.apiKey,
    secret: creds.apiSecret,
    password: creds.password,
    enableRateLimit: true,
    options: { defaultType: 'swap' },
    headers: opts?.headers
  });
}

export async function detectExchangeByCredentials(
  creds: ExchangeCredentials,
  deps?: DetectDeps
): Promise<DetectResult> {
  const rawKey = creds?.apiKey ? String(creds.apiKey).trim() : '';
  const rawSecret = creds?.apiSecret ? String(creds.apiSecret).trim() : '';

  if (!rawKey || !rawSecret) {
    return { success: false, error: 'Не указан API-ключ или секрет' };
  }

  const cleanCreds: ExchangeCredentials = {
    apiKey: rawKey,
    apiSecret: rawSecret,
    password: creds?.password ? String(creds.password).trim() : undefined
  };

  const guessed = guessExchangeFromApiKey(rawKey);
  const candidates: SupportedExchange[] = guessed ? [guessed] : [...SUPPORTED_EXCHANGES];

  const createClient = deps?.createClient || defaultCreateClient;
  const timeoutMs = typeof deps?.timeoutMs === 'number' ? deps.timeoutMs : 10000;
  let lastError = '';

  for (const candidate of candidates) {
    let timeoutHandle: any;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Превышен таймаут ожидания ответа биржи (${timeoutMs} мс)`));
      }, timeoutMs);
    });

    try {
      const client = createClient(candidate, cleanCreds, { headers: deps?.headers });
      await Promise.race([
        client.fetchBalance({ type: 'swap' }),
        timeoutPromise
      ]);
      clearTimeout(timeoutHandle);
      return { success: true, exchange: candidate };
    } catch (err: any) {
      clearTimeout(timeoutHandle);
      lastError = err?.message || String(err);
    }
  }

  const safeError = redactSecrets(lastError, cleanCreds);
  return {
    success: false,
    error: `Ключ не подошёл ни к одной поддерживаемой бирже (WEEX): ${safeError}`
  };
}
