import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trainQuantModel, type QuantModelTrainerContext, type QuantModelStatus, type QuantModelWeights } from './quantModelTrainer.ts';

describe('quantModelTrainer', () => {
  let modelStatus: QuantModelStatus;
  let modelWeights: QuantModelWeights;
  let virtualTrades: any[];
  let aiKnowledgeBase: any[];
  let saveKnowledgeDBSpy: any;
  let saveSettingsSpy: any;

  beforeEach(() => {
    modelStatus = {
      isTrainingActive: false,
      lastRetrained: 0,
      totalLearnedTrades: 0
    };
    modelWeights = {
      beta0: 0.1, beta1: 0.2, beta2: -0.1, beta3: 0.05,
      beta4: 0.1, beta5: -0.05, beta6: 0.3, beta7: 0.1,
      beta8: 0.0, beta9: 0.0, beta10: 0.0, beta11: 0.0
    };
    virtualTrades = [];
    aiKnowledgeBase = [];
    saveKnowledgeDBSpy = vi.fn().mockResolvedValue(undefined);
    saveSettingsSpy = vi.fn();
  });

  const getContext = (): QuantModelTrainerContext => ({
    getModelStatus: () => modelStatus,
    getModelWeights: () => modelWeights,
    setModelWeights: (w) => { modelWeights = w; },
    getVirtualTrades: () => virtualTrades,
    getAiKnowledgeBase: () => aiKnowledgeBase,
    saveKnowledgeDB: saveKnowledgeDBSpy,
    saveSettings: saveSettingsSpy,
    deadZonePct: 0.05
  });

  it('skips retraining when closed trades count is less than 30', async () => {
    for (let i = 0; i < 20; i++) {
      virtualTrades.push({
        id: `t_${i}`,
        status: 'CLOSED',
        features: [0.1, 20, 0.5, 2.0, 0, 0, 0.6, 0, 0, 0, 0],
        outcome: i % 2 === 0 ? 1 : 0,
        pnlPercent: i % 2 === 0 ? 3.5 : -2.0
      });
    }

    await trainQuantModel(getContext());

    expect(modelStatus.isTrainingActive).toBe(false);
    expect(saveSettingsSpy).not.toHaveBeenCalled();
  });

  it('performs model retraining and updates model weights with sufficient trades', async () => {
    for (let i = 0; i < 40; i++) {
      virtualTrades.push({
        id: `t_${i}`,
        status: 'CLOSED',
        features: [0.1, 25, 0.5, 5.0, 0, 0, 0.7, 0, 0, 0, 0],
        outcome: i % 3 !== 0 ? 1 : 0,
        pnlPercent: i % 3 !== 0 ? 4.5 : -2.5
      });
    }

    await trainQuantModel(getContext());

    expect(modelStatus.isTrainingActive).toBe(false);
    expect(modelStatus.lastRetrained).toBeGreaterThan(0);
    expect(modelStatus.totalLearnedTrades).toBe(40);
    expect(saveSettingsSpy).toHaveBeenCalled();
  });

  it('synthesizes autonomous knowledge rules when profitable trades count exceeds threshold', async () => {
    // Generate 35 profitable trades with high RSI (>70), high imbalance (>55%), high EMA dist (>4)
    for (let i = 0; i < 35; i++) {
      virtualTrades.push({
        id: `t_${i}`,
        status: 'CLOSED',
        features: [0.1, 25, 0.5, 6.0, 0, 0, 0.65, 0, 0, 0, 0], // features[1] = 25 -> RSI = 75 (>70)
        outcome: 1,
        pnlPercent: 5.0
      });
    }

    await trainQuantModel(getContext());

    expect(aiKnowledgeBase.length).toBeGreaterThan(0);
    expect(saveKnowledgeDBSpy).toHaveBeenCalled();
  });
});
