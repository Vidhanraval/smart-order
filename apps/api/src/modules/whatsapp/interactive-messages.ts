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

export function buildOrderReviewList(orderId: string, items: OrderItem[]): WhatsAppInteractiveList {
  const itemsList = items
    .map(
      (item, i) =>
        `${i + 1}. ${item.name} — ${item.quantity} ${item.unit} @ ₹${item.estimatedPrice ?? '?'}`,
    )
    .join('\n');

  return {
    type: 'list',
    header: { type: 'text', text: 'Your Order' },
    body: {
      text: `Here's what we parsed:\n\n${itemsList}\n\nPlease review and confirm, or tap an item to edit.`,
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
              title: `${item.name}`,
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

export function buildReplacementReview(
  items: OrderItem[],
  notFoundItem: OrderItem,
  replacementName: string,
  replacementPrice: number,
): WhatsAppInteractiveList {
  const itemsList = items
    .map((item) => {
      let emoji = '⏳ ';
      if (item.id === notFoundItem.id) emoji = '❌ ';
      else if (item.status === 'FOUND') emoji = '✅ ';

      let line = `${emoji}${item.name} — ${item.quantity} ${item.unit ?? 'pcs'} @ ₹${item.estimatedPrice ?? '?'}`;
      if (item.id === notFoundItem.id) {
        line += `\n   ↳ Available: ${replacementName} @ ₹${replacementPrice}`;
      }
      return line;
    })
    .join('\n');

  return {
    type: 'list',
    header: { type: 'text', text: 'Item Unavailable' },
    body: {
      text: `"${notFoundItem.name}" is out of stock.\n\n📋 Your Order:\n${itemsList}\n\nAccept the replacement or skip this item.`,
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

export function buildPackingSlip(orderId: string, items: OrderItem[]): WhatsAppInteractiveList {
  const pendingItems = items.filter(
    (i) =>
      i.status === 'PENDING' || i.status === 'REPLACEMENT_ACCEPTED',
  );

  const foundItems = items.filter((i) => i.status === 'FOUND');
  const notFoundItems = items.filter(
    (i) => i.status === 'NOT_FOUND' || i.status === 'REPLACEMENT_SUGGESTED',
  );

  let statusText = '';
  if (foundItems.length > 0) {
    statusText += `✅ Found: ${foundItems.map((i) => i.name).join(', ')}\n`;
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
    statusText += `⏳ Pending: ${pendingItems.map((i) => i.name).join(', ')}\n`;
  }

  const rows = pendingItems.map((item) => ({
    id: `pack_${item.id}`,
    title: item.name,
    description: `${item.quantity} ${item.unit} — ₹${item.estimatedPrice ?? '?'}`,
  }));

  // Add finalize button
  rows.push({
    id: `finalize_${orderId}`,
    title: '📦 Finish Packing',
    description: 'All items packed — ready for pickup',
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
      ],
    },
  };
}

export function buildPickupReady(customerName: string, total: number, items: OrderItem[]): string {
  const itemList = items
    .filter((i) => i.status === 'FOUND' || i.status === 'REPLACEMENT_ACCEPTED')
    .map(
      (i) =>
        `${i.name} — ${i.quantity} ${i.unit} @ ₹${i.actualPrice ?? i.estimatedPrice ?? '?'}`,
    )
    .join('\n');

  return `Hi ${customerName ?? 'there'}! 👋\n\nYour order is ready for pickup! 🛍️\n\n📋 Order Summary:\n${itemList}\n\n💰 Total: ₹${total}\n\nPlease visit the store at your convenience. Thank you for shopping with us!`;
}
