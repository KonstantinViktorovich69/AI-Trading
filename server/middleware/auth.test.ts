import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isPublicPath, validateApiKey, getAuthMode, authMiddleware } from './auth.ts';

describe('Auth Middleware & Security Rules', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('allows public routes /health, /api/health, /api/ping without auth', () => {
    expect(isPublicPath('/health')).toBe(true);
    expect(isPublicPath('/api/health')).toBe(true);
    expect(isPublicPath('/api/ping')).toBe(true);
    expect(isPublicPath('/assets/main.js')).toBe(true);

    expect(isPublicPath('/api/paper-trade/open')).toBe(false);
    expect(isPublicPath('/api/settings')).toBe(false);
    expect(isPublicPath('/api/ai-tasks/complete')).toBe(false);
  });

  it('validates API key using constant time comparison', () => {
    process.env.API_ACCESS_KEY = 'secret123';

    expect(validateApiKey('secret123')).toBe(true);
    expect(validateApiKey('wrong123')).toBe(false);
    expect(validateApiKey('')).toBe(false);
  });

  it('blocks unauthorized mutating routes in production when AUTH_MODE=api-key', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'api-key';
    process.env.API_ACCESS_KEY = 'super_secret';

    const req: any = { path: '/api/paper-trade/open', headers: {}, method: 'POST' };
    let statusSent = 0;
    let jsonSent: any = null;
    let nextCalled = false;

    const res: any = {
      status: (code: number) => {
        statusSent = code;
        return {
          json: (data: any) => { jsonSent = data; }
        };
      }
    };
    const next = () => { nextCalled = true; };

    authMiddleware(req, res, next);

    expect(nextCalled).toBe(false);
    expect(statusSent).toBe(401);
    expect(jsonSent.error).toContain('Unauthorized');
  });

  it('allows request when valid X-API-Key header is provided', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'api-key';
    process.env.API_ACCESS_KEY = 'super_secret';

    const req: any = {
      path: '/api/paper-trade/open',
      headers: { 'x-api-key': 'super_secret' },
      method: 'POST'
    };
    let nextCalled = false;
    const res: any = {};
    const next = () => { nextCalled = true; };

    authMiddleware(req, res, next);

    expect(nextCalled).toBe(true);
  });
});
