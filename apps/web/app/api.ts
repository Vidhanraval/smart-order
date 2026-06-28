const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export interface OrderItem {
  id: string;
  orderId: string;
  name: string;
  quantity: number;
  unit: string | null;
  estimatedPrice: number | null;
  actualPrice: number | null;
  status: string;
  replacementName: string | null;
  replacementPrice: number | null;
}

export interface Order {
  id: string;
  customerId: string;
  sellerId: string;
  status: string;
  totalPrice: number | null;
  originalInput: string | null;
  items: OrderItem[];
  customer?: { phoneNumber: string; name?: string | null };
  seller?: { phoneNumber: string; storeName?: string | null };
  createdAt: string;
}

export async function fetchOrders(params?: {
  sellerId?: string;
  customerId?: string;
}): Promise<Order[]> {
  const searchParams = new URLSearchParams();
  if (params?.sellerId) searchParams.set('sellerId', params.sellerId);
  if (params?.customerId) searchParams.set('customerId', params.customerId);

  const res = await fetch(`${API_URL}/api/orders?${searchParams.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch orders: ${res.statusText}`);
  return res.json();
}

export async function fetchOrder(id: string): Promise<Order> {
  const res = await fetch(`${API_URL}/api/orders/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch order: ${res.statusText}`);
  return res.json();
}

export interface UpdateItemBody {
  name?: string;
  quantity?: number;
  estimatedPrice?: number;
  unit?: string;
}

export async function updateItem(
  itemId: string,
  data: UpdateItemBody,
): Promise<OrderItem> {
  const res = await fetch(`${API_URL}/api/orders/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to update item: ${res.statusText}`);
  return res.json();
}

export async function deleteItem(itemId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/orders/items/${itemId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to delete item: ${res.statusText}`);
}

export async function confirmOrder(orderId: string): Promise<Order> {
  const res = await fetch(`${API_URL}/api/orders/${orderId}/confirm`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to confirm order: ${res.statusText}`);
  return res.json();
}
