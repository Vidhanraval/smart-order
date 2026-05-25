import { Controller, Get, Param } from '@nestjs/common';
import { CustomersService } from './customers.service';

@Controller('api/customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  async findAll() {
    return this.customersService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.customersService.findById(id);
  }
}
