import { runProductionAutoEntryCoordinator, type CoordinatorRunParams, type CoordinatorOptions, type CoordinatorRunResult } from './autoEntryCoordinator.ts';
import { type StrategyMarketInput } from './strategyEngine.ts';
import { type AgentDecisionEnvelope } from './agentEngine.ts';
import { type AutoEntryExecutionPort } from './autoEntryService.ts';
import { AtomicStateStore } from '../atomicDbSaver.ts';
import { type TradeIntent } from '../types/tradeIntent.ts';

export interface ProductionEntryContext {
  store?: AtomicStateStore;
  executionPort?: AutoEntryExecutionPort;
  hunterDecision?: AgentDecisionEnvelope;
  bearDecision?: AgentDecisionEnvelope;
  isCommitteeConsensusEnabled?: boolean;
}

export interface ProductionEntryParams {
  symbol: string;
  marketInput: StrategyMarketInput;
  tradeIntent?: TradeIntent;
  calculatedAmount: number;
  leverage: number;
  currentSig?: any;
  finalAiScore?: number;
  stopLoss?: number;
  takeProfit?: number;
  tpStages?: any[];
  gridOrders?: any[];
  virtualBalance?: number;
  targetIsAutoLearning?: boolean;
  customCorrelationContext?: any;
}

/**
 * Production Adapter for Main Thread Virtual Automatic Entry.
 * Builds live parameters, wraps context and invokes runProductionAutoEntryCoordinator.
 */
export async function executeMainVirtualAutoEntry(
  params: ProductionEntryParams,
  context: ProductionEntryContext = {}
): Promise<CoordinatorRunResult> {
  const coordinatorParams: CoordinatorRunParams = {
    symbol: params.symbol,
    isReal: false,
    marketInput: params.marketInput,
    tradeIntent: params.tradeIntent,
    calculatedAmount: params.calculatedAmount,
    leverage: params.leverage,
    currentSig: params.currentSig,
    finalAiScore: params.finalAiScore,
    stopLoss: params.stopLoss,
    takeProfit: params.takeProfit,
    tpStages: params.tpStages,
    gridOrders: params.gridOrders,
    virtualBalance: params.virtualBalance,
    targetIsAutoLearning: params.targetIsAutoLearning,
    customCorrelationContext: params.customCorrelationContext,
    sourcePath: 'MAIN_VIRTUAL'
  };

  const coordinatorOptions: CoordinatorOptions = {
    store: context.store,
    executionPort: context.executionPort,
    hunterDecision: context.hunterDecision,
    bearDecision: context.bearDecision,
    isCommitteeConsensusEnabled: context.isCommitteeConsensusEnabled
  };

  return runProductionAutoEntryCoordinator(coordinatorParams, coordinatorOptions);
}

/**
 * Production Adapter for Main Thread Real Automatic Entry.
 * Builds live parameters, wraps context and invokes runProductionAutoEntryCoordinator.
 */
export async function executeMainRealAutoEntry(
  params: ProductionEntryParams,
  context: ProductionEntryContext = {}
): Promise<CoordinatorRunResult> {
  const coordinatorParams: CoordinatorRunParams = {
    symbol: params.symbol,
    isReal: true,
    marketInput: params.marketInput,
    tradeIntent: params.tradeIntent,
    calculatedAmount: params.calculatedAmount,
    leverage: params.leverage,
    currentSig: params.currentSig,
    finalAiScore: params.finalAiScore,
    stopLoss: params.stopLoss,
    takeProfit: params.takeProfit,
    tpStages: params.tpStages,
    gridOrders: params.gridOrders,
    customCorrelationContext: params.customCorrelationContext,
    sourcePath: 'MAIN_REAL_STUB'
  };

  const coordinatorOptions: CoordinatorOptions = {
    store: context.store,
    executionPort: context.executionPort,
    hunterDecision: context.hunterDecision,
    bearDecision: context.bearDecision,
    isCommitteeConsensusEnabled: context.isCommitteeConsensusEnabled
  };

  return runProductionAutoEntryCoordinator(coordinatorParams, coordinatorOptions);
}

/**
 * Production Adapter for Worker Thread Real Automatic Entry.
 * Invoked in background worker context with full lineage and consensus.
 */
export async function executeWorkerRealAutoEntry(
  params: ProductionEntryParams,
  context: ProductionEntryContext = {}
): Promise<CoordinatorRunResult> {
  const coordinatorParams: CoordinatorRunParams = {
    symbol: params.symbol,
    isReal: true,
    marketInput: params.marketInput,
    tradeIntent: params.tradeIntent,
    calculatedAmount: params.calculatedAmount,
    leverage: params.leverage,
    currentSig: params.currentSig,
    finalAiScore: params.finalAiScore,
    stopLoss: params.stopLoss,
    takeProfit: params.takeProfit,
    tpStages: params.tpStages,
    gridOrders: params.gridOrders,
    customCorrelationContext: params.customCorrelationContext,
    sourcePath: 'WORKER_REAL_STUB'
  };

  const coordinatorOptions: CoordinatorOptions = {
    store: context.store,
    executionPort: context.executionPort,
    hunterDecision: context.hunterDecision,
    bearDecision: context.bearDecision,
    isCommitteeConsensusEnabled: context.isCommitteeConsensusEnabled
  };

  return runProductionAutoEntryCoordinator(coordinatorParams, coordinatorOptions);
}

/**
 * Production Adapter for Worker Thread Virtual Automatic Entry.
 * Invoked in background worker context for live virtual trading.
 */
export async function executeWorkerVirtualAutoEntry(
  params: ProductionEntryParams,
  context: ProductionEntryContext = {}
): Promise<CoordinatorRunResult> {
  const coordinatorParams: CoordinatorRunParams = {
    symbol: params.symbol,
    isReal: false,
    marketInput: params.marketInput,
    tradeIntent: params.tradeIntent,
    calculatedAmount: params.calculatedAmount,
    leverage: params.leverage,
    currentSig: params.currentSig,
    finalAiScore: params.finalAiScore,
    stopLoss: params.stopLoss,
    takeProfit: params.takeProfit,
    tpStages: params.tpStages,
    gridOrders: params.gridOrders,
    virtualBalance: params.virtualBalance,
    targetIsAutoLearning: params.targetIsAutoLearning,
    customCorrelationContext: params.customCorrelationContext,
    sourcePath: 'WORKER_VIRTUAL'
  };

  const coordinatorOptions: CoordinatorOptions = {
    store: context.store,
    executionPort: context.executionPort,
    hunterDecision: context.hunterDecision,
    bearDecision: context.bearDecision,
    isCommitteeConsensusEnabled: context.isCommitteeConsensusEnabled
  };

  return runProductionAutoEntryCoordinator(coordinatorParams, coordinatorOptions);
}

