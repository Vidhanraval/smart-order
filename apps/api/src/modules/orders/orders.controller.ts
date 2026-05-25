import { Controller, Get, Param, Query } from '@nestjs/common';
import { OrdersService } from './orders.service';

@Controller('api/orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  async findAll(@Query('sellerId') sellerId?: string, @Query('customerId') customerId?: string) {
    if (sellerId) return this.ordersService.findBySeller(sellerId);
    if (customerId) return this.ordersService.findByCustomer(customerId);
    return [];
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.ordersService.findById(id);
  }
}
