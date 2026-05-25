import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { AiModule } from './modules/ai/ai.module';
import { OrdersModule } from './modules/orders/orders.module';
import { CustomersModule } from './modules/customers/customers.module';
import { SellersModule } from './modules/sellers/sellers.module';
import { LinksModule } from './links/links.module';
import { AppService } from './app.service';
import { AppController } from './app.controller';
import configuration from './config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    WhatsAppModule,
    AiModule,
    OrdersModule,
    CustomersModule,
    SellersModule,
    LinksModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
