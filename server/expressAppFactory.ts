import express from 'express';
import type { Express } from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { authMiddleware } from './middleware/auth.ts';
import { createRealTradeRouter, type RealTradeRouterContext } from './routes/realTradeRoutes.ts';
import { createMarketRouter, type MarketRouterContext } from './routes/marketRoutes.ts';
import { createStreamRouter, type StreamRouterContext } from './routes/streamRoutes.ts';
import { createAiRoutes, type AiRoutesContext } from './routes/aiRoutes.ts';
import { createPaperTradeRouter } from './routes/paperTradeRoutes.ts';
import { createKnowledgeRouter, type KnowledgeRouterContext } from './routes/knowledgeRoutes.ts';
import { createSettingsRouter, type SettingsRouterContext } from './routes/settingsRoutes.ts';
import { createSystemRouter, type SystemRouterContext } from './routes/systemRoutes.ts';
import { createDebugRouter, type DebugRouterContext } from './routes/debugRoutes.ts';

export interface ExpressAppFactoryContexts {
  realTradeContext: RealTradeRouterContext;
  marketContext: MarketRouterContext;
  streamContext: StreamRouterContext;
  aiContext: AiRoutesContext;
  paperTradeContext: any;
  knowledgeContext: KnowledgeRouterContext;
  settingsContext: SettingsRouterContext;
  systemContext: SystemRouterContext;
  debugContext: DebugRouterContext;
}

export function createExpressApp(contexts: ExpressAppFactoryContexts): Express {
  const app = express();

  // Basic Middlewares
  app.use(express.json());

  // Debug router guard: in production, all debug routes return 404 Not Found regardless of API key
  app.use('/api', (req, res, next) => {
    if (process.env.NODE_ENV === 'production' && (req.path.startsWith('/debug') || req.path === '/debug-ohlcv' || req.path === '/debug-mexc')) {
      return res.status(404).json({ success: false, error: `API endpoint not found: ${req.method} ${req.path}` });
    }
    next();
  });

  app.use(authMiddleware);

  // Fast health-check endpoint for root load-balancer / platform health checks
  app.get('/health', (req, res) => {
    res.json({ success: true, status: 'ok', timestamp: new Date().toISOString() });
  });

  // Middleware for logging slow requests
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (duration > 5000) {
        console.warn(`[SLOW REQUEST] ${req.method} ${req.url} took ${duration}ms`);
      }
    });
    next();
  });

  // Mount API Routers
  app.use('/api', createRealTradeRouter(contexts.realTradeContext));
  app.use('/api', createMarketRouter(contexts.marketContext));
  app.use('/api', createStreamRouter(contexts.streamContext));
  app.use('/api', createAiRoutes(contexts.aiContext));
  app.use('/api', createPaperTradeRouter(contexts.paperTradeContext));
  app.use('/api', createKnowledgeRouter(contexts.knowledgeContext));
  app.use('/api', createSettingsRouter(contexts.settingsContext));
  app.use('/api', createSystemRouter(contexts.systemContext));
  if (process.env.NODE_ENV !== 'production') {
    app.use('/api', createDebugRouter(contexts.debugContext));
  }

  // Catch-all JSON 404 for any unmatched /api/* route to prevent Vite SPA HTML fallback
  app.all('/api/*', (req, res) => {
    res.status(404).json({ success: false, error: `API endpoint not found: ${req.method} ${req.path}` });
  });

  return app;
}

export async function setupStaticAndViteMiddleware(app: Express, isProd = process.env.NODE_ENV === 'production'): Promise<void> {
  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        watch: {
          ignored: [
            '**/data/**',
            '**/server/**',
            '**/*.json',
            '**/*.log',
            '**/*.tmp*',
            '**/node_modules/**',
            '**/.git/**',
          ],
        },
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}
