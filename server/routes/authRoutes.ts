import express from 'express';
import type { Request, Response, Router } from 'express';
import {
  getAuthMode,
  getExpectedApiKey,
  timingSafeCompare,
  createSession,
  destroySession,
  checkLoginRateLimit,
  parseCookies,
  buildSessionCookieHeader,
  buildClearCookieHeader,
  isRequestAuthenticated,
  SESSION_TTL_MS
} from '../middleware/auth.ts';

export function createAuthRouter(): Router {
  const router = express.Router();

  // POST /api/auth/login
  router.post('/login', (req: Request, res: Response) => {
    const ip = req.ip || (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || '127.0.0.1';

    // Rate limiting: 5 attempts per minute per IP
    const rateCheck = checkLoginRateLimit(ip, 5, 60000);
    if (!rateCheck.allowed) {
      console.warn(`[AUTH] Login rate limit exceeded for IP ${ip}`);
      return res.status(429).json({
        success: false,
        error: 'Too many login attempts. Please wait 1 minute before retrying.'
      });
    }

    const { key } = req.body || {};
    if (!key || typeof key !== 'string') {
      return res.status(401).json({
        success: false,
        error: 'API key is required'
      });
    }

    const expectedKey = getExpectedApiKey();
    if (!expectedKey) {
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({
          success: false,
          error: 'Server authentication unconfigured in production environment'
        });
      }
      return res.status(401).json({
        success: false,
        error: 'No server API key configured'
      });
    }

    const isValid = timingSafeCompare(key.trim(), expectedKey.trim());
    if (!isValid) {
      console.warn(`[AUTH] Failed login attempt from ${ip}`);
      return res.status(401).json({
        success: false,
        error: 'Invalid API key'
      });
    }

    const token = createSession(ip, SESSION_TTL_MS);
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', buildSessionCookieHeader(token, SESSION_TTL_MS, isSecure));

    console.log(`[AUTH] Successful login session created for IP ${ip}`);
    return res.json({
      success: true,
      message: 'Authenticated successfully'
    });
  });

  // POST /api/auth/logout
  router.post('/logout', (req: Request, res: Response) => {
    const rawCookieHeader = req.headers.cookie;
    const cookies = parseCookies(rawCookieHeader);
    const token = cookies.session_token || cookies.auth_token;

    if (token) {
      destroySession(token);
    }

    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', buildClearCookieHeader(isSecure));

    return res.json({
      success: true,
      message: 'Logged out successfully'
    });
  });

  // GET /api/auth/status
  router.get('/status', (req: Request, res: Response) => {
    const mode = getAuthMode();
    const hasKey = Boolean(getExpectedApiKey());
    const required = mode !== 'disabled' && (process.env.NODE_ENV === 'production' || hasKey || process.env.AUTH_REQUIRED === '1');
    const authenticated = !required || isRequestAuthenticated(req);

    return res.json({
      success: true,
      required,
      authenticated,
      mode
    });
  });

  return router;
}
