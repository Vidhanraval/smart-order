import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { transition, getStatusLabel, OrderStatus } from './state-machine';
import { ParsedOrderResult } from '../ai/ai.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createFromParsed(
    customerId: string,
    sellerId: string,
    parsed: ParsedOrderResult,
    originalInput?: string,
  ) {
    const order = await this.prisma.order.create({
      data: {
        customerId,
        sellerId,
        status: 'REVIEWING',
        originalInput,
        items: {
          create: parsed.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            unit: item.unit || 'pcs',
            estimatedPrice: item.estimatedPrice,
            status: 'PENDING',
          })),
        },
      },
      include: { items: true, customer: true },
    });

    this.logger.log(`Created order ${order.id} with ${parsed.items.length} items`);
    return order;
  }

  async findById(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true, customer: true, seller: true },
    });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return order;
  }

  async findByCustomer(customerId: string) {
    return this.prisma.order.findMany({
      where: { customerId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findBySeller(sellerId: string) {
    return this.prisma.order.findMany({
      where: { sellerId },
      include: { items: true, customer: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getActiveOrder(customerId: string, sellerId: string) {
    return this.prisma.order.findFirst({
      where: {
        customerId,
        sellerId,
        status: { notIn: ['COMPLETED'] },
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async transitionStatus(orderId: string, to: string) {
    const order = await this.findById(orderId);
    const newStatus = transition(order.status as OrderStatus, to as OrderStatus);

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: newStatus },
      include: { items: true, customer: true },
    });

    this.logger.log(`Order ${orderId}: ${order.status} → ${newStatus}`);
    return updated;
  }

  async updateItemStatus(itemId: string, status: string, actualPrice?: number) {
    const data: Prisma.OrderItemUpdateInput = { status };
    if (actualPrice !== undefined) data.actualPrice = actualPrice;

    return this.prisma.orderItem.update({
      where: { id: itemId },
      data,
    });
  }

  async addReplacement(
    orderItemId: string,
    replacementName: string,
    replacementPrice: number,
  ) {
    return this.prisma.orderItem.update({
      where: { id: orderItemId },
      data: {
        status: 'REPLACEMENT_SUGGESTED',
        replacementName,
        replacementPrice,
      },
    });
  }

  async acceptReplacement(itemId: string) {
    return this.prisma.orderItem.update({
      where: { id: itemId },
      data: {
        status: 'REPLACEMENT_ACCEPTED',
        name: undefined, // will be set via actualPrice
      },
    });
  }

  async skipReplacement(itemId: string) {
    return this.prisma.orderItem.update({
      where: { id: itemId },
      data: { status: 'REPLACEMENT_SKIPPED' },
    });
  }

  async acceptReplacementWithPrice(itemId: string, name: string, price: number) {
    return this.prisma.orderItem.update({
      where: { id: itemId },
      data: {
        status: 'REPLACEMENT_ACCEPTED',
        name,
        actualPrice: price,
      },
    });
  }

  async finalizeTotal(orderId: string) {
    const order = await this.findById(orderId);
    const items = order.items ?? [];

    const total = items
      .filter((i) => i.status !== 'REPLACEMENT_SKIPPED' && i.status !== 'NOT_FOUND')
      .reduce((sum, item) => {
        const price = item.actualPrice ?? item.estimatedPrice ?? 0;
        return sum + price * item.quantity;
      }, 0);

    return this.prisma.order.update({
      where: { id: orderId },
      data: { totalPrice: Math.round(total * 100) / 100 },
      include: { items: true },
    });
  }

  hasItemsNeedingReplacement(order: Awaited<ReturnType<typeof this.findById>>): boolean {
    return order.items?.some((i) => i.status === 'NOT_FOUND') ?? false;
  }

  areAllItemsResolved(order: Awaited<ReturnType<typeof this.findById>>): boolean {
    return !order.items?.some(
      (i) => i.status === 'PENDING' || i.status === 'NOT_FOUND',
    );
  }

  getStatusLabel(status: string): string {
    return getStatusLabel(status as OrderStatus);
  }

  // ── Dashboard: all data in one flat table ─────────────────────────

  async getFullSummary() {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        order_id: string;
        order_date: Date;
        order_status: string;
        order_total: number | null;
        original_input: string | null;
        buyer_name: string | null;
        buyer_number: string;
        seller_name: string | null;
        seller_number: string;
        store_name: string | null;
        items: string | null;
        item_count: number;
        last_message: string | null;
        last_message_direction: string | null;
        message_count: number;
      }>
    >(`
      SELECT
        o.id AS order_id,
        o."createdAt" AS order_date,
        o.status AS order_status,
        o."totalPrice" AS order_total,
        o."originalInput" AS original_input,
        c.name AS buyer_name,
        c."phoneNumber" AS buyer_number,
        s.name AS seller_name,
        s."phoneNumber" AS seller_number,
        s."storeName" AS store_name,
        STRING_AGG(oi.name || ' x' || oi.quantity || ' @₹' || COALESCE(oi."actualPrice", oi."estimatedPrice", 0), ', ') AS items,
        COUNT(oi.id)::int AS item_count,
        (
          SELECT m.body FROM "Message" m
          WHERE m."orderId" = o.id
          ORDER BY m."createdAt" DESC LIMIT 1
        ) AS last_message,
        (
          SELECT m.direction FROM "Message" m
          WHERE m."orderId" = o.id
          ORDER BY m."createdAt" DESC LIMIT 1
        ) AS last_message_direction,
        (
          SELECT COUNT(*)::int FROM "Message" m WHERE m."orderId" = o.id
        ) AS message_count
      FROM "Order" o
      JOIN "Customer" c ON o."customerId" = c.id
      JOIN "Seller" s ON o."sellerId" = s.id
      LEFT JOIN "OrderItem" oi ON oi."orderId" = o.id
      GROUP BY o.id, c."phoneNumber", c.name, s."phoneNumber", s.name, s."storeName"
      ORDER BY o."createdAt" DESC
    `);

    return rows.map((row) => ({
      ...row,
      order_total: row.order_total ? Number(row.order_total) : null,
    }));
  }
}
