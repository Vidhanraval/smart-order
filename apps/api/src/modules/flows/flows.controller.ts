import { Controller, Post, Get, Body, HttpCode, Logger } from '@nestjs/common';
import { FlowsService } from './flows.service';
import { FlowDataExchangeRequest, FlowDataExchangeResponse } from './dto/flows.dto';

@Controller('flows')
export class FlowsController {
  private readonly logger = new Logger(FlowsController.name);

  constructor(private readonly flowsService: FlowsService) {}

  @Post('data-exchange')
  @HttpCode(200)
  async dataExchange(
    @Body() body: FlowDataExchangeRequest,
  ): Promise<FlowDataExchangeResponse> {
    this.logger.log(`Flow data-exchange: action=${body.action}`);
    try {
      return await this.flowsService.handleDataExchange(body);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Flow data-exchange error: ${msg}`);
      return { action: 'error', error: 'Internal server error' };
    }
  }

  @Get('health')
  health() {
    return { status: 'ok', message: 'Flows data-exchange endpoint is live' };
  }
}
