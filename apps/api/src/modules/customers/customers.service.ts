import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findOrCreate(phoneNumber: string, name?: string) {
    let customer = await this.prisma.customer.findUnique({
      where: { phoneNumber },
    });

    if (!customer) {
      customer = await this.prisma.customer.create({
        data: { phoneNumber, name },
      });
      this.logger.log(`Created new customer: ${phoneNumber}`);
    } else if (name && !customer.name) {
      customer = await this.prisma.customer.update({
        where: { id: customer.id },
        data: { name },
      });
    }

    return customer;
  }

  async findById(id: string) {
    return this.prisma.customer.findUnique({ where: { id }, include: { orders: true } });
  }

  async findAll() {
    return this.prisma.customer.findMany({ include: { orders: true } });
  }
}
