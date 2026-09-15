import { GoogleGenAI } from '@google/genai';
import { AiGatewayService, aiGatewayService, type PendingAiTask, type PendingWorkerAiTask } from './aiGatewayService.ts';

export type { PendingAiTask, PendingWorkerAiTask };
export { AiGatewayService, aiGatewayService };

export const pendingAiTasks: Map<string, PendingAiTask> = aiGatewayService.getPendingAiTasks();
export const pendingWorkerAiTasks: Map<string, PendingWorkerAiTask> = aiGatewayService.getPendingWorkerAiTasks();

export function getInternalServerGeminiClient(): GoogleGenAI | null {
  return aiGatewayService.getInternalServerGeminiClient();
}

export function resetInternalServerGeminiClient(): void {
  aiGatewayService.resetInternalServerGeminiClient();
}

export function addAndQueueFrontendTask(params: any, modeReason: string): Promise<any> {
  return aiGatewayService.addAndQueueFrontendTask(params, modeReason);
}

export function getStaticServerSideAiFallback(params: any, errorMsg: string): { text: string } {
  return aiGatewayService.getStaticServerSideAiFallback(params, errorMsg);
}

export async function runAiGeneration(params: any): Promise<any> {
  return aiGatewayService.runAiGeneration(params);
}
