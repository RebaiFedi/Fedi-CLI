let currentFlowId: string | null = null;

/** Get the current flow ID, or null if none active */
export function getFlowId(): string | null {
  return currentFlowId;
}

/** Set the current flow ID for log correlation */
export function setFlowId(id: string | null): void {
  currentFlowId = id;
}
