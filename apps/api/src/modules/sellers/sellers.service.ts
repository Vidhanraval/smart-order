import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SellersService {
  private readonly logger = new Logger(SellersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findOrCreate(phoneNumber: string, name?: string) {
    let seller = await this.prisma.seller.findUnique({
      where: { phoneNumber },
    });

    if (!seller) {
      seller = await this.prisma.seller.create({
        data: { phoneNumber, name },
      });
      this.logger.log(`Created new seller: ${phoneNumber}`);
    }

    return seller;
  }

  async upsert(phoneNumber: string, phoneNumberId?: string, name?: string) {
    const existing = await this.prisma.seller.findUnique({
      where: { phoneNumber },
    });

    if (existing) {
      // Update phoneNumberId if it changed (or was previously null)
      if (phoneNumberId && existing.phoneNumberId !== phoneNumberId) {
        const updated = await this.prisma.seller.update({
          where: { phoneNumber },
          data: { phoneNumberId, name: name ?? existing.name },
        });
        this.logger.log(`Updated seller ${phoneNumber} phoneNumberId: ${phoneNumberId}`);
        return updated;
      }
      return existing;
    }

    // Create new seller
    const seller = await this.prisma.seller.create({
      data: { phoneNumber, phoneNumberId, name },
    });
    this.logger.log(`Auto-created seller: ${phoneNumber} (phoneNumberId: ${phoneNumberId})`);
    return seller;
  }

  async findById(id: string) {
    return this.prisma.seller.findUnique({ where: { id }, include: { orders: true } });
  }

  async findByPhone(phoneNumber: string) {
    return this.prisma.seller.findUnique({ where: { phoneNumber } });
  }

  async findByStoreName(storeName: string) {
    // Find sellers whose storeName contains the search term
    const sellers = await this.prisma.seller.findMany({
      where: { storeName: { not: null } },
    });
    // Filter in JS for case-insensitive matching (works with both SQLite and PostgreSQL)
    const lower = storeName.toLowerCase();
    const exact = sellers.find((s) => s.storeName?.toLowerCase() === lower);
    if (exact) return exact;
    const partial = sellers.find((s) => s.storeName?.toLowerCase().includes(lower));
    return partial ?? null;
  }

  async findAll() {
    return this.prisma.seller.findMany({ include: { orders: true } });
  }

  async getSummary() {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        phone_number: string;
        name: string | null;
        store_name: string | null;
        total_orders: number;
        completed_orders: number;
        total_revenue: number;
        last_order_date: Date | null;
      }>
    >(`
      SELECT
        s."phoneNumber" AS phone_number,
        s.name,
        s."storeName" AS store_name,
        COUNT(o.id)::int AS total_orders,
        COUNT(o.id) FILTER (WHERE o.status = 'COMPLETED')::int AS completed_orders,
        COALESCE(SUM(o."totalPrice") FILTER (WHERE o."totalPrice" IS NOT NULL), 0)::float AS total_revenue,
        MAX(o."createdAt") AS last_order_date
      FROM "Seller" s
      LEFT JOIN "Order" o ON o."sellerId" = s.id
      GROUP BY s.id, s."phoneNumber", s.name, s."storeName"
      ORDER BY total_orders DESC
    `);

    return rows.map((r) => ({
      ...r,
      total_revenue: Number(r.total_revenue),
    }));
  }
}
