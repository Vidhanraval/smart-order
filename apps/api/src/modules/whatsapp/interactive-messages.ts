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

// ── Order item options (buyer taps an item in review) ──────────────────

export function buildOrderItemOptions(item: OrderItem): WhatsAppInteractiveButtons {
  return {
    type: 'button',
    header: { type: 'text', text: item.name },
    body: {
      text: `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}`,
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
      text: `${item.quantity}x ${item.name} — ₹${item.estimatedPrice ?? '?'}\n\nAre you sure you want to remove this item?`,
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

// ── Action-based packing slip (single list, per-action sections) ────────
// All items in ONE box. Sections organized by ACTION (Found/Not Found/Edit).
// Direct 1-tap — no sub-menu.
// WhatsApp limit: 10 rows total. ≤3 items → all 3 sections fit (9 rows).
// 4-5 items → Found + Not Found sections (≤10 rows), edit via text reply.
// 6+ items → Found section only (≤10 rows), footer explains text commands.

export interface ActionPackingSlip {
  /** The single list message with all items + actions */
  listMessage: WhatsAppInteractiveList;
  /** Text commands hint (for items that couldn't fit all sections) */
  commandHint?: string;
  /** Finalize button message */
  finalizeMessage: WhatsAppInteractiveButtons;
  /** Whether there are any pending items */
  hasPending: boolean;
  /** Items that need text-based edit (couldn't fit Edit section) */
  textEditItems: OrderItem[];
}

export function buildActionPackingSlip(orderId: string, items: OrderItem[]): ActionPackingSlip {
  const pendingItems = items.filter(
    (i) => i.status === 'PENDING' || i.status === 'REPLACEMENT_ACCEPTED',
  );
  const foundItems = items.filter((i) => i.status === 'FOUND');
  const notFoundItems = items.filter(
    (i) => i.status === 'NOT_FOUND' || i.status === 'REPLACEMENT_SUGGESTED',
  );

  // Build header text
  let bodyText = '';
  if (foundItems.length > 0) {
    bodyText += `✅ Found: ${foundItems.map((i) => i.name).join(', ')}\n`;
  }
  if (notFoundItems.length > 0) {
    bodyText += `❌ Missing:\n`;
    for (const i of notFoundItems) {
      bodyText += `   ${i.name}`;
      if (i.replacementName) bodyText += ` → ${i.replacementName} @ ₹${i.replacementPrice ?? '?'}`;
      bodyText += '\n';
    }
  }
  if (pendingItems.length === 0) {
    bodyText += '\n✅ All items handled!';
  } else {
    bodyText += `\n📋 *${pendingItems.length} pending* — tap below:`;
  }

  const sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }> = [];
  let commandHint: string | undefined;
  const textEditItems: OrderItem[] = [];

  const itemCount = pendingItems.length;

  if (itemCount <= 3) {
    // All 3 sections fit: Found, Not Found, Edit (max 9 rows)
    sections.push({
      title: '✅ Found — tap item to mark',
      rows: pendingItems.map((item) => ({
        id: `found_${item.id}`,
        title: `${item.name}`,
        description: `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}`,
      })),
    });
    sections.push({
      title: '❌ Not Found — tap item to mark',
      rows: pendingItems.map((item) => ({
        id: `notfound_${item.id}`,
        title: `${item.name}`,
        description: `Will ask for replacement`,
      })),
    });
    sections.push({
      title: '✏️ Edit — tap item to edit',
      rows: pendingItems.map((item) => ({
        id: `edititem_${item.id}`,
        title: `${item.name}`,
        description: `Change price or rename`,
      })),
    });
  } else if (itemCount <= 5) {
    // 4-5 items: Found + Not Found (max 10 rows), edit via text
    sections.push({
      title: '✅ Found — tap item',
      rows: pendingItems.map((item) => ({
        id: `found_${item.id}`,
        title: `${item.name}`,
        description: `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}`,
      })),
    });
    sections.push({
      title: '❌ Not Found — tap item',
      rows: pendingItems.map((item) => ({
        id: `notfound_${item.id}`,
        title: `${item.name}`,
        description: `Will ask for replacement`,
      })),
    });
    commandHint = '✏️ To edit: reply "edit <item>" (e.g. edit Shampoo)';
    textEditItems.push(...pendingItems);
  } else {
    // 6+ items: Found section only, hint for other actions
    sections.push({
      title: '✅ Found — tap item',
      rows: pendingItems.slice(0, 10).map((item) => ({
        id: `found_${item.id}`,
        title: `${item.name}`,
        description: `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}`,
      })),
    });
    commandHint = '❌ Reply "not <item>" to mark missing\n✏️ Reply "edit <item>" to edit';
    textEditItems.push(...pendingItems);
  }

  const listMessage: WhatsAppInteractiveList = {
    type: 'list',
    header: { type: 'text', text: '🛒 Packing Slip' },
    body: { text: bodyText },
    footer: { text: commandHint || 'Tap item for direct action' },
    action: {
      button: 'Pack Items',
      sections,
    },
  };

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

  return { listMessage, commandHint, finalizeMessage, hasPending: pendingItems.length > 0, textEditItems };
}

// ── Inline seller edit (button-driven price/rename) ─────────────────

export function buildInlineEditOptions(item: OrderItem): WhatsAppInteractiveButtons {
  return {
    type: 'button',
    header: { type: 'text', text: `✏️ Edit: ${item.name}` },
    body: {
      text: `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}`,
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: `setprice_${item.id}`, title: '💰 Price' } },
        { type: 'reply', reply: { id: `setname_${item.id}`, title: '📝 Rename' } },
        { type: 'reply', reply: { id: `editdone_${item.id}`, title: '✅ Done' } },
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
