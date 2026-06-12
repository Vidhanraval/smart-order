import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SellersService } from './sellers.service';
import { SellersController } from './sellers.controller';

@Module({
  controllers: [SellersController],
  providers: [SellersService],
  exports: [SellersService],
})
export class SellersModule implements OnModuleInit {
  private readonly logger = new Logger(SellersModule.name);

  constructor(
    private readonly sellersService: SellersService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // Run every deploy: activate sellers that have orders (idempotent & safe).
    // Newly-registered sellers (0 orders) stay PENDING until admin approves.
    try {
      const result = await this.prisma.$executeRawUnsafe(
        `UPDATE "Seller" SET status = 'ACTIVE' WHERE status = 'PENDING' AND id IN (SELECT DISTINCT "sellerId" FROM "Order")`
      );
      if (result > 0) {
        this.logger.log(`Auto-activated ${result} seller(s) with existing orders`);
      }
    } catch (err) {
      this.logger.warn(`Migration: could not auto-activate sellers — may already be ACTIVE. ${err instanceof Error ? err.message : err}`);
    }

    // Seed a fallback seller if SELLER_PHONE_NUMBER is configured (backward compat)
    // New sellers are auto-created from webhook metadata on first message
    const sellerPhone = this.configService.get<string>('seller.phoneNumber') ?? '';
    if (sellerPhone) {
      const phoneNumberId = this.configService.get<string>('whatsapp.phoneNumberId') ?? undefined;
      const seller = await this.sellersService.upsert(sellerPhone, phoneNumberId, 'Local Shop');
      // Ensure the fallback/default seller is always ACTIVE (not PENDING)
      if (seller.status !== 'ACTIVE') {
        await this.sellersService.approveSeller(seller.id);
        this.logger.log(`Fallback seller auto-activated: ${seller.phoneNumber}`);
      }
      this.logger.log(`Fallback seller ready: ${seller.phoneNumber}`);
    } else {
      this.logger.log('No SELLER_PHONE_NUMBER configured — sellers will be auto-created from incoming webhook messages');
    }
  }
}
