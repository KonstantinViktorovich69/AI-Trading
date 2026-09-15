export interface StateMessage<T = any> {
  type: 'STATE_UPDATE' | 'STATE_SYNC_REQUEST' | 'STATE_RESET';
  entity: 'trades' | 'tradeHistory' | 'settings' | 'knowledge' | 'committeeHistory';
  revision: number;
  emittedAt: number;
  sender: string;
  payload: T;
}

export interface SyncStateResult<T> {
  accepted: boolean;
  newRevision: number;
  reason?: string;
  updatedState?: T;
}

/**
 * Validates and applies versioned state message from worker/IPC.
 * Enforces monotonic stateRevision tracking to reject stale or out-of-order messages.
 */
export function processIncomingStateMessage<T extends { stateRevision?: number; updatedAt?: number }>(
  currentState: T,
  message: StateMessage<T>
): SyncStateResult<T> {
  if (!message || typeof message !== 'object') {
    return { accepted: false, newRevision: currentState?.stateRevision || 0, reason: 'Invalid message object' };
  }

  const currentRevision = currentState?.stateRevision || 0;
  const currentUpdatedAt = currentState?.updatedAt || 0;

  if (message.type === 'STATE_RESET') {
    return {
      accepted: true,
      newRevision: message.revision,
      updatedState: message.payload
    };
  }

  // Reject out-of-order or stale revisions
  if (message.revision <= currentRevision) {
    return {
      accepted: false,
      newRevision: currentRevision,
      reason: `Out of order state message rejected (incoming rev ${message.revision} <= current rev ${currentRevision})`
    };
  }

  if (message.emittedAt < currentUpdatedAt) {
    return {
      accepted: false,
      newRevision: currentRevision,
      reason: `Stale timestamp message rejected (incoming ts ${message.emittedAt} < current ts ${currentUpdatedAt})`
    };
  }

  const updatedState: T = {
    ...message.payload,
    stateRevision: message.revision,
    updatedAt: message.emittedAt
  };

  return {
    accepted: true,
    newRevision: message.revision,
    updatedState
  };
}
