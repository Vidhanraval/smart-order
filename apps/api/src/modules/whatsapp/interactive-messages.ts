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

// ── Packing slip (seller view) ──────────────────────────────────────

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
  if (pendingItems.length > 0) {
    statusText += `\n📋 Full order:\n${formatItemsList(items, true)}\n`;
  }

  const rows = pendingItems.map((item) => ({
    id: `pack_${item.id}`,
    title: item.name,
    description: `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}`,
  }));

  rows.push({
    id: `finalize_${orderId}`,
    title: '📦 Finish Packing',
    description: 'All items packed — send for review',
  });

  return {
    type: 'list',
    header: { type: 'text', text: 'Packing Slip' },
    body: {
      text: statusText || 'No items to pack',
    },
    footer: { text: 'Tap an item to mark it' },
    action: {
      button: 'Pack Items',
      sections: [
        {
          title: 'Pending Items',
          rows,
        },
      ],
    },
  };
}

// ── Pack item prompt (per-item found/not-found) ─────────────────────

export function buildPackItemPrompt(item: OrderItem): WhatsAppInteractiveList {
  const estPrice = item.estimatedPrice ?? 50;
  // Generate price options around the estimated price
  const priceOptions = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 200, 250];
  const nearbyPrices = priceOptions.filter((p) => p !== estPrice).slice(0, 10);

  return {
    type: 'list',
    header: { type: 'text', text: item.name },
    body: {
      text: `${item.quantity} ${item.unit} — ₹${estPrice}\n\nMark status or pick a new price:`,
    },
    action: {
      button: 'Actions',
      sections: [
        {
          title: 'Status',
          rows: [
            { id: `found_${item.id}`, title: '✅ Found', description: 'Item is available' },
            { id: `notfound_${item.id}`, title: '❌ Not Found', description: 'Suggest a replacement' },
          ],
        },
        {
          title: '💰 Change Price',
          rows: nearbyPrices.map((p) => ({
            id: `price_${item.id}_${p}`,
            title: `₹${p}`,
            description: `Set price to ₹${p}`,
          })),
        },
        {
          title: '✏️ Rename',
          rows: [
            { id: `rename_${item.id}`, title: '✏️ Rename Item', description: 'Change item name' },
          ],
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
