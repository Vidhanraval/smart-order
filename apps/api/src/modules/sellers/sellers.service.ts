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

  async findById(id: string) {
    return this.prisma.seller.findUnique({ where: { id }, include: { orders: true } });
  }

  async findByPhone(phoneNumber: string) {
    return this.prisma.seller.findUnique({ where: { phoneNumber } });
  }

  async findAll() {
    return this.prisma.seller.findMany({ include: { orders: true } });
  }
}
