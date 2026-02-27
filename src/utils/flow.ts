let currentFlowId: string | null = null;

/** Get the current flow ID, or null if none active */
export function getFlowId(): string | null {
  return currentFlowId;
}

/** Set current flow ID, or clear it by passing null */
export function setFlowId(flowId: string | null): void {
  currentFlowId = flowId;
}
