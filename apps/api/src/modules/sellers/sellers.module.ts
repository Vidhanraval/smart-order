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
    const sellerPhone = this.configService.get<string>('seller.phoneNumber') ?? '';
    if (!sellerPhone) {
      this.logger.warn('SELLER_PHONE_NUMBER not configured — skipping seller seed');
      return;
    }

    const seller = await this.sellersService.findOrCreate(sellerPhone, 'Local Shop');
    this.logger.log(`Seller ready: ${seller.phoneNumber} (${seller.id})`);
  }
}
