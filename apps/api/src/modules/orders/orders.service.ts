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
}
