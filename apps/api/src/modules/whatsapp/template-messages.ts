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

// ── Catalog Message Builders ───────────────────────────────────

/**
 * WhatsApp Catalog Product & Product List messages.
 * These are "interactive" type messages (NOT template messages),
 * so they DO NOT need Meta approval. They work immediately once:
 * 1. Catalog is created in Meta Commerce Manager
 * 2. Catalog is connected to the WhatsApp Business Account
 *
 * SETUP:
 * 1. Create catalog: https://business.facebook.com/commerce/catalogs/
 * 2. Add products with unique product_retailer_id
 * 3. Connect catalog to WABA: https://business.facebook.com/settings/whatsapp-business-accounts/
 *    → WhatsApp Account → Settings → Catalog → Select catalog
 */

export interface CatalogProductMessage {
  type: 'product';
  body: { text: string };
  footer?: { text: string };
  action: {
    catalog_id: string;
    product_retailer_id: string;
  };
}

export interface CatalogSection {
  title: string;
  product_items: Array<{ product_retailer_id: string }>;
}

export interface CatalogProductListMessage {
  type: 'product_list';
  header: { type: 'text'; text: string };
  body: { text: string };
  footer?: { text: string };
  action: {
    catalog_id: string;
    sections: CatalogSection[];
  };
}

/**
 * Build a single product catalog message.
 * Shows ONE product with image, price, description from the catalog.
 */
export function buildCatalogSingleProduct(
  catalogId: string,
  productRetailerId: string,
  bodyText: string,
): CatalogProductMessage {
  return {
    type: 'product',
    body: { text: bodyText },
    footer: { text: 'SmartOrder' },
    action: {
      catalog_id: catalogId,
      product_retailer_id: productRetailerId,
    },
  };
}

/**
 * Build a multi-product catalog browse message.
 * Shows up to 30 products organized in sections (max 10 sections).
 */
export function buildCatalogProductList(
  catalogId: string,
  headerText: string,
  bodyText: string,
  sections: CatalogSection[],
): CatalogProductListMessage {
  return {
    type: 'product_list',
    header: { type: 'text', text: headerText },
    body: { text: bodyText },
    footer: { text: 'SmartOrder' },
    action: {
      catalog_id: catalogId,
      sections,
    },
  };
}

/**
 * Build a product browse section from order items.
 * Groups items into sections by category (or all in one section).
 */
export function buildCatalogOrderSection(
  sectionTitle: string,
  productRetailerIds: string[],
): CatalogSection {
  return {
    title: sectionTitle,
    product_items: productRetailerIds.map((id) => ({ product_retailer_id: id })),
  };
}

// Default catalog ID from env config
export const SMARTORDER_CATALOG_ID = '28131434943124434';

