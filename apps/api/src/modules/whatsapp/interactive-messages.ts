import { OrderItem } from '@prisma/client';

interface WhatsAppInteractiveList {
  type: 'list';
  header?: { type: 'text'; text: string };
  body: { text: string };
  footer?: { text: string };
  action: {
    button: string;
    sections: Array<{
      title?: string;
      rows: Array<{
        id: string;
        title: string;
        description?: string;
      }>;
    }>;
  };
}

interface WhatsAppInteractiveButtons {
  type: 'button';
  header?: { type: 'text'; text: string };
  body: { text: string };
  footer?: { text: string };
  action: {
    buttons: Array<{
      type: 'reply';
      reply: { id: string; title: string };
    }>;
  };
}

// ── Shared item list formatter ─────────────────────────────────────

function formatItemLine(item: OrderItem, index: number, showStatus = false): string {
  const qty = item.quantity > 1 ? `${item.quantity}x ` : '';
  const price = item.estimatedPrice != null ? `₹${item.estimatedPrice}` : '—';

  let line = `${index}. ${qty}${item.name} — ${item.unit ?? 'pcs'} @ ${price}`;

  if (showStatus) {
    if (item.status === 'FOUND' || item.status === 'REPLACEMENT_ACCEPTED') {
      line += ' ✅';
    } else if (item.status === 'NOT_FOUND' || item.status === 'REPLACEMENT_SUGGESTED') {
      line += ' ❌';
      if (item.replacementName) {
        line += `\n   ⚠ Not available → ${item.replacementName}`;
        if (item.replacementPrice != null) {
          line += ` @ ₹${item.replacementPrice}`;
        }
      }
    } else {
      line += ' ⏳';
    }
  }

  return line;
}

function formatItemsList(items: OrderItem[], showStatus = false): string {
  return items.map((item, i) => formatItemLine(item, i + 1, showStatus)).join('\n');
}

// ── Order review (after AI parse) ──────────────────────────────────

export function buildOrderReviewList(orderId: string, items: OrderItem[]): WhatsAppInteractiveList {
  return {
    type: 'list',
    header: { type: 'text', text: 'Your Order' },
    body: {
      text: `Here's what we parsed:\n\n${formatItemsList(items)}\n\nTap an item to edit or confirm:`,
    },
    footer: { text: 'SmartOrder — Your Local Shop' },
    action: {
      button: 'Review Order',
      sections: [
        {
          title: 'Items',
          rows: [
            ...items.map((item) => ({
              id: `edit_${item.id}`,
              title: item.name,
              description: `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}`,
            })),
            {
              id: `confirm_${orderId}`,
              title: '✅ Confirm Order',
              description: 'Submit your order to the shop',
            },
          ],
        },
      ],
    },
  };
}

// ── Replacement review (buyer sees after seller suggests replacements) ──

export function buildReplacementReview(
  items: OrderItem[],
  notFoundItem: OrderItem,
  replacementName: string,
  replacementPrice: number,
): WhatsAppInteractiveList {
  // Temporarily set replacement on the not-found item for formatting
  const displayItems = items.map((i) =>
    i.id === notFoundItem.id
      ? { ...i, replacementName, replacementPrice, status: 'NOT_FOUND' as const }
      : i,
  );

  return {
    type: 'list',
    header: { type: 'text', text: 'Review & Finalize' },
    body: {
      text: `The seller has reviewed your order:\n\n${formatItemsList(displayItems, true)}\n\nAccept the replacement or skip this item.`,
    },
    footer: { text: 'SmartOrder — Your Local Shop' },
    action: {
      button: 'Options',
      sections: [
        {
          title: 'Actions',
          rows: [
            {
              id: `accept_${notFoundItem.id}`,
              title: `✅ Accept: ${replacementName}`,
              description: `₹${replacementPrice} — replaces "${notFoundItem.name}"`,
            },
            {
              id: `skip_${notFoundItem.id}`,
              title: '⏭ Skip Item',
              description: 'Remove from your order',
            },
          ],
        },
      ],
    },
  };
}

// ── Packing slip (seller view) — with inline edit per item ────────

const QUICK_PRICES = [10, 20, 30, 40, 50, 60, 70, 80, 100, 120, 150, 200];

function priceRowsFor(item: OrderItem): Array<{ id: string; title: string; description?: string }> {
  const current = item.estimatedPrice ?? 50;
  return QUICK_PRICES.filter((p) => Math.abs(p - current) > 5 || p === current)
    .slice(0, 5)
    .map((p) => ({
      id: `price_${item.id}_${p}`,
      title: p === current ? `💰 ₹${p} ✓` : `💰 ₹${p}`,
      description: p === current ? 'Current price' : `Change price to ₹${p}`,
    }));
}

export function buildPackingSlip(orderId: string, items: OrderItem[]): WhatsAppInteractiveList {
  const pendingItems = items.filter(
    (i) => i.status === 'PENDING' || i.status === 'REPLACEMENT_ACCEPTED',
  );

  const foundItems = items.filter((i) => i.status === 'FOUND');
  const notFoundItems = items.filter(
    (i) => i.status === 'NOT_FOUND' || i.status === 'REPLACEMENT_SUGGESTED',
  );

  let statusText = '';
  if (foundItems.length > 0) {
    statusText += `✅ Found (${foundItems.length}): ${foundItems.map((i) => i.name).join(', ')}\n`;
  }
  if (notFoundItems.length > 0) {
    statusText += `❌ Missing:\n`;
    for (const i of notFoundItems) {
      statusText += `   ${i.name}`;
      if (i.replacementName) {
        statusText += ` → ${i.replacementName} @ ₹${i.replacementPrice ?? '?'}`;
      }
      statusText += '\n';
    }
  }

  // Build sections — one per pending item with inline actions
  const sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }> = [];

  for (const item of pendingItems) {
    const priceStr = item.estimatedPrice != null ? `₹${item.estimatedPrice}` : '?';
    sections.push({
      title: `📦 ${item.name} — ${item.quantity} ${item.unit} @ ${priceStr}`,
      rows: [
        { id: `found_${item.id}`, title: '✅ Found', description: 'Mark as available' },
        { id: `notfound_${item.id}`, title: '❌ Not Found', description: 'Suggest replacement' },
        ...priceRowsFor(item),
        { id: `rename_${item.id}`, title: '✏️ Rename', description: 'Change item name' },
      ],
    });
  }

  // Final section: finish packing
  sections.push({
    title: '✅ Ready?',
    rows: [
      { id: `finalize_${orderId}`, title: '📦 Finish Packing', description: 'All done — notify buyer' },
    ],
  });

  return {
    type: 'list',
    header: { type: 'text', text: '🛒 Packing Slip' },
    body: {
      text: statusText || `${pendingItems.length} items pending`,
    },
    footer: { text: 'Tap any option below' },
    action: {
      button: 'Pack Items',
      sections,
    },
  };
}

// ── Pack item prompt (per-item found/not-found) ─────────────────────

export function buildPackItemPrompt(item: OrderItem): WhatsAppInteractiveButtons {
  return {
    type: 'button',
    header: { type: 'text', text: item.name },
    body: {
      text: `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}\n\nIs this item available?`,
    },
    action: {
      buttons: [
        {
          type: 'reply',
          reply: { id: `found_${item.id}`, title: '✅ Found' },
        },
        {
          type: 'reply',
          reply: { id: `notfound_${item.id}`, title: '❌ Not Found' },
        },
        {
          type: 'reply',
          reply: { id: `editprice_${item.id}`, title: '💰 Price' },
        },
      ],
    },
  };
}

// ── Pickup ready receipt ───────────────────────────────────────────

export function buildPickupReady(storeName: string, total: number, items: OrderItem[]): string {
  const activeItems = items.filter((i) => i.status !== 'REPLACEMENT_SKIPPED');

  const itemList = activeItems
    .map((i) => {
      const qty = i.quantity > 1 ? `${i.quantity}x ` : '';
      const price = i.actualPrice ?? i.estimatedPrice ?? 0;
      return `${qty}${i.name} — ₹${price}`;
    })
    .join('\n');

  return `*${storeName}*\n📋 Order Receipt\n\n${itemList}\n\n💰 *Total: ₹${total}*\n\n✅ Ready for Pickup!\nPlease visit the store at your convenience.`;
}
