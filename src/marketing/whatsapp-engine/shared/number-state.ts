export enum NumberConnectionState {
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  RECONNECT_REQUIRED = 'RECONNECT_REQUIRED',
}

export function resolveNumberConnectionState(input: {
  waState?: string | null;
  effectiveState?: string | null;
  connected?: boolean | null;
  browserConnected?: boolean | null;
  clientExists?: boolean | null;
}): NumberConnectionState {
  if (input.connected === true || input.effectiveState === 'ready' || input.waState === 'ready') {
    return NumberConnectionState.CONNECTED;
  }

  if (
    input.waState === 'awaiting_manual_reconnect' ||
    input.waState === 'awaiting_scan' ||
    input.waState === 'authenticating' ||
    input.waState === 'initializing' ||
    input.waState === 'failed'
  ) {
    return NumberConnectionState.RECONNECT_REQUIRED;
  }

  return NumberConnectionState.DISCONNECTED;
}
