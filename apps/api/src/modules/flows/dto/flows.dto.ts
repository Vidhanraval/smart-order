// ── Request Meta sends to our data-exchange endpoint ──────────────

export interface FlowDataExchangeRequest {
  action: 'INIT' | 'data_exchange' | 'ping';
  data?: Record<string, unknown>;
  version?: string;
  screen?: string;
  flow_token?: string;
}

// ── Response we return to Meta ────────────────────────────────────

export interface FlowDataExchangeResponse {
  action?: 'INIT' | 'data_exchange' | 'error';
  data?: Record<string, unknown>;
  error?: Record<string, string> | string;
  screen?: string;
  version?: string;
}

// ── Payload inside a completed flow webhook message ────────────────

export interface FlowCompletionPayload {
  id: string; // Flow ID from Meta
  token: string; // Our flow_token
  response: Record<string, string>;
}

// ── Decoded flow_token structure (base64url-encoded JSON) ──────────

export interface FlowTokenPayload {
  v: 1;
  action: 'seller_edit' | 'seller_edit_price_only' | 'seller_rename' | 'buyer_qty';
  itemId: string;
  phone: string;
  iat: number; // issued-at timestamp (epoch ms)
}
