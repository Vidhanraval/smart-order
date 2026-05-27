export type OrderStatus =
  | 'PARSING'
  | 'REVIEWING'
  | 'SUBMITTED'
  | 'PACKING'
  | 'AWAITING_REPLACEMENT'
  | 'READY_FOR_PICKUP'
  | 'COMPLETED'
  | 'EXPIRED';

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PARSING: ['REVIEWING'],
  REVIEWING: ['SUBMITTED', 'EXPIRED'],
  SUBMITTED: ['PACKING'],
  PACKING: ['AWAITING_REPLACEMENT', 'COMPLETED', 'READY_FOR_PICKUP'],
  AWAITING_REPLACEMENT: ['PACKING'],
  READY_FOR_PICKUP: ['COMPLETED'],
  COMPLETED: [],
  EXPIRED: [],
};

const STATUS_LABELS: Record<OrderStatus, string> = {
  PARSING: 'Parsing your order...',
  REVIEWING: 'Please review your order',
  SUBMITTED: 'Order submitted to seller',
  PACKING: 'Seller is packing your order',
  AWAITING_REPLACEMENT: 'Review suggested replacements',
  READY_FOR_PICKUP: 'Ready for pickup!',
  COMPLETED: 'Order completed',
  EXPIRED: 'Order expired',
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transition(from: OrderStatus, to: OrderStatus): OrderStatus {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} → ${to}`);
  }
  return to;
}

export function getStatusLabel(status: OrderStatus): string {
  return STATUS_LABELS[status];
}

export function getValidNextStates(status: OrderStatus): OrderStatus[] {
  return VALID_TRANSITIONS[status] ?? [];
}
