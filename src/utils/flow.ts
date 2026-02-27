import { randomUUID } from 'node:crypto';

let currentFlowId: string | null = null;

/** Start a new flow — returns a unique flow ID for correlation */
export function startFlow(): string {
  currentFlowId = randomUUID().slice(0, 8);
  return currentFlowId;
}

/** Get the current flow ID, or null if none active */
export function getFlowId(): string | null {
  return currentFlowId;
}

/** End the current flow */
export function endFlow(): void {
  currentFlowId = null;
}
