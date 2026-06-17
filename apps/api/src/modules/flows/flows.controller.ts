import { Controller, Post, Get, Body, HttpCode, Header, Logger, HttpException } from '@nestjs/common';
import { FlowsService } from './flows.service';

@Controller('flows')
export class FlowsController {
  private readonly logger = new Logger(FlowsController.name);

  constructor(private readonly flowsService: FlowsService) {}

  @Get('health')
  health() {
    return { data: { status: 'active' } };
  }

  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  async handleRootFlowRequest(
    @Body() body: { encrypted_flow_data: string; encrypted_aes_key: string; initial_vector: string },
  ): Promise<string> {
    try {
      return await this.flowsService.handleEncryptedRequest(body);
    } catch {
      throw new HttpException('Decryption failed', 421);
    }
  }

  @Post('data-exchange')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  async handleEncryptedRequest(
    @Body() body: { encrypted_flow_data: string; encrypted_aes_key: string; initial_vector: string },
  ): Promise<string> {
    try {
      return await this.flowsService.handleEncryptedRequest(body);
    } catch {
      throw new HttpException('Decryption failed', 421);
    }
  }
}
