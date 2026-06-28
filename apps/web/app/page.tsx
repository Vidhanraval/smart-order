'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchOrders,
  fetchOrder,
  updateItem as apiUpdateItem,
  deleteItem as apiDeleteItem,
  confirmOrder as apiConfirmOrder,
  type Order,
  type OrderItem as ApiOrderItem,
} from './api';

// ── Types ──────────────────────────────────────────────────────────

interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  estimatedPrice?: number | null;
  status: 'pending' | 'found' | 'not_found';
  replacementName?: string;
  replacementPrice?: number;
}

interface ChatMessage {
  id: string;
  sender: 'buyer' | 'seller' | 'system';
  text: string;
  type: 'text' | 'order_card' | 'receipt' | 'interactive';
  items?: OrderItem[];
  showItems?: boolean;
  total?: number;
  delay?: number;
  orderId?: string; // real order ID for API calls
}

interface Step {
  id: number;
  title: string;
  description: string;
  buyerLabel: string;
  sellerLabel: string;
  buyerMessages: ChatMessage[];
  sellerMessages: ChatMessage[];
}

// ── Sample data ────────────────────────────────────────────────────

const initialItems: OrderItem[] = [
  { id: '1', name: 'Aashirvaad Atta', quantity: 1, unit: 'kg', estimatedPrice: null, status: 'pending' },
  { id: '2', name: 'Sugar (Loose)', quantity: 0.5, unit: 'kg', estimatedPrice: null, status: 'pending' },
  { id: '3', name: 'Amul Butter (100g)', quantity: 2, unit: 'pcs', estimatedPrice: null, status: 'pending' },
  { id: '4', name: 'Amul Toned Milk', quantity: 1, unit: 'L', estimatedPrice: null, status: 'pending' },
  { id: '5', name: 'Maggi Masala (4-pack)', quantity: 1, unit: 'pack', estimatedPrice: null, status: 'pending' },
  { id: '6', name: 'Haldiram Namkeen (200g)', quantity: 1, unit: 'pack', estimatedPrice: null, status: 'pending' },
];

const buyerInput = '1 kg atta, 500g sugar, 2 Amul butter, 1L toned milk, Maggi masala 4-pack, 200g Haldiram namkeen';

// ── Steps ──────────────────────────────────────────────────────────

function buildSteps(): Step[] {
  const parsedItems: OrderItem[] = initialItems.map((i) => ({
    ...i,
    estimatedPrice: null,
  }));

  const prices = [320, 45, 120, 65, 55, 90];
  const statuses: Array<'found' | 'not_found'> = ['found', 'found', 'found', 'found', 'found', 'not_found'];
  const pricedItems: OrderItem[] = parsedItems.map((i, idx) => ({
    ...i,
    estimatedPrice: prices[idx] ?? null,
    status: statuses[idx] ?? 'found',
  }));

  const notFoundItem = pricedItems[5]!;
  notFoundItem.status = 'not_found';
  notFoundItem.replacementName = 'Bikano Navratan Mix (200g)';
  notFoundItem.replacementPrice = 85;

  const finalItems: OrderItem[] = pricedItems.map((i) =>
    i.status === 'not_found'
      ? { ...i, status: 'found' as const, name: i.replacementName!, estimatedPrice: i.replacementPrice ?? null }
      : { ...i, status: 'found' as const },
  );

  const total = finalItems.reduce((sum, i) => sum + (i.estimatedPrice ?? 0) * i.quantity, 0);

  return [
    {
      id: 0,
      title: 'Buyer Sends List',
      description: "The buyer sends their grocery list as a text message to the shop's WhatsApp chat.",
      buyerLabel: 'Sending order...',
      sellerLabel: 'Waiting for orders',
      buyerMessages: [
        { id: 'b1', sender: 'buyer', text: buyerInput, type: 'text' },
      ],
      sellerMessages: [],
    },
    {
      id: 1,
      title: 'AI Parses & Buyer Reviews',
      description: "SmartOrder's AI extracts item names and quantities. The buyer reviews, edits if needed, and confirms.",
      buyerLabel: 'Reviewing items',
      sellerLabel: 'Waiting for orders',
      buyerMessages: [
        { id: 'b1', sender: 'buyer', text: buyerInput, type: 'text' },
        { id: 'b2', sender: 'system', text: "Here's what we parsed from your message. Tap any item to edit, or confirm:", type: 'order_card', items: parsedItems, showItems: true },
      ],
      sellerMessages: [],
    },
    {
      id: 2,
      title: 'Buyer Confirms Order',
      description: 'The buyer is satisfied with the list and taps "Confirm Order." The order is sent to the seller.',
      buyerLabel: 'Order confirmed!',
      sellerLabel: 'New order received!',
      buyerMessages: [
        { id: 'b1', sender: 'buyer', text: buyerInput, type: 'text' },
        { id: 'b3', sender: 'system', text: '✅ Order confirmed! Your order has been sent to Sharma General Store.', type: 'text' },
      ],
      sellerMessages: [
        { id: 's1', sender: 'system', text: '🛒 New Order Received!', type: 'text' },
        { id: 's2', sender: 'system', text: '', type: 'order_card', items: parsedItems, showItems: true },
      ],
    },
    {
      id: 3,
      title: 'Seller Prices & Checks Stock',
      description: 'The seller inputs prices and marks unavailable items with replacement suggestions.',
      buyerLabel: 'Waiting for seller',
      sellerLabel: 'Pricing items...',
      buyerMessages: [
        { id: 'b1', sender: 'buyer', text: buyerInput, type: 'text' },
        { id: 'b4', sender: 'system', text: '🏪 The seller is reviewing and pricing your order...', type: 'text' },
      ],
      sellerMessages: [
        { id: 's1', sender: 'system', text: '🛒 New Order Received!', type: 'text' },
        { id: 's3', sender: 'system', text: '', type: 'order_card', items: pricedItems, showItems: true },
      ],
    },
    {
      id: 4,
      title: 'Buyer Reviews Prices',
      description: 'The buyer sees itemized prices and replacements. They can accept or skip replacements.',
      buyerLabel: 'Reviewing prices',
      sellerLabel: 'Waiting for buyer',
      buyerMessages: [
        { id: 'b1', sender: 'buyer', text: buyerInput, type: 'text' },
        { id: 'b5', sender: 'system', text: 'The seller has priced your items. Review and finalize your order:', type: 'text' },
        { id: 'b6', sender: 'system', text: '', type: 'order_card', items: pricedItems, showItems: true },
      ],
      sellerMessages: [
        { id: 's1', sender: 'system', text: '🛒 New Order Received!', type: 'text' },
        { id: 's4', sender: 'system', text: 'Waiting for buyer to review prices...', type: 'text' },
      ],
    },
    {
      id: 5,
      title: 'Buyer Finalizes',
      description: 'The buyer finalizes their order. The seller receives the confirmed order and begins packing.',
      buyerLabel: 'Order finalized!',
      sellerLabel: 'Packing order...',
      buyerMessages: [
        { id: 'b1', sender: 'buyer', text: buyerInput, type: 'text' },
        { id: 'b7', sender: 'system', text: '📦 Your finalized order has been sent for packing!', type: 'text' },
      ],
      sellerMessages: [
        { id: 's1', sender: 'system', text: '🛒 New Order Received!', type: 'text' },
        { id: 's5', sender: 'system', text: '📦 Packing items... Tap each item as you find it.', type: 'order_card', items: finalItems.map(i => ({...i, status: 'pending' as const})), showItems: true },
      ],
    },
    {
      id: 6,
      title: 'Packing Complete',
      description: 'The seller packs all confirmed items and marks the order as packed.',
      buyerLabel: 'Being packed...',
      sellerLabel: 'Packing items...',
      buyerMessages: [
        { id: 'b1', sender: 'buyer', text: buyerInput, type: 'text' },
        { id: 'b8', sender: 'system', text: '📦 Your order is being packed...', type: 'text' },
      ],
      sellerMessages: [
        { id: 's1', sender: 'system', text: '🛒 New Order Received!', type: 'text' },
        { id: 's6', sender: 'system', text: '', type: 'order_card', items: finalItems, showItems: true },
      ],
    },
    {
      id: 7,
      title: 'Ready for Pickup',
      description: 'The seller taps "Ready for Pickup." The buyer receives a final receipt with the total.',
      buyerLabel: 'Order ready! 🎉',
      sellerLabel: 'Order complete! ✅',
      buyerMessages: [
        { id: 'b1', sender: 'buyer', text: buyerInput, type: 'text' },
        { id: 'b9', sender: 'system', text: '', type: 'receipt', items: finalItems, total, showItems: true },
      ],
      sellerMessages: [
        { id: 's1', sender: 'system', text: '🛒 New Order Received!', type: 'text' },
        { id: 's7', sender: 'system', text: `✅ All items packed! Order #SMART-2025 ready for pickup.\n\nTotal: ₹${total}`, type: 'text' },
      ],
    },
  ];
}

// ── Components ─────────────────────────────────────────────────────

interface EditState {
  editing: Set<string>;        // item IDs currently being edited
  values: Record<string, { name: string; quantity: number; price: number | null; unit: string }>;
}

function ChatBubble({
  message,
  storeName = 'Sharma General Store',
  editState,
  onToggleEdit,
  onSaveItem,
  onDeleteItem,
  onConfirmOrder,
  onCancelEditAll,
  onSaveAll,
  isLiveMode = false,
}: {
  message: ChatMessage;
  storeName?: string;
  editState?: EditState;
  onToggleEdit?: (itemId: string, item: OrderItem) => void;
  onSaveItem?: (itemId: string) => void;
  onDeleteItem?: (itemId: string) => void;
  onConfirmOrder?: () => void;
  onCancelEditAll?: () => void;
  onSaveAll?: () => void;
  isLiveMode?: boolean;
}) {
  const isBuyer = message.sender === 'buyer';
  const isSystem = message.sender === 'system';
  const hasEditHandlers = !!onToggleEdit && !!onSaveItem && !!onDeleteItem;

  if (message.type === 'order_card' && message.items) {
    const isAnyEditing = editState && message.items.some((item) => editState.editing.has(item.id));

    return (
      <div
        className={`max-w-[92%] ${isSystem ? 'self-center' : ''} rounded-lg px-2.5 py-2 text-[12.5px] leading-snug ${
          isSystem ? 'bg-white shadow-sm border border-gray-200' : ''
        }`}
      >
        {message.text && (
          <p className="mb-2 text-gray-700 font-medium">{message.text}</p>
        )}
        <div className="divide-y divide-gray-100">
          {message.items.map((item) => {
            const isEditing = editState?.editing.has(item.id);
            const vals = editState?.values[item.id];

            return (
              <div key={item.id} className="py-1.5">
                {isEditing && vals ? (
                  // ── EDIT MODE ──────────────────────────────────
                  <div className="space-y-1.5">
                    {/* Name input */}
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={vals.name}
                        onChange={(e) =>
                          onToggleEdit?.(item.id, { ...item, name: e.target.value })
                        }
                        className="flex-1 min-w-0 text-[11px] px-1.5 py-0.5 border border-gray-300 rounded focus:outline-none focus:border-[#25d366] focus:ring-1 focus:ring-[#25d366]/30"
                        placeholder="Item name"
                      />
                      <button
                        onClick={() => onDeleteItem?.(item.id)}
                        className="shrink-0 w-5 h-5 flex items-center justify-center text-[10px] text-red-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                        title="Delete item"
                      >
                        ✕
                      </button>
                      <button
                        onClick={() => onSaveItem?.(item.id)}
                        className="shrink-0 w-5 h-5 flex items-center justify-center text-[10px] text-green-500 hover:text-green-700 hover:bg-green-50 rounded transition-colors"
                        title="Save item"
                      >
                        ✓
                      </button>
                    </div>
                    {/* Quantity & Unit row */}
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="text-gray-500 shrink-0">Qty:</span>
                      <button
                        onClick={() => {
                          const newQty = Math.max(0.5, vals.quantity - 1);
                          onToggleEdit?.(item.id, { ...item, quantity: newQty });
                        }}
                        className="w-5 h-5 flex items-center justify-center rounded bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold text-xs transition-colors"
                      >
                        −
                      </button>
                      <input
                        type="number"
                        value={vals.quantity}
                        onChange={(e) =>
                          onToggleEdit?.(item.id, { ...item, quantity: Math.max(0.5, parseFloat(e.target.value) || 0.5) })
                        }
                        className="w-14 text-center text-[11px] px-1 py-0.5 border border-gray-300 rounded focus:outline-none focus:border-[#25d366]"
                        step="0.5"
                        min="0.5"
                      />
                      <button
                        onClick={() => {
                          const newQty = vals.quantity + 1;
                          onToggleEdit?.(item.id, { ...item, quantity: newQty });
                        }}
                        className="w-5 h-5 flex items-center justify-center rounded bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold text-xs transition-colors"
                      >
                        +
                      </button>
                      <span className="text-gray-500 shrink-0">Unit:</span>
                      <select
                        value={vals.unit || item.unit}
                        onChange={(e) =>
                          onToggleEdit?.(item.id, { ...item, unit: e.target.value })
                        }
                        className="text-[11px] px-1 py-0.5 border border-gray-300 rounded focus:outline-none focus:border-[#25d366] bg-white"
                      >
                        {['pcs', 'kg', 'g', 'L', 'mL', 'pack', 'box', 'dozen'].map((u) => (
                          <option key={u} value={u}>{u}</option>
                        ))}
                      </select>
                    </div>
                    {/* Price row */}
                    <div className="flex items-center gap-1 text-[11px]">
                      <span className="text-gray-500 shrink-0">Price: ₹</span>
                      <input
                        type="number"
                        value={vals.price ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          onToggleEdit?.(item.id, { ...item, estimatedPrice: v === '' ? null : parseFloat(v) });
                        }}
                        className="w-20 text-[11px] px-1.5 py-0.5 border border-gray-300 rounded focus:outline-none focus:border-[#25d366]"
                        placeholder="—"
                        min="0"
                      />
                    </div>
                  </div>
                ) : (
                  // ── DISPLAY MODE ──────────────────────────────
                  <div className="flex justify-between items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-gray-800 font-medium text-[12px]">
                        {item.quantity > 1 ? `${item.quantity}x ` : ''}{item.name}
                      </div>
                      <div className="text-[10px] text-gray-400">{item.unit}</div>
                    </div>
                    <div className="text-right shrink-0">
                      {item.estimatedPrice != null ? (
                        <span className="font-semibold text-gray-800 text-[12px]">₹{item.estimatedPrice}</span>
                      ) : (
                        <span className="text-gray-300 text-[12px]">—</span>
                      )}
                      {item.status === 'not_found' && item.replacementName && (
                        <div className="text-[10px] text-orange-500 leading-tight">
                          ⚠ Not available<br />
                          → {item.replacementName}<br />
                          <span className="font-medium">₹{item.replacementPrice}</span>
                        </div>
                      )}
                      {item.status === 'found' && (
                        <div className="text-[9px] text-green-600">✓ Found</div>
                      )}
                    </div>
                    {/* Tap-to-edit hint */}
                    {hasEditHandlers && (
                      <button
                        onClick={() => onToggleEdit?.(item.id, item)}
                        className="shrink-0 w-5 h-5 flex items-center justify-center text-[10px] text-gray-300 hover:text-[#25d366] hover:bg-gray-50 rounded transition-colors"
                        title="Edit this item"
                      >
                        ✎
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Action buttons */}
        {hasEditHandlers && (
          <div className="mt-2 pt-1.5 border-t border-gray-100">
            {isAnyEditing ? (
              <div className="flex gap-1.5">
                <button
                  onClick={onSaveAll}
                  className="flex-1 bg-[#25d366] hover:bg-green-600 text-white text-[11px] font-medium rounded-md py-1.5 transition-colors active:scale-95"
                >
                  ✓ Save All
                </button>
                <button
                  onClick={onCancelEditAll}
                  className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-[11px] font-medium rounded-md py-1.5 transition-colors active:scale-95"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex gap-1.5">
                <button
                  onClick={onConfirmOrder}
                  className="flex-1 bg-green-500 hover:bg-green-600 text-white text-[11px] font-medium rounded-md py-1.5 transition-colors active:scale-95"
                >
                  Confirm Order
                </button>
                <button
                  onClick={() => {
                    // Enter edit-all mode
                    message.items?.forEach((item) => onToggleEdit?.(item.id, item));
                  }}
                  className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-[11px] font-medium rounded-md py-1.5 transition-colors active:scale-95"
                >
                  Edit Items
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (message.type === 'receipt' && message.items && message.total) {
    return (
      <div className="max-w-[85%] self-center bg-white rounded-lg px-3 py-2.5 shadow-sm border border-green-600 text-[12.5px] leading-snug">
        <div className="text-center mb-2">
          <div className="font-bold text-gray-800">{storeName}</div>
          <div className="text-[10px] text-gray-400">Order Receipt</div>
        </div>
        <div className="divide-y divide-gray-100">
          {message.items.map((item) => (
            <div key={item.id} className="flex justify-between py-1.5 gap-2 text-[11.5px]">
              <span className="text-gray-700 truncate">
                {item.quantity > 1 ? `${item.quantity}x ` : ''}{item.name}
              </span>
              <span className="font-medium text-gray-800 shrink-0">₹{(item.estimatedPrice ?? 0) * item.quantity}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 pt-1.5 border-t-2 border-gray-200 flex justify-between font-bold text-[13px]">
          <span>Total</span>
          <span>₹{message.total}</span>
        </div>
        <div className="mt-2 text-center text-green-600 font-bold text-[13px]">
          ✅ Ready for Pickup!
        </div>
        <div className="text-center text-[10px] text-gray-400 mt-0.5">
          Please visit the store at your convenience
        </div>
      </div>
    );
  }

  return (
    <div
      className={`max-w-[75%] rounded-lg px-2.5 py-1.5 text-[12.5px] leading-snug ${
        isBuyer
          ? 'self-end bg-[#dcf8c6] rounded-tr-none'
          : 'self-start bg-white rounded-tl-none shadow-sm'
      }`}
    >
      {message.text}
    </div>
  );
}

function WhatsAppChat({
  title,
  subtitle,
  messages,
  typing,
  editState,
  onToggleEdit,
  onSaveItem,
  onDeleteItem,
  onConfirmOrder,
  onCancelEditAll,
  onSaveAll,
  isLiveMode,
}: {
  title: string;
  subtitle: string;
  messages: ChatMessage[];
  typing?: boolean;
  wallpaper?: boolean;
  editState?: EditState;
  onToggleEdit?: (itemId: string, item: OrderItem) => void;
  onSaveItem?: (itemId: string) => void;
  onDeleteItem?: (itemId: string) => void;
  onConfirmOrder?: () => void;
  onCancelEditAll?: () => void;
  onSaveAll?: () => void;
  isLiveMode?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, typing]);

  return (
    <div className="flex flex-col h-full rounded-lg overflow-hidden border border-gray-300 shadow-md bg-white">
      {/* Header */}
      <div className="bg-[#075e54] text-white px-3 py-2 flex items-center gap-2 shrink-0">
        <div className="w-8 h-8 rounded-full bg-gray-300 shrink-0 flex items-center justify-center text-gray-600 text-sm font-bold">
          {title === 'Buyer' ? 'B' : 'S'}
        </div>
        <div className="min-w-0">
          <div className="font-medium text-[14px] truncate">{title}</div>
          <div className="text-[10px] opacity-80 truncate">{subtitle}</div>
        </div>
      </div>

      {/* Chat area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto chat-scroll px-3 py-2 flex flex-col gap-1 min-h-0 wa-wallpaper"
      >
        {messages.length === 0 && !typing && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-400 text-[12px]">
              <div className="text-2xl mb-1">💬</div>
              Waiting for messages...
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <ChatBubble
            key={msg.id}
            message={msg}
            editState={editState}
            onToggleEdit={onToggleEdit}
            onSaveItem={onSaveItem}
            onDeleteItem={onDeleteItem}
            onConfirmOrder={onConfirmOrder}
            onCancelEditAll={onCancelEditAll}
            onSaveAll={onSaveAll}
            isLiveMode={isLiveMode}
          />
        ))}
        {typing && (
          <div className="self-start bg-white rounded-lg rounded-tl-none shadow-sm px-3 py-2 flex gap-1 items-center">
            <div className="typing-dot w-2 h-2 bg-gray-400 rounded-full"></div>
            <div className="typing-dot w-2 h-2 bg-gray-400 rounded-full"></div>
            <div className="typing-dot w-2 h-2 bg-gray-400 rounded-full"></div>
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="bg-[#f0f0f0] px-3 py-2 flex items-center gap-2 shrink-0 border-t border-gray-200">
        <div className="text-gray-400 text-sm">😊</div>
        <div className="flex-1 bg-white rounded-full px-3 py-1.5 text-[12px] text-gray-400 truncate">
          Type a message...
        </div>
        <div className="w-8 h-8 rounded-full bg-[#075e54] flex items-center justify-center text-white text-sm">
          🎤
        </div>
      </div>
    </div>
  );
}

function StepDot({ step, current }: { step: Step; current: number }) {
  const isActive = step.id === current;
  const isPast = step.id < current;

  return (
    <div className="flex items-center gap-2 group cursor-pointer">
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300 ${
          isActive
            ? 'bg-[#0ea5e9] text-white step-active scale-110'
            : isPast
              ? 'bg-green-500 text-white'
              : 'bg-gray-200 text-gray-500'
        }`}
      >
        {isPast ? '✓' : step.id + 1}
      </div>
      <div className="hidden sm:block">
        <div className={`text-[11px] font-semibold ${isActive ? 'text-[#0ea5e9]' : isPast ? 'text-green-600' : 'text-gray-400'}`}>
          {step.title}
        </div>
        <div className="text-[10px] text-gray-400 leading-tight line-clamp-2">{step.description}</div>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function mapApiOrderToChatMessage(order: Order, sender: 'buyer' | 'seller' | 'system'): ChatMessage {
  return {
    id: order.id,
    sender,
    text: '',
    type: 'order_card',
    items: order.items.map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit || 'pcs',
      estimatedPrice: item.estimatedPrice ?? item.actualPrice,
      status: (item.status === 'FOUND' ? 'found' : item.status === 'NOT_FOUND' ? 'not_found' : 'pending') as OrderItem['status'],
      replacementName: item.replacementName || undefined,
      replacementPrice: item.replacementPrice || undefined,
    })),
    showItems: true,
    orderId: order.id,
  };
}

// ── Main Page ──────────────────────────────────────────────────────

export default function Home() {
  const [steps] = useState<Step[]>(() => buildSteps());
  const [currentStep, setCurrentStep] = useState(0);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [typing, setTyping] = useState(false);
  const [isLiveMode, setIsLiveMode] = useState(false);

  // Demo mode: mutable step data for inline editing
  const [liveSteps, setLiveSteps] = useState<Step[]>(() => buildSteps());

  // Live mode: real orders
  const [liveOrders, setLiveOrders] = useState<Order[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  // Edit state: shared across ChatBubble instances
  const [editState, setEditState] = useState<EditState>({
    editing: new Set<string>(),
    values: {},
  });

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // ── Demo mode active step ──────────────────────────────────────
  const activeStep = liveSteps[currentStep]!;

  const goToStep = useCallback(
    (step: number) => {
      if (step < 0 || step >= steps.length) return;
      setTyping(true);
      const duration = 800 + Math.random() * 400;
      setTimeout(() => {
        setTyping(false);
        setCurrentStep(step);
      }, duration);
    },
    [steps.length],
  );

  const nextStep = useCallback(() => {
    if (currentStep < steps.length - 1) goToStep(currentStep + 1);
  }, [currentStep, steps.length, goToStep]);

  const prevStep = useCallback(() => {
    if (currentStep > 0) goToStep(currentStep - 1);
  }, [currentStep, goToStep]);

  // Auto-advance
  useEffect(() => {
    if (!autoAdvance || isLiveMode) return;
    const interval = setInterval(() => {
      setCurrentStep((prev) => {
        if (prev >= steps.length - 1) {
          setAutoAdvance(false);
          return prev;
        }
        return prev + 1;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [autoAdvance, steps.length, isLiveMode]);

  // Keyboard controls
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isLiveMode) return;
      if (e.key === 'ArrowRight') nextStep();
      if (e.key === 'ArrowLeft') prevStep();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [nextStep, prevStep, isLiveMode]);

  // ── Live mode: fetch orders ────────────────────────────────────
  const loadLiveOrders = useCallback(async () => {
    setLiveLoading(true);
    setLiveError(null);
    try {
      const orders = await fetchOrders();
      setLiveOrders(orders);
    } catch (err: any) {
      setLiveError(err.message || 'Failed to load orders');
    } finally {
      setLiveLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isLiveMode) {
      loadLiveOrders();
      // Poll every 10s
      const interval = setInterval(loadLiveOrders, 10_000);
      return () => clearInterval(interval);
    }
  }, [isLiveMode, loadLiveOrders]);

  // ── Inline editing handlers ────────────────────────────────────

  const handleToggleEdit = useCallback((itemId: string, item: OrderItem) => {
    setEditState((prev) => {
      const newEditing = new Set(prev.editing);
      const newValues = { ...prev.values };

      if (newEditing.has(itemId)) {
        // Already editing — update values
        newValues[itemId] = {
          name: item.name,
          quantity: item.quantity,
          price: item.estimatedPrice ?? null,
          unit: item.unit,
        };
      } else {
        // Enter edit mode
        newEditing.add(itemId);
        newValues[itemId] = {
          name: item.name,
          quantity: item.quantity,
          price: item.estimatedPrice ?? null,
          unit: item.unit,
        };
      }

      return { editing: newEditing, values: newValues };
    });
  }, []);

  const handleSaveItem = useCallback(
    async (itemId: string) => {
      const vals = editState.values[itemId];
      if (!vals) return;

      if (isLiveMode) {
        // Save to backend
        try {
          await apiUpdateItem(itemId, {
            name: vals.name,
            quantity: vals.quantity,
            estimatedPrice: vals.price ?? undefined,
            unit: vals.unit,
          });
        } catch (err) {
          console.error('Failed to save item:', err);
        }
        // Refresh
        loadLiveOrders();
      } else {
        // Update demo state
        setLiveSteps((prev) =>
          prev.map((step) => ({
            ...step,
            buyerMessages: step.buyerMessages.map((msg) =>
              msg.type === 'order_card' && msg.items
                ? {
                    ...msg,
                    items: msg.items.map((i) =>
                      i.id === itemId
                        ? {
                            ...i,
                            name: vals.name,
                            quantity: vals.quantity,
                            estimatedPrice: vals.price,
                            unit: vals.unit,
                          }
                        : i,
                    ),
                  }
                : msg,
            ),
            sellerMessages: step.sellerMessages.map((msg) =>
              msg.type === 'order_card' && msg.items
                ? {
                    ...msg,
                    items: msg.items.map((i) =>
                      i.id === itemId
                        ? {
                            ...i,
                            name: vals.name,
                            quantity: vals.quantity,
                            estimatedPrice: vals.price,
                            unit: vals.unit,
                          }
                        : i,
                    ),
                  }
                : msg,
            ),
          })),
        );
      }

      // Exit edit mode for this item
      setEditState((prev) => {
        const newEditing = new Set(prev.editing);
        newEditing.delete(itemId);
        const newValues = { ...prev.values };
        delete newValues[itemId];
        return { editing: newEditing, values: newValues };
      });
    },
    [editState.values, isLiveMode, loadLiveOrders],
  );

  const handleDeleteItem = useCallback(
    async (itemId: string) => {
      if (isLiveMode) {
        try {
          await apiDeleteItem(itemId);
        } catch (err) {
          console.error('Failed to delete item:', err);
        }
        loadLiveOrders();
      } else {
        setLiveSteps((prev) =>
          prev.map((step) => ({
            ...step,
            buyerMessages: step.buyerMessages.map((msg) =>
              msg.type === 'order_card' && msg.items
                ? { ...msg, items: msg.items.filter((i) => i.id !== itemId) }
                : msg,
            ),
            sellerMessages: step.sellerMessages.map((msg) =>
              msg.type === 'order_card' && msg.items
                ? { ...msg, items: msg.items.filter((i) => i.id !== itemId) }
                : msg,
            ),
          })),
        );
      }

      // Remove from edit state
      setEditState((prev) => {
        const newEditing = new Set(prev.editing);
        newEditing.delete(itemId);
        const newValues = { ...prev.values };
        delete newValues[itemId];
        return { editing: newEditing, values: newValues };
      });
    },
    [isLiveMode, loadLiveOrders],
  );

  const handleConfirmOrder = useCallback(async () => {
    if (isLiveMode) {
      // Confirm the most recent active order shown in buyer panel
      const activeOrders = liveOrders.filter(
        (o) => o.status === 'REVIEWING' || o.status === 'PARSING',
      );
      if (activeOrders.length > 0) {
        try {
          await apiConfirmOrder(activeOrders[0]!.id);
        } catch (err) {
          console.error('Failed to confirm order:', err);
        }
        loadLiveOrders();
      }
    } else {
      // Move to next step in demo
      nextStep();
    }
  }, [isLiveMode, liveOrders, loadLiveOrders, nextStep]);

  const handleCancelEditAll = useCallback(() => {
    setEditState({ editing: new Set(), values: {} });
  }, []);

  const handleSaveAll = useCallback(async () => {
    const idsToSave = Array.from(editState.editing);
    for (const itemId of idsToSave) {
      await handleSaveItem(itemId);
    }
  }, [editState.editing, handleSaveItem]);

  // ── Build live-mode messages ───────────────────────────────────
  const buyerLiveMessages: ChatMessage[] = liveOrders
    .filter((o) => o.status === 'REVIEWING' || o.status === 'PARSING' || o.status === 'SUBMITTED')
    .map((o) => mapApiOrderToChatMessage(o, 'system'));

  const sellerLiveMessages: ChatMessage[] = liveOrders
    .filter((o) => o.status === 'SUBMITTED' || o.status === 'PACKING' || o.status === 'AWAITING_REPLACEMENT')
    .map((o) => mapApiOrderToChatMessage(o, 'system'));

  // ── Render ─────────────────────────────────────────────────────
  const displayBuyerMessages = isLiveMode ? buyerLiveMessages : activeStep.buyerMessages;
  const displaySellerMessages = isLiveMode ? sellerLiveMessages : activeStep.sellerMessages;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 sm:px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-[#25d366] flex items-center justify-center text-white font-bold text-lg">
            S
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 tracking-wide">SmartOrder</h1>
            <p className="text-[11px] text-gray-500">WhatsApp Custom Ordering System — Demo</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Live Mode Toggle */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <span className="text-[11px] text-gray-500">Demo</span>
            <div className="relative">
              <input
                type="checkbox"
                checked={isLiveMode}
                onChange={(e) => {
                  setIsLiveMode(e.target.checked);
                  setEditState({ editing: new Set(), values: {} });
                }}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-gray-200 rounded-full peer-checked:bg-[#25d366] transition-colors"></div>
              <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow peer-checked:translate-x-4 transition-transform"></div>
            </div>
            <span className={`text-[11px] font-medium ${isLiveMode ? 'text-[#25d366]' : 'text-gray-400'}`}>Live</span>
          </label>

          <a
            href="https://github.com"
            target="_blank"
            rel="noopener"
            className="text-[12px] text-gray-500 hover:text-gray-700 hidden sm:block"
          >
            GitHub
          </a>
          <span className="bg-green-100 text-green-700 text-[10px] font-medium px-2 py-0.5 rounded-full">
            {isLiveMode ? 'Live' : 'Demo'}
          </span>
        </div>
      </header>

      {/* Step progress bar (demo mode only) */}
      {!isLiveMode && (
        <div className="bg-white border-b border-gray-100 px-4 sm:px-6 py-2.5 shrink-0 overflow-x-auto">
          <div className="flex gap-4 sm:gap-6 min-w-max justify-center">
            {steps.map((step) => (
              <StepDot key={step.id} step={step} current={currentStep} />
            ))}
          </div>
        </div>
      )}

      {/* Active step title */}
      <div className="text-center py-3 px-4 shrink-0">
        {isLiveMode ? (
          <>
            <div className="inline-flex items-center gap-2 bg-[#25d366]/10 text-[#25d366] rounded-full px-4 py-1 text-[11px] font-semibold">
              🟢 Live — Connected to API
            </div>
            <h2 className="text-[15px] font-bold text-gray-800 mt-1.5">Real Orders</h2>
            <p className="text-[11.5px] text-gray-500 max-w-lg mx-auto leading-relaxed mt-0.5">
              Showing orders from the database. Edit items inline &mdash; changes sync to WhatsApp backend.
            </p>
          </>
        ) : (
          <>
            <div className="inline-flex items-center gap-2 bg-[#0ea5e9]/10 text-[#0ea5e9] rounded-full px-4 py-1 text-[11px] font-semibold">
              Step {currentStep + 1} of {steps.length}
            </div>
            <h2 className="text-[15px] font-bold text-gray-800 mt-1.5">{activeStep.title}</h2>
            <p className="text-[11.5px] text-gray-500 max-w-lg mx-auto leading-relaxed mt-0.5">
              {activeStep.description}
            </p>
          </>
        )}
      </div>

      {/* Chat panels */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 px-4 sm:px-6 pb-4 min-h-0">
        <div className="h-[420px] sm:h-[500px]">
          <WhatsAppChat
            title="Buyer"
            subtitle={
              isLiveMode
                ? liveLoading
                  ? 'Loading...'
                  : `${buyerLiveMessages.length} orders`
                : typing
                  ? '...'
                  : activeStep.buyerLabel
            }
            messages={displayBuyerMessages}
            typing={typing && !isLiveMode}
            editState={editState}
            onToggleEdit={handleToggleEdit}
            onSaveItem={handleSaveItem}
            onDeleteItem={handleDeleteItem}
            onConfirmOrder={handleConfirmOrder}
            onCancelEditAll={handleCancelEditAll}
            onSaveAll={handleSaveAll}
            isLiveMode={isLiveMode}
          />
        </div>
        <div className="h-[420px] sm:h-[500px]">
          <WhatsAppChat
            title="Sharma General Store"
            subtitle={
              isLiveMode
                ? liveLoading
                  ? 'Loading...'
                  : `${sellerLiveMessages.length} orders`
                : typing
                  ? '...'
                  : activeStep.sellerLabel
            }
            messages={displaySellerMessages}
            typing={typing && !isLiveMode}
            editState={editState}
            onToggleEdit={handleToggleEdit}
            onSaveItem={handleSaveItem}
            onDeleteItem={handleDeleteItem}
            onConfirmOrder={handleConfirmOrder}
            onCancelEditAll={handleCancelEditAll}
            onSaveAll={handleSaveAll}
            isLiveMode={isLiveMode}
          />
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white border-t border-gray-200 px-4 sm:px-6 py-3 shrink-0">
        <div className="flex items-center justify-between gap-3 max-w-2xl mx-auto">
          <button
            onClick={prevStep}
            disabled={currentStep === 0 || isLiveMode}
            className="px-3 py-1.5 text-[12px] font-medium rounded-md bg-gray-100 hover:bg-gray-200 text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            ← Prev
          </button>

          <div className="flex items-center gap-3">
            {!isLiveMode && (
              <label className="flex items-center gap-2 text-[12px] text-gray-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoAdvance}
                  onChange={(e) => setAutoAdvance(e.target.checked)}
                  className="accent-green-600 w-3.5 h-3.5"
                />
                Auto-advance all steps
              </label>
            )}

            {isLiveMode && (
              <button
                onClick={loadLiveOrders}
                disabled={liveLoading}
                className="px-3 py-1.5 text-[12px] font-medium rounded-md bg-[#25d366]/10 hover:bg-[#25d366]/20 text-[#25d366] disabled:opacity-50 transition-colors"
              >
                {liveLoading ? 'Refreshing...' : '🔄 Refresh'}
              </button>
            )}

            <button
              onClick={nextStep}
              disabled={currentStep === steps.length - 1 || isLiveMode}
              className="px-4 py-1.5 text-[12px] font-semibold rounded-md bg-[#0ea5e9] hover:brightness-110 text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
            >
              Step manually & interact →
            </button>
          </div>
        </div>
        <div className="text-center text-[10px] text-gray-400 mt-2">
          {isLiveMode
            ? liveError
              ? `⚠️ ${liveError}`
              : 'Live data from API · Auto-refreshes every 10s'
            : 'Use ← → arrow keys to navigate between steps'}
        </div>
      </div>

      {/* Footer */}
      <footer className="text-center py-4 text-[11px] text-gray-400 border-t border-gray-100 shrink-0">
        Built with Next.js & NestJS · SmartOrder Demo
        {isLiveMode && ' · Live Mode'}
      </footer>
    </div>
  );
}
