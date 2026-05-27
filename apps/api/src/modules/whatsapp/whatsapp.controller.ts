import { Controller, Get, Post, Query, Body, Res, HttpCode, Logger } from '@nestjs/common';
import { Response } from 'express';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppWebhookPayload } from './dto/whatsapp-webhook.dto';

@Controller('webhook')
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);

  constructor(private readonly whatsappService: WhatsAppService) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.challenge') challenge: string,
    @Query('hub.verify_token') token: string,
    @Res() res: Response,
  ) {
    const result = this.whatsappService.verifyWebhook(mode, token, challenge);
    if (result) {
      return res.status(200).send(result);
    }
    return res.status(403).send('Verification failed');
  }

  @Post()
  @HttpCode(200)
  async receive(@Body() payload: WhatsAppWebhookPayload) {
    this.logger.log('Received webhook payload');
    try {
      await this.whatsappService.handleIncoming(payload);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Webhook processing failed: ${msg}`);
    }
    return { status: 'ok' };
  }
}
