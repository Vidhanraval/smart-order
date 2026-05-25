import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { AiModule } from '../ai/ai.module';
import { OrdersModule } from '../orders/orders.module';
import { CustomersModule } from '../customers/customers.module';
import { SellersModule } from '../sellers/sellers.module';

@Module({
  imports: [AiModule, OrdersModule, CustomersModule, SellersModule],
  controllers: [WhatsAppController],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
