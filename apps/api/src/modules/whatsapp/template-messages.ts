// ── WhatsApp Template Message Builders ─────────────────────────

/**
 * Template message payload for WhatsApp Cloud API.
 * These templates must be created & approved in Meta Business Manager first.
 *
 * CREATE TEMPLATES IN META:
 * 1. Go to: https://business.facebook.com/settings/whatsapp-message-templates/
 * 2. Click "Create Template"
 * 3. Choose category: "Transactional" or "Marketing"
 * 4. Copy the template structure from this file
 * 5. Submit for approval (usually 24-48 hours)
 */

export interface TemplateMessagePayload {
  name: string;
  language: { code: string };
  components?: TemplateComponent[];
}

export interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  parameters?: TemplateParameter[];
  sub_type?: 'quick_reply' | 'url';
  index?: string;
}

export interface TemplateParameter {
  type: 'text' | 'currency' | 'date_time' | 'image' | 'document' | 'video';
  text?: string;
  currency?: { fallback_value: string; code: string; amount_1000: number };
  date_time?: { fallback_value: string };
  image?: { id: string };
  document?: { id: string; filename?: string };
  video?: { id: string };
}

// ── Template Definitions (for Meta submission) ──────────────────

/**
 * TEMPLATE #1: Order Confirmed
 *
 * Category: TRANSACTIONAL
 * Name: smartorder_order_confirmed
 *
 * Structure:
 * ┌──────────────────────────────┐
 * │ HEADER (text): "Order Confirmed ✅"  │
 * │                              │
 * │ BODY:                        │
 * │  Your order {{1}} has been   │
 * │  confirmed!                  │
 * │                              │
 * │  Items: {{2}}                │
 * │  Total: {{3}}                │
 * │                              │
 * │  The shop will review and    │
 * │  send you a price update.    │
 * │                              │
 * └──────────────────────────────┘
 */
export function buildOrderConfirmedTemplate(
  orderId: string,
  itemsSummary: string,
  total: string,
): TemplateMessagePayload {
  return {
    name: 'smartorder_order_confirmed',
    language: { code: 'en' },
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: orderId },
          { type: 'text', text: itemsSummary },
          { type: 'text', text: total },
        ],
      },
    ],
  };
}

/**
 * TEMPLATE #2: Order Ready for Pickup
 *
 * Category: TRANSACTIONAL
 * Name: smartorder_order_ready
 *
 * Structure:
 * ┌──────────────────────────────┐
 * │ HEADER (text): "Ready for Pickup 📦" │
 * │                              │
 * │ BODY:                        │
 * │  Your order {{1}} is ready   │
 * │  for pickup!                 │
 * │                              │
 * │  Items: {{2}}                │
 * │  Total: {{3}}                │
 * │                              │
 * │  Please visit {{4}} to       │
 * │  collect your items.         │
 * │                              │
 * │ FOOTER: "SmartOrder"        │
 * └──────────────────────────────┘
 */
export function buildOrderReadyTemplate(
  orderId: string,
  itemsSummary: string,
  total: string,
  storeName: string,
): TemplateMessagePayload {
  return {
    name: 'smartorder_order_ready',
    language: { code: 'en' },
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: orderId },
          { type: 'text', text: itemsSummary },
          { type: 'text', text: total },
          { type: 'text', text: storeName },
        ],
      },
    ],
  };
}

/**
 * TEMPLATE #3: Order Status Update
 *
 * Category: TRANSACTIONAL
 * Name: smartorder_order_update
 *
 * Structure:
 * ┌──────────────────────────────┐
 * │ HEADER (text): "Order Update 📋" │
 * │                              │
 * │ BODY:                        │
 * │  Order {{1}}: {{2}}          │
 * │                              │
 * │  Status: {{3}}               │
 * │                              │
 * │  {{4}}                       │
 * │                              │
 * └──────────────────────────────┘
 */
export function buildOrderUpdateTemplate(
  orderId: string,
  itemsSummary: string,
  status: string,
  message: string,
): TemplateMessagePayload {
  return {
    name: 'smartorder_order_update',
    language: { code: 'en' },
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: orderId },
          { type: 'text', text: itemsSummary },
          { type: 'text', text: status },
          { type: 'text', text: message },
        ],
      },
    ],
  };
}

// ── Template helpers ────────────────────────────────────────────

export function formatItemsSummary(
  items: Array<{ name: string; quantity: number }>,
  maxLen = 80,
): string {
  const summary = items
    .map((i) => `${i.quantity}x ${i.name}`)
    .join(', ');
  return summary.length > maxLen ? summary.slice(0, maxLen - 3) + '...' : summary;
}

export function formatOrderId(id: string): string {
  return `#${id.slice(0, 8).toUpperCase()}`;
}
