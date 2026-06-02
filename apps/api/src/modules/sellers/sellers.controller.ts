import { Controller, Get, Param } from '@nestjs/common';
import { SellersService } from './sellers.service';

@Controller('api/sellers')
export class SellersController {
  constructor(private readonly sellersService: SellersService) {}

  @Get('summary')
  async getSummary() {
    return this.sellersService.getSummary();
  }

  @Get()
  async findAll() {
    return this.sellersService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.sellersService.findById(id);
  }
}
