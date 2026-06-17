import { Controller, Post, Get, Body, Res, HttpCode, Logger } from '@nestjs/common';
import { Response } from 'express';
import { FlowsService } from './flows.service';

@Controller('flows')
export class FlowsController {
  private readonly logger = new Logger(FlowsController.name);

  constructor(private readonly flowsService: FlowsService) {}

  @Post('data-exchange')
  @HttpCode(200)
  async dataExchange(
    @Body() body: { encrypted_flow_data: string; encrypted_aes_key: string; initial_vector: string },
    @Res() res: Response,
  ): Promise<void> {
    this.logger.log('Flow data-exchange request received');
    try {
      const encryptedResponse = await this.flowsService.handleEncryptedRequest(body);
      res.setHeader('Content-Type', 'text/plain');
      res.send(encryptedResponse);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Flow data-exchange error: ${msg}`);
      res.status(421).send('Decryption failed');
    }
  }

  @Get('health')
  health() {
    return { data: { status: 'active' } };
  }
}
