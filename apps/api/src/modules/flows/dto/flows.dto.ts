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
  orderId?: string; // optional — used to re-create item if missing
  iat: number; // issued-at timestamp (epoch ms)
}
