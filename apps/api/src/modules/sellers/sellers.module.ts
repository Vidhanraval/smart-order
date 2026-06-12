import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  ) {}

  async onModuleInit() {
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
