import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Request, Response } from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import {
  authMiddleware,
  clearSessionsForTest,
  clearLoginRateLimitForTest,
  createSession,
  parseCookies
} from './auth.ts';
import { createAuthRouter } from '../routes/authRoutes.ts';
import { OWNER_ID, DEFAULT_OWNER_ID, getOwnerId } from '../config/owner.ts';

describe('Phase 6: Auth, Secrets, & Session Security (T6.1, T6.2, T6.3)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    clearSessionsForTest();
    clearLoginRateLimitForTest();
  });

  afterEach(() => {
    process.env = originalEnv;
    clearSessionsForTest();
    clearLoginRateLimitForTest();
  });

  describe('T6.1 Session Auth & CSRF Protection', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeEach(async () => {
      process.env.NODE_ENV = 'production';
      process.env.AUTH_MODE = 'api-key';
      process.env.API_KEY = 'test_secret_key_123';

      const app = express();
      app.use(express.json());

      // Mount auth router
      app.use('/api/auth', createAuthRouter());

      // Protected route guarded by authMiddleware
      app.get('/api/protected', authMiddleware, (req: Request, res: Response) => {
        res.json({ success: true, message: 'secret data', method: req.method });
      });

      app.post('/api/protected-mutate', authMiddleware, (req: Request, res: Response) => {
        res.json({ success: true, message: 'mutated', method: req.method });
      });

      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
          const addr = server.address() as any;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('blocks request without cookie or key with 401', async () => {
      const res = await fetch(`${baseUrl}/api/protected`);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('Unauthorized');
    });

    it('allows request with valid X-API-Key with 200', async () => {
      const res = await fetch(`${baseUrl}/api/protected`, {
        headers: { 'X-API-Key': 'test_secret_key_123' }
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toBe('secret data');
    });

    it('returns 401 on login with invalid key', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'wrong_key' })
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid API key');
    });

    it('enforces rate limiting: 6th attempt in a minute returns 429', async () => {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'wrong_key' })
        });
        expect(res.status).toBe(401);
      }

      // 6th attempt should be blocked with 429
      const sixthRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'wrong_key' })
      });
      expect(sixthRes.status).toBe(429);
      const body = await sixthRes.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('Too many login attempts');
    });

    it('allows login with valid key, sets HttpOnly cookie, and allows subsequent requests', async () => {
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'test_secret_key_123' })
      });
      expect(loginRes.status).toBe(200);
      const setCookie = loginRes.headers.get('set-cookie');
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain('session_token=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');

      // Extract cookie
      const cookies = parseCookies(setCookie || '');
      const token = cookies.session_token;
      expect(token).toBeTruthy();

      // Access protected GET route with cookie
      const getRes = await fetch(`${baseUrl}/api/protected`, {
        headers: { Cookie: `session_token=${token}` }
      });
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.success).toBe(true);
    });

    it('blocks mutating POST with session cookie if Origin does not match Host with 403', async () => {
      const token = createSession('127.0.0.1');

      // Request with mismatched Origin (attacker site)
      const res = await fetch(`${baseUrl}/api/protected-mutate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session_token=${token}`,
          Origin: 'https://evil-attacker.com'
        },
        body: JSON.stringify({ foo: 'bar' })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('CSRF check failed: Origin does not match Host');
    });

    it('allows mutating POST with session cookie if Origin matches Host', async () => {
      const token = createSession('127.0.0.1');

      const res = await fetch(`${baseUrl}/api/protected-mutate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session_token=${token}`,
          Origin: baseUrl
        },
        body: JSON.stringify({ foo: 'bar' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toBe('mutated');
    });

    it('GET /api/auth/status returns correct required and authenticated states', async () => {
      // Unauthenticated status
      const res1 = await fetch(`${baseUrl}/api/auth/status`);
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.required).toBe(true);
      expect(body1.authenticated).toBe(false);

      // Authenticated status via session cookie
      const token = createSession('127.0.0.1');
      const res2 = await fetch(`${baseUrl}/api/auth/status`, {
        headers: { Cookie: `session_token=${token}` }
      });
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.required).toBe(true);
      expect(body2.authenticated).toBe(true);
    });

    it('POST /api/auth/logout invalidates session and clears cookie', async () => {
      const token = createSession('127.0.0.1');

      const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: `session_token=${token}` }
      });
      expect(logoutRes.status).toBe(200);
      const clearCookie = logoutRes.headers.get('set-cookie');
      expect(clearCookie).toContain('Max-Age=0');

      // Subsequent request with invalidated token should fail with 401
      const getRes = await fetch(`${baseUrl}/api/protected`, {
        headers: { Cookie: `session_token=${token}` }
      });
      expect(getRes.status).toBe(401);
    });
  });

  describe('T6.2 Client Gemini Key Removal Verification', () => {
    it('verifies src/ codebase contains zero references to VITE_GEMINI_API_KEY or __GEMINI_API_KEY__', () => {
      const srcDir = path.resolve(process.cwd(), 'src');

      function scanDir(dir: string, matches: string[]) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            scanDir(fullPath, matches);
          } else if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.jsx')) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            if (content.includes('VITE_GEMINI_API_KEY')) {
              matches.push(`${fullPath}: references VITE_GEMINI_API_KEY`);
            }
            if (content.includes('__GEMINI_API_KEY__')) {
              matches.push(`${fullPath}: references __GEMINI_API_KEY__`);
            }
          }
        }
      }

      const foundMatches: string[] = [];
      scanDir(srcDir, foundMatches);
      expect(foundMatches).toEqual([]);
    });
  });

  describe('T6.3 Owner Identity Configuration', () => {
    it('provides fallback to default owner while allowing process.env.OWNER_ID override', () => {
      expect(DEFAULT_OWNER_ID).toBe('polyakovats3110@gmail.com');

      delete process.env.OWNER_ID;
      expect(getOwnerId()).toBe('polyakovats3110@gmail.com');

      process.env.OWNER_ID = 'custom_owner@example.com';
      expect(getOwnerId()).toBe('custom_owner@example.com');
    });
  });
});
