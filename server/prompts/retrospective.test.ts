import { describe, it, expect } from 'vitest';
import { getRetrospectivePrompt } from './retrospective.ts';

describe('getRetrospectivePrompt', () => {
  it('actually interpolates all 13 parameters with unique markers', () => {
    const result = getRetrospectivePrompt(
      'UNIQUE_PREV_REPORTS_01',
      111, 'UNIQUE_DAY_WR_02', 'UNIQUE_DAY_PNL_03',
      222, 'UNIQUE_WEEK_WR_04', 'UNIQUE_WEEK_PNL_05',
      333, 'UNIQUE_MONTH_WR_06', 'UNIQUE_MONTH_PNL_07',
      'UNIQUE_LAST_TRADES_08',
      444, 'UNIQUE_ACTIVE_RULES_09'
    );
    expect(result).toContain('UNIQUE_PREV_REPORTS_01');
    expect(result).toContain('111');
    expect(result).toContain('UNIQUE_DAY_WR_02');
    expect(result).toContain('UNIQUE_DAY_PNL_03');
    expect(result).toContain('222');
    expect(result).toContain('UNIQUE_WEEK_WR_04');
    expect(result).toContain('UNIQUE_WEEK_PNL_05');
    expect(result).toContain('333');
    expect(result).toContain('UNIQUE_MONTH_WR_06');
    expect(result).toContain('UNIQUE_MONTH_PNL_07');
    expect(result).toContain('UNIQUE_LAST_TRADES_08');
    expect(result).toContain('444');
    expect(result).toContain('UNIQUE_ACTIVE_RULES_09');

    // Литеральный $ перед суммами должен сохраниться
    expect(result).toContain('$UNIQUE_DAY_PNL_03');
    expect(result).toContain('$UNIQUE_WEEK_PNL_05');
    expect(result).toContain('$UNIQUE_MONTH_PNL_07');

    // Никаких неразвёрнутых плейсхолдеров
    expect(result).not.toContain('${previousReports}');
    expect(result).not.toContain('${statsDay');
    expect(result).not.toContain('${statsWeek');
    expect(result).not.toContain('${statsMonth');
    expect(result).not.toContain('${lastTradesSample}');
    expect(result).not.toContain('${activeRules');
  });
});
