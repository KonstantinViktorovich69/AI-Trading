import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  trainQuantModel,
  MODEL_WEIGHT_ABS_MAX,
  type QuantModelTrainerContext,
  type QuantModelStatus,
  type QuantModelWeights
} from './quantModelTrainer.ts';

describe('quantModelTrainer D1 & D5 regression: validation loss branching', () => {
  let modelStatus: QuantModelStatus;
  let aiKnowledgeBase: any[];
  let saveKnowledgeDBSpy: any;
  let saveSettingsSpy: any;

  beforeEach(() => {
    modelStatus = {
      isTrainingActive: false,
      lastRetrained: 0,
      totalLearnedTrades: 0
    };
    aiKnowledgeBase = [];
    saveKnowledgeDBSpy = vi.fn().mockResolvedValue(undefined);
    saveSettingsSpy = vi.fn();
  });

  function makeNeutralWeights(overrides: Partial<QuantModelWeights> = {}): QuantModelWeights {
    return {
      beta0: 0,
      beta1: 0,
      beta2: 0,
      beta3: 0,
      beta4: 0,
      beta5: 0,
      beta6: 0,
      beta7: 0,
      beta8: 0,
      beta9: 0,
      beta10: 0,
      beta11: 0,
      ...overrides
    };
  }

  it('calls setModelWeights and updates weights when validation loss improves', async () => {
    let storedWeights = makeNeutralWeights();
    const setModelWeightsSpy = vi.fn((w: QuantModelWeights) => {
      storedWeights = w;
    });

    // Clearly separable dataset: positive features[1] -> outcome 1, negative -> outcome 0
    const virtualTrades = Array.from({ length: 50 }, (_, i) => {
      const win = i % 2 === 0;
      return {
        id: `improve_${i}`,
        status: 'CLOSED',
        side: 'SHORT',
        featuresVersion: 2,
        features: [0.2, win ? 5 : -5, 0, 0, 0, 0, win ? 0.8 : -0.8, 0, 0, 0, 0],
        outcome: win ? 1 : 0,
        pnlPercent: win ? 3.5 : -2.5
      };
    });

    const ctx: QuantModelTrainerContext = {
      getModelStatus: () => modelStatus,
      getModelWeights: () => storedWeights,
      setModelWeights: setModelWeightsSpy,
      getVirtualTrades: () => virtualTrades,
      getAiKnowledgeBase: () => aiKnowledgeBase,
      saveKnowledgeDB: saveKnowledgeDBSpy,
      saveSettings: saveSettingsSpy,
      deadZonePct: 0.05
    };

    await trainQuantModel(ctx);

    expect(setModelWeightsSpy).toHaveBeenCalledTimes(1);
    expect(storedWeights.beta1).toBeGreaterThan(0);
    expect(Math.abs(storedWeights.beta1)).toBeLessThanOrEqual(MODEL_WEIGHT_ABS_MAX);
    expect(saveSettingsSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT call setModelWeights and preserves existing weights when validation loss worsens', async () => {
    const initialWeights = makeNeutralWeights({ beta1: 1.5 });
    let storedWeights = { ...initialWeights };
    const setModelWeightsSpy = vi.fn((w: QuantModelWeights) => {
      storedWeights = w;
    });

    // index % 5 === 0 goes to valData; rest go to trainData.
    // valData aligns strongly with beta1 = 1.5 (features[1] = 8 -> outcome = 1), giving tiny initial valLoss.
    // trainData has flipped outcome = 0 for features[1] = 8, so gradient descent pushes beta1 down every iteration
    // and strictly increases validation loss above currentValLoss.
    const virtualTrades = Array.from({ length: 50 }, (_, i) => {
      const isValRow = i % 5 === 0;
      return {
        id: `worsen_${i}`,
        status: 'CLOSED',
        side: 'SHORT',
        featuresVersion: 2,
        features: [0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        outcome: isValRow ? 1 : 0,
        pnlPercent: isValRow ? 2.5 : -2.5
      };
    });

    const ctx: QuantModelTrainerContext = {
      getModelStatus: () => modelStatus,
      getModelWeights: () => storedWeights,
      setModelWeights: setModelWeightsSpy,
      getVirtualTrades: () => virtualTrades,
      getAiKnowledgeBase: () => aiKnowledgeBase,
      saveKnowledgeDB: saveKnowledgeDBSpy,
      saveSettings: saveSettingsSpy,
      deadZonePct: 0.05
    };

    await trainQuantModel(ctx);

    expect(setModelWeightsSpy).not.toHaveBeenCalled();
    expect(storedWeights).toEqual(initialWeights);
  });
});
