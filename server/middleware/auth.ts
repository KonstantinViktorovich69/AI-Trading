import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export type AuthMode = 'disabled' | 'session' | 'api-key';

export interface SessionRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
}

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// In-memory session store
const sessions = new Map<string, SessionRecord>();

// In-memory login rate limiter (max 5 attempts/minute per IP)
interface RateLimitEntry {
  count: number;
  resetAt: number;
}
const loginRateLimitMap = new Map<string, RateLimitEntry>();

export function getExpectedApiKey(): string | undefined {
  return process.env.API_KEY || process.env.API_ACCESS_KEY || process.env.ADMIN_API_KEY;
}

export function getAuthMode(): AuthMode {
  const envMode = (process.env.AUTH_MODE || '').toLowerCase();
  if (envMode === 'session' || envMode === 'api-key') {
    return envMode as AuthMode;
  }
  if (envMode === 'disabled') {
    return 'disabled';
  }
  if (process.env.AUTH_REQUIRED === '1' || process.env.AUTH_REQUIRED === 'true') {
    return 'api-key';
  }
  // Default behaviour: in development allow 'disabled', in production default to 'api-key'
  if (process.env.NODE_ENV === 'production') {
    return 'api-key';
  }
  return 'disabled';
}

export function timingSafeCompare(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  try {
    const bufProvided = Buffer.from(provided);
    const bufExpected = Buffer.from(expected);
    if (bufProvided.length !== bufExpected.length) {
      return false;
    }
    return crypto.timingSafeEqual(bufProvided, bufExpected);
  } catch {
    return false;
  }
}

export function validateApiKey(providedKey: string): boolean {
  const expectedKey = getExpectedApiKey();
  if (!expectedKey || !providedKey) return false;
  return timingSafeCompare(providedKey, expectedKey);
}

export function createSession(ip: string, ttlMs = SESSION_TTL_MS): string {
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(id, {
    id,
    createdAt: now,
    expiresAt: now + ttlMs,
    ip
  });
  return id;
}

export function isValidSession(token: string): boolean {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token: string): boolean {
  if (!token) return false;
  return sessions.delete(token);
}

export function clearSessionsForTest(): void {
  sessions.clear();
}

export function checkLoginRateLimit(ip: string, maxAttempts = 5, windowMs = 60000): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = loginRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    loginRateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxAttempts - 1 };
  }
  if (entry.count >= maxAttempts) {
    return { allowed: false, remaining: 0 };
  }
  entry.count++;
  return { allowed: true, remaining: maxAttempts - entry.count };
}

export function clearLoginRateLimitForTest(): void {
  loginRateLimitMap.clear();
}

export function parseCookies(cookieHeader?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const key = part.substring(0, idx).trim();
      const val = part.substring(idx + 1).trim();
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

export function buildSessionCookieHeader(token: string, maxAgeMs = SESSION_TTL_MS, secure = false): string {
  const parts = [
    `session_token=${token}`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict'
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function buildClearCookieHeader(secure = false): string {
  const parts = [
    'session_token=',
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Strict'
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function isPublicPath(path: string): boolean {
  if (!path) return false;
  const cleanPath = path.split('?')[0];

  const publicRoutes = [
    '/',
    '/health',
    '/api/health',
    '/api/ping',
    '/api/system/status',
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/status',
    '/favicon.ico'
  ];

  if (publicRoutes.includes(cleanPath)) return true;

  // Static assets
  if (cleanPath.startsWith('/assets/') || cleanPath.endsWith('.js') || cleanPath.endsWith('.css') || cleanPath.endsWith('.png') || cleanPath.endsWith('.svg')) {
    return true;
  }

  return false;
}

export function isRequestAuthenticated(req: Request): boolean {
  const headerKey = (req.headers['x-api-key'] as string) || (req.headers['authorization'] as string)?.replace('Bearer ', '');
  if (headerKey && validateApiKey(headerKey)) {
    return true;
  }

  const rawCookieHeader = req.headers.cookie;
  const cookies = parseCookies(rawCookieHeader);
  const cookieKey = cookies.session_token || cookies.auth_token;

  if (cookieKey && isValidSession(cookieKey)) {
    return true;
  }

  // Also support legacy direct api key in auth_token cookie
  if (cookieKey && validateApiKey(cookieKey)) {
    return true;
  }

  return false;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const mode = getAuthMode();

  if (isPublicPath(req.path)) {
    return next();
  }

  // If AUTH_MODE is explicitly disabled in DEV, allow requests
  if (mode === 'disabled') {
    if (process.env.NODE_ENV === 'production') {
      console.error('[SECURITY ALERT] AUTH_MODE=disabled is forbidden in production! Blocking request.');
      return res.status(403).json({ success: false, error: 'Disabled auth mode forbidden in production environment' });
    }
    return next();
  }

  // Check X-API-Key header or Bearer Token
  const headerKey = (req.headers['x-api-key'] as string) || (req.headers['authorization'] as string)?.replace('Bearer ', '');
  if (headerKey && validateApiKey(headerKey)) {
    return next();
  }

  // Check Session Cookie
  const rawCookieHeader = req.headers.cookie;
  const cookies = parseCookies(rawCookieHeader);
  const cookieKey = cookies.session_token || cookies.auth_token || req.cookies?.auth_token;

  if (cookieKey && (isValidSession(cookieKey) || validateApiKey(cookieKey))) {
    // CSRF protection for mutating requests authenticated via cookie:
    // If Origin header is present on POST/PUT/PATCH/DELETE, it must match Host
    const method = req.method.toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const originHeader = req.headers.origin as string;
      if (originHeader) {
        try {
          const originUrl = new URL(originHeader);
          const rawHost = ((req.headers['x-forwarded-host'] as string) || req.headers.host || '').toLowerCase();
          const originHost = originUrl.host.toLowerCase();

          if (originHost !== rawHost) {
            console.warn(`[AUTH CSRF] Origin mismatch: origin host "${originHost}" !== host "${rawHost}"`);
            return res.status(403).json({ success: false, error: 'CSRF check failed: Origin does not match Host' });
          }
        } catch {
          return res.status(403).json({ success: false, error: 'CSRF check failed: Invalid Origin header' });
        }
      }
    }

    return next();
  }

  // If no expected API key is set in production environment config
  const hasConfiguredKey = Boolean(getExpectedApiKey());
  if (!hasConfiguredKey && process.env.NODE_ENV === 'production') {
    console.error('[SECURITY CRITICAL] API_ACCESS_KEY/API_KEY not configured in production environment! Mutating API blocked.');
    return res.status(503).json({ success: false, error: 'Server authentication unconfigured in production environment' });
  }

  console.warn(`[AUTH] Unauthorized access attempt to ${req.method} ${req.path} from ${req.ip}`);
  return res.status(401).json({ success: false, error: 'Unauthorized: Valid X-API-Key or session required' });
}
