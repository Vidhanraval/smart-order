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

export interface WhatsAppInteractiveButtons {
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

function formatItemLine(item: OrderItem, index: number, showStatus = false, showPrice = true): string {
  const qty = item.quantity > 1 ? `${item.quantity}x ` : '';
  const price = item.estimatedPrice != null ? `₹${item.estimatedPrice}` : '—';

  let line = `${index}. ${qty}${item.name} — ${item.unit ?? 'pcs'}`;
  if (showPrice) line += ` @ ${price}`;

  if (showStatus) {
    if (item.status === 'FOUND' || item.status === 'REPLACEMENT_ACCEPTED') {
      line += ' ✅';
    } else if (item.status === 'NOT_FOUND' || item.status === 'REPLACEMENT_SUGGESTED') {
      line += ' ❌';
      if (item.replacementName) {
        line += `\n   ⚠ Not available → ${item.replacementName}`;
        if (item.replacementPrice != null && showPrice) {
          line += ` @ ₹${item.replacementPrice}`;
        }
      }
    } else {
      line += ' ⏳';
    }
  }

  return line;
}

function formatItemsList(items: OrderItem[], showStatus = false, showPrice = true): string {
  return items.map((item, i) => formatItemLine(item, i + 1, showStatus, showPrice)).join('\n');
}

// ── Order review (after AI parse) ──────────────────────────────────

export function buildOrderReviewList(orderId: string, items: OrderItem[], showPrice = true): WhatsAppInteractiveList {
  return {
    type: 'list',
    header: { type: 'text', text: 'Your Order' },
    body: {
      text: `Here's what we parsed:\n\n${formatItemsList(items, false, showPrice)}\n\nTap an item to edit or confirm:`,
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
              description: showPrice
                ? `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}`
                : `${item.quantity} ${item.unit}`,
            })),
            {
              id: `confirm_${orderId}`,
              title: '✅ Confirm Order',
              description: showPrice ? 'Confirm & start packing' : 'Submit your order to the shop',
            },
          ],
        },
      ],
    },
  };
}

// ── Order item options (buyer taps an item in review) ──────────────────

export function buildOrderItemOptions(item: OrderItem, showPrice = true): WhatsAppInteractiveButtons {
  return {
    type: 'button',
    header: { type: 'text', text: item.name },
    body: {
      text: showPrice
        ? `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}`
        : `${item.quantity} ${item.unit}`,
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: `qty_${item.id}`, title: '🔢 Qty' } },
        { type: 'reply', reply: { id: `delete_${item.id}`, title: '🗑 Delete' } },
        { type: 'reply', reply: { id: `editdetail_${item.id}`, title: '✏️ Edit' } },
      ],
    },
  };
}

// ── Delete confirmation ──────────────────────────────────────────────

export function buildDeleteConfirm(item: OrderItem): WhatsAppInteractiveButtons {
  return {
    type: 'button',
    header: { type: 'text', text: `🗑 Delete?` },
    body: {
      text: `${item.quantity}x ${item.name}\n\nAre you sure you want to remove this item?`,
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: `confirmdelete_${item.id}`, title: '✅ Yes, Delete' } },
        { type: 'reply', reply: { id: `canceldelete_${item.id}`, title: '❌ Cancel' } },
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
      text: `The seller has reviewed your order:\n\n${formatItemsList(displayItems, true, false)}\n\nAccept the replacement or skip this item.`,
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

// ── Packing slip ───────────────────────────────────────────────────

export function buildPackingSlip(orderId: string, items: OrderItem[]): WhatsAppInteractiveList {
  const pendingItems = items.filter(
    (i) => i.status === 'PENDING' || i.status === 'REPLACEMENT_ACCEPTED',
  );
  const foundItems = items.filter((i) => i.status === 'FOUND');
  const notFoundItems = items.filter(
    (i) => i.status === 'NOT_FOUND' || i.status === 'REPLACEMENT_SUGGESTED',
  );

  let statusText = '';
  if (foundItems.length > 0) statusText += `✅ Found: ${foundItems.map((i) => i.name).join(', ')}\n`;
  if (notFoundItems.length > 0) {
    statusText += `❌ Missing:\n`;
    for (const i of notFoundItems) {
      statusText += `   ${i.name}`;
      if (i.replacementName) statusText += ` → ${i.replacementName} @ ₹${i.replacementPrice ?? '?'}`;
      statusText += '\n';
    }
  }
  if (pendingItems.length > 0) statusText += `\n📋 Full order:\n${formatItemsList(items, true)}\n`;

  const rows = pendingItems.map((item) => ({
    id: `pack_${item.id}`,
    title: item.name,
    description: `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}`,
  }));
  rows.push({
    id: `finalize_${orderId}`,
    title: '📦 Finish Packing',
    description: 'All done — notify buyer',
  });

  return {
    type: 'list',
    header: { type: 'text', text: '🛒 Packing Slip' },
    body: { text: statusText || `${pendingItems.length} items pending` },
    footer: { text: 'Tap item for options' },
    action: {
      button: 'Pack Items',
      sections: [{ title: 'Items', rows }],
    },
  };
}

// ── Pack item prompt (per-item found/not-found) ─────────────────────

export function buildPackItemPrompt(item: OrderItem): WhatsAppInteractiveButtons {
  return {
    type: 'button',
    header: { type: 'text', text: item.name },
    body: {
      text: `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}`,
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: `found_${item.id}`, title: '✅ Found' } },
        { type: 'reply', reply: { id: `notfound_${item.id}`, title: '❌ Not Found' } },
        { type: 'reply', reply: { id: `edititem_${item.id}`, title: '✏️ Edit' } },
      ],
    },
  };
}

// ── Inline packing slip (per-item button messages) ──────────────────────
// Each pending item gets its OWN button message — Found/Not Found/Edit
// buttons appear directly below the item. No sub-menu, one-tap action.
// All item messages sandwich between a header text and a Finalize button.

export interface InlinePackingMessages {
  /** Text header summarising found/missing items */
  header: string;
  /** Per-item button messages for each pending item */
  itemMessages: Array<{
    itemId: string;
    message: WhatsAppInteractiveButtons;
  }>;
  /** Finalize button message */
  finalizeMessage: WhatsAppInteractiveButtons;
  /** Whether there are any pending items left */
  hasPending: boolean;
}

export function buildInlinePacking(orderId: string, items: OrderItem[]): InlinePackingMessages {
  const pendingItems = items.filter(
    (i) => i.status === 'PENDING' || i.status === 'REPLACEMENT_ACCEPTED',
  );
  const foundItems = items.filter((i) => i.status === 'FOUND');
  const notFoundItems = items.filter(
    (i) => i.status === 'NOT_FOUND' || i.status === 'REPLACEMENT_SUGGESTED',
  );

  // Build header text
  let header = '🛒 *Packing Slip*\n\n';
  if (foundItems.length > 0) {
    header += `✅ Found: ${foundItems.map((i) => i.name).join(', ')}\n`;
  }
  if (notFoundItems.length > 0) {
    header += `❌ Missing:\n`;
    for (const i of notFoundItems) {
      header += `   ${i.name}`;
      if (i.replacementName) header += ` → ${i.replacementName} @ ₹${i.replacementPrice ?? '?'}`;
      header += '\n';
    }
  }
  if (pendingItems.length > 0) {
    header += `\n📋 *Pending (${pendingItems.length})* — tap buttons below:\n`;
  } else {
    header += '\n✅ All items handled!';
  }

  // Per-item button messages (each with Found/Not Found/Edit)
  const itemMessages = pendingItems.map((item) => ({
    itemId: item.id,
    message: buildPackItemPrompt(item),
  }));

  // Finalize button
  const finalizeMessage: WhatsAppInteractiveButtons = {
    type: 'button',
    header: { type: 'text', text: '📦 Finish Packing' },
    body: {
      text: pendingItems.length > 0
        ? `${pendingItems.length} item(s) still pending. Finalize anyway?`
        : 'All items handled! Ready to finalize?',
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: `finalize_${orderId}`, title: '✅ Finalize' } },
      ],
    },
  };

  return { header, itemMessages, finalizeMessage, hasPending: pendingItems.length > 0 };
}

// ── Inline seller edit (list with 4 options: Price, Rename, Both, Done) ──

export function buildInlineEditOptions(item: OrderItem): WhatsAppInteractiveList {
  return {
    type: 'list',
    header: { type: 'text', text: `✏️ Edit: ${item.name}` },
    body: {
      text: `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}\n\nChoose an option:`,
    },
    footer: { text: 'SmartOrder' },
    action: {
      button: 'Edit Options',
      sections: [
        {
          title: 'Edit Item',
          rows: [
            {
              id: `setprice_${item.id}`,
              title: '💰 Change Price',
              description: `Current: ₹${item.estimatedPrice ?? '?'}`,
            },
            {
              id: `setname_${item.id}`,
              title: '📝 Rename',
              description: `Current: ${item.name}`,
            },
            {
              id: `both_${item.id}`,
              title: '✏️ Both (Price + Name)',
              description: 'Edit both together in one reply',
            },
          ],
        },
      ],
    },
  };
}

// ── Common price picker (list) ──────────────────────────────────────

export function buildPricePicker(item: OrderItem): WhatsAppInteractiveList {
  const prices = [10, 20, 30, 40, 50, 60, 80, 100, 150, 200, 250, 300, 500];
  return {
    type: 'list',
    header: { type: 'text', text: `💰 Price: ${item.name}` },
    body: {
      text: `Current: ₹${item.estimatedPrice ?? '?'}\nPick a price or type your own:`,
    },
    action: {
      button: 'Select Price',
      sections: [
        {
          title: 'Common Prices',
          rows: prices.map((p) => ({
            id: `price_${item.id}_${p}`,
            title: `₹${p}`,
            description: `Set price to ₹${p}`,
          })),
        },
        {
          title: 'Other',
          rows: [
            {
              id: `pricecustom_${item.id}`,
              title: '✏️ Custom Price',
              description: 'Type your own price',
            },
          ],
        },
      ],
    },
  };
}

// ── Buyer quantity picker (list 1–10) ──────────────────────────────

export function buildBuyerQtyPicker(item: OrderItem): WhatsAppInteractiveList {
  const currentQty = item.quantity;
  const qtys = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  return {
    type: 'list',
    header: { type: 'text', text: `🔢 Qty: ${item.name}` },
    body: {
      text: `Current: ${currentQty} ${item.unit ?? 'pcs'}\nPick a new quantity:`,
    },
    footer: { text: 'SmartOrder' },
    action: {
      button: 'Select Qty',
      sections: [
        {
          title: 'Quantity',
          rows: qtys.map((q) => ({
            id: `buyerqty_${item.id}_${q}`,
            title: `${q} ${item.unit ?? 'pcs'}`,
            description: q === currentQty ? '← current' : `Set quantity to ${q}`,
          })),
        },
      ],
    },
  };
}

// ── Buyer price confirmation (seller sends after setting prices) ────

export function buildPriceConfirmation(orderId: string, items: OrderItem[]): WhatsAppInteractiveList {
  const total = items.reduce((sum, i) => sum + (i.estimatedPrice ?? 0) * i.quantity, 0);

  return {
    type: 'list',
    header: { type: 'text', text: '💰 Price Confirmation' },
    body: {
      text: `The shop has set prices:\n\n${formatItemsList(items, false, true)}\n\n💰 *Total: ₹${total}*\n\nTap an item to edit or confirm:`,
    },
    footer: { text: 'SmartOrder' },
    action: {
      button: 'Review Prices',
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
              id: `confirmprices_${orderId}`,
              title: '✅ Confirm & Start Packing',
              description: `Total: ₹${total}`,
            },
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
