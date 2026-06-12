import { Module, Controller, Get, Res } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { AiModule } from './modules/ai/ai.module';
import { OrdersModule } from './modules/orders/orders.module';
import { CustomersModule } from './modules/customers/customers.module';
import { SellersModule } from './modules/sellers/sellers.module';
import { FlowsModule } from './modules/flows/flows.module';
import configuration from './config/configuration';
import { Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';

@Controller()
class HealthController {
  @Get('health')
  health() {
    return 'OK';
  }

  @Get('dashboard')
  dashboard(@Res() res: Response) {
    const html = readFileSync(join(__dirname, 'dashboard.html'), 'utf-8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
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
    FlowsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
