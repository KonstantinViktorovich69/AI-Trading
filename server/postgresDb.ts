import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let isInitialized = false;

/**
 * Проверка наличия конфигурации PostgreSQL в переменных окружения
 */
export function isPostgresConfigured(): boolean {
  return Boolean(
    process.env.DATABASE_URL || 
    process.env.POSTGRES_URL || 
    (process.env.PGHOST && process.env.PGDATABASE)
  );
}

/**
 * Получение подключения к пулу PostgreSQL (с ленивой инициализацией)
 */
export function getPgPool(): pg.Pool | null {
  if (!isPostgresConfigured()) return null;

  if (!pool) {
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    
    if (connectionString) {
      pool = new Pool({
        connectionString,
        ssl: process.env.PGSSLMODE === 'disable' || connectionString.includes('localhost') 
          ? false 
          : { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
    } else {
      pool = new Pool({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT || 5432),
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
        ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
    }

    pool.on('error', (err) => {
      console.error('[POSTGRES DB] Unexpected error on idle client:', err);
    });
  }

  return pool;
}

/**
 * Инициализация схем и таблиц в PostgreSQL
 */
export async function initPostgresSchema(): Promise<boolean> {
  const p = getPgPool();
  if (!p) return false;

  try {
    const client = await p.connect();
    try {
      await client.query('BEGIN');

      // 1. Таблица сделок (trades)
      await client.query(`
        CREATE TABLE IF NOT EXISTS trades (
          id VARCHAR(128) PRIMARY KEY,
          symbol VARCHAR(64) NOT NULL,
          exchange VARCHAR(64) DEFAULT 'bybit',
          side VARCHAR(16) NOT NULL,
          status VARCHAR(16) NOT NULL,
          entry_price NUMERIC(20, 8),
          close_price NUMERIC(20, 8),
          amount NUMERIC(20, 8),
          leverage NUMERIC(10, 2),
          pnl NUMERIC(20, 4),
          pnl_percent NUMERIC(10, 4),
          signal_ai_score NUMERIC(5, 2),
          is_real BOOLEAN DEFAULT FALSE,
          mode VARCHAR(32) DEFAULT 'AUTO',
          open_time BIGINT,
          close_time BIGINT,
          raw_data JSONB,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);`);

      // 2. Таблица базы знаний (knowledge_rules)
      await client.query(`
        CREATE TABLE IF NOT EXISTS knowledge_rules (
          id VARCHAR(128) PRIMARY KEY,
          title TEXT NOT NULL,
          category VARCHAR(64) DEFAULT 'GENERAL',
          rule_text TEXT,
          confidence_score NUMERIC(5, 2) DEFAULT 80,
          win_rate NUMERIC(5, 2) DEFAULT 0,
          total_trades INT DEFAULT 0,
          is_archived BOOLEAN DEFAULT FALSE,
          archival_reason TEXT,
          market_regime VARCHAR(64),
          raw_data JSONB,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_knowledge_archived ON knowledge_rules(is_archived);`);

      // 3. Таблица системных настроек (system_settings)
      await client.query(`
        CREATE TABLE IF NOT EXISTS system_settings (
          key VARCHAR(64) PRIMARY KEY,
          value_json JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query('COMMIT');
      isInitialized = true;
      console.log('[POSTGRES DB] 🐘 Schema initialized successfully!');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[POSTGRES DB] Error initializing schema:', err);
      return false;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POSTGRES DB] Connection error during init:', err);
    return false;
  }
}

/**
 * Синхронизация списка сделок в PostgreSQL (Upsert)
 */
export async function syncTradesToPg(trades: any[]): Promise<number> {
  const p = getPgPool();
  if (!p || !Array.isArray(trades) || trades.length === 0) return 0;

  if (!isInitialized) {
    const ok = await initPostgresSchema();
    if (!ok) return 0;
  }

  let successCount = 0;
  try {
    const client = await p.connect();
    try {
      await client.query('BEGIN');

      const queryText = `
        INSERT INTO trades (
          id, symbol, exchange, side, status, entry_price, close_price,
          amount, leverage, pnl, pnl_percent, signal_ai_score, is_real, mode,
          open_time, close_time, raw_data, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, CURRENT_TIMESTAMP
        )
        ON CONFLICT (id) DO UPDATE SET
          symbol = EXCLUDED.symbol,
          exchange = EXCLUDED.exchange,
          side = EXCLUDED.side,
          status = EXCLUDED.status,
          entry_price = EXCLUDED.entry_price,
          close_price = EXCLUDED.close_price,
          amount = EXCLUDED.amount,
          leverage = EXCLUDED.leverage,
          pnl = EXCLUDED.pnl,
          pnl_percent = EXCLUDED.pnl_percent,
          signal_ai_score = EXCLUDED.signal_ai_score,
          is_real = EXCLUDED.is_real,
          mode = EXCLUDED.mode,
          open_time = EXCLUDED.open_time,
          close_time = EXCLUDED.close_time,
          raw_data = EXCLUDED.raw_data,
          updated_at = CURRENT_TIMESTAMP;
      `;

      for (const t of trades) {
        if (!t.id) continue;
        await client.query(queryText, [
          String(t.id),
          t.symbol || 'UNKNOWN',
          t.exchange || 'bybit',
          t.side || 'SHORT',
          t.status || 'OPEN',
          t.entryPrice ?? null,
          t.closePrice ?? null,
          t.amount ?? null,
          t.leverage ?? null,
          t.pnl ?? null,
          t.pnlPercent ?? null,
          t.signalAiScore ?? null,
          Boolean(t.isReal),
          t.mode || 'AUTO',
          t.openTime ? Number(t.openTime) : Date.now(),
          t.closeTime ? Number(t.closeTime) : null,
          JSON.stringify(t)
        ]);
        successCount++;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[POSTGRES DB] Error batch upserting trades:', err);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POSTGRES DB] Connection error during trade sync:', err);
  }

  return successCount;
}

/**
 * Синхронизация правил базы знаний в PostgreSQL
 */
export async function syncKnowledgeToPg(rules: any[]): Promise<number> {
  const p = getPgPool();
  if (!p || !Array.isArray(rules) || rules.length === 0) return 0;

  if (!isInitialized) {
    const ok = await initPostgresSchema();
    if (!ok) return 0;
  }

  let successCount = 0;
  try {
    const client = await p.connect();
    try {
      await client.query('BEGIN');

      const queryText = `
        INSERT INTO knowledge_rules (
          id, title, category, rule_text, confidence_score, win_rate,
          total_trades, is_archived, archival_reason, market_regime, raw_data, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, CURRENT_TIMESTAMP
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          category = EXCLUDED.category,
          rule_text = EXCLUDED.rule_text,
          confidence_score = EXCLUDED.confidence_score,
          win_rate = EXCLUDED.win_rate,
          total_trades = EXCLUDED.total_trades,
          is_archived = EXCLUDED.is_archived,
          archival_reason = EXCLUDED.archival_reason,
          market_regime = EXCLUDED.market_regime,
          raw_data = EXCLUDED.raw_data,
          updated_at = CURRENT_TIMESTAMP;
      `;

      for (const r of rules) {
        if (!r.id) continue;
        await client.query(queryText, [
          String(r.id),
          r.title || r.id,
          r.category || 'GENERAL',
          r.ruleText || r.rule || '',
          r.confidenceScore ?? 80,
          r.winRate ?? 0,
          r.totalTrades ?? 0,
          Boolean(r.isArchived),
          r.archivalReason || null,
          r.marketRegime || null,
          JSON.stringify(r)
        ]);
        successCount++;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[POSTGRES DB] Error batch upserting knowledge:', err);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POSTGRES DB] Connection error during knowledge sync:', err);
  }

  return successCount;
}

/**
 * Загрузка всех данных из PostgreSQL при старте
 */
export async function loadAllFromPg(): Promise<{ trades: any[]; knowledge: any[]; settings: any } | null> {
  const p = getPgPool();
  if (!p) return null;

  if (!isInitialized) {
    const ok = await initPostgresSchema();
    if (!ok) return null;
  }

  try {
    const client = await p.connect();
    try {
      const tradesRes = await client.query(`SELECT raw_data FROM trades ORDER BY open_time ASC;`);
      const trades = tradesRes.rows.map(row => row.raw_data);

      const kbRes = await client.query(`SELECT raw_data FROM knowledge_rules;`);
      const knowledge = kbRes.rows.map(row => row.raw_data);

      const settingsRes = await client.query(`SELECT key, value_json FROM system_settings;`);
      const settings: any = {};
      for (const row of settingsRes.rows) {
        settings[row.key] = row.value_json;
      }

      console.log(`[POSTGRES DB] 📥 Loaded ${trades.length} trades, ${knowledge.length} knowledge rules from PostgreSQL.`);
      return { trades, knowledge, settings };
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POSTGRES DB] Failed to load data from PostgreSQL:', err);
    return null;
  }
}
