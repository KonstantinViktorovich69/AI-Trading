import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export type AuthMode = 'disabled' | 'session' | 'api-key';

export function getAuthMode(): AuthMode {
  const envMode = (process.env.AUTH_MODE || '').toLowerCase();
  if (envMode === 'session' || envMode === 'api-key') {
    return envMode as AuthMode;
  }
  if (envMode === 'disabled') {
    return 'disabled';
  }
  // Default behaviour: in development allow 'disabled', in production default to 'api-key'
  if (process.env.NODE_ENV === 'production') {
    return 'api-key';
  }
  return 'disabled';
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
    '/favicon.ico'
  ];

  if (publicRoutes.includes(cleanPath)) return true;

  // Static assets
  if (cleanPath.startsWith('/assets/') || cleanPath.endsWith('.js') || cleanPath.endsWith('.css') || cleanPath.endsWith('.png') || cleanPath.endsWith('.svg')) {
    return true;
  }

  return false;
}

export function validateApiKey(providedKey: string): boolean {
  const expectedKey = process.env.API_ACCESS_KEY || process.env.ADMIN_API_KEY;
  if (!expectedKey || !providedKey) return false;

  try {
    const bufProvided = Buffer.from(providedKey);
    const bufExpected = Buffer.from(expectedKey);

    if (bufProvided.length !== bufExpected.length) {
      return false;
    }

    return crypto.timingSafeEqual(bufProvided, bufExpected);
  } catch (e) {
    return false;
  }
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

  // Check X-API-Key header or Bearer Token or Session Cookie
  const headerKey = (req.headers['x-api-key'] as string) || (req.headers['authorization'] as string)?.replace('Bearer ', '');
  const cookieKey = req.cookies?.auth_token;

  const keyToValidate = headerKey || cookieKey;

  if (keyToValidate && validateApiKey(keyToValidate)) {
    return next();
  }

  // If no expected API key is set in production environment config
  const hasConfiguredKey = Boolean(process.env.API_ACCESS_KEY || process.env.ADMIN_API_KEY);
  if (!hasConfiguredKey && process.env.NODE_ENV === 'production') {
    console.error('[SECURITY CRITICAL] API_ACCESS_KEY not configured in production environment! Mutating API blocked.');
    return res.status(503).json({ success: false, error: 'Server authentication unconfigured in production environment' });
  }

  console.warn(`[AUTH] Unauthorized access attempt to ${req.method} ${req.path} from ${req.ip}`);
  return res.status(401).json({ success: false, error: 'Unauthorized: Valid X-API-Key or session required' });
}
