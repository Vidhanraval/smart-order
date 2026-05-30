import { Module, Controller, Get } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { AiModule } from './modules/ai/ai.module';
import { OrdersModule } from './modules/orders/orders.module';
import { CustomersModule } from './modules/customers/customers.module';
import { SellersModule } from './modules/sellers/sellers.module';
import configuration from './config/configuration';

@Controller()
class HealthController {
  @Get('health')
  health() {
    return 'OK';
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    WhatsAppModule,
    AiModule,
    OrdersModule,
    CustomersModule,
    SellersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
