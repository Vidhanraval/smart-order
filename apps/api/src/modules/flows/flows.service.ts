import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  FlowDataExchangeRequest,
  FlowDataExchangeResponse,
  FlowTokenPayload,
} from './dto/flows.dto';

@Injectable()
export class FlowsService {
  private readonly logger = new Logger(FlowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  // ── Main entry point for Meta Flows data-exchange endpoint ───

  async handleDataExchange(
    body: FlowDataExchangeRequest,
  ): Promise<FlowDataExchangeResponse> {
    this.logger.log(`Flow data-exchange: action=${body.action}`);

    if (body.action === 'INIT') {
      return this.handleInit(body);
    }
    if (body.action === 'data_exchange') {
      return this.handleDataExchangeAction(body);
    }
    return { action: 'error', error: 'Unknown action' };
  }

  // ── INIT: WhatsApp opens the flow → return prefilled data ───

  private async handleInit(
    body: FlowDataExchangeRequest,
  ): Promise<FlowDataExchangeResponse> {
    const flowToken = (body.data?.flow_token ??
      body.flow_token) as string | undefined;

    if (!flowToken) {
      this.logger.warn('INIT with no flow_token');
      return { action: 'error', error: 'Missing flow_token' };
    }

    let ctx: FlowTokenPayload;
    try {
      ctx = this.decodeFlowToken(flowToken);
    } catch {
      this.logger.warn(`Invalid flow_token: ${flowToken.slice(0, 20)}...`);
      return { action: 'error', error: 'Invalid flow_token' };
    }

    // Expire tokens after 15 minutes
    if (Date.now() - ctx.iat > 15 * 60 * 1000) {
      return { action: 'error', error: 'Session expired. Please try editing again.' };
    }

    const item = await this.prisma.orderItem.findUnique({
      where: { id: ctx.itemId },
    });

    if (!item) {
      return { action: 'error', error: 'Item not found. It may have been deleted.' };
    }

    return {
      action: 'INIT',
      data: {
        item_name: item.name,
        item_price: item.estimatedPrice?.toString() ?? '',
        item_quantity: item.quantity.toString(),
      },
    };
  }

  // ── data_exchange: user tapped "Save Changes" → validate + update DB ──

  private async handleDataExchangeAction(
    body: FlowDataExchangeRequest,
  ): Promise<FlowDataExchangeResponse> {
    const data = (body.data ?? {}) as Record<string, string>;
    const flowToken = (data.flow_token ?? body.flow_token) as string | undefined;

    if (!flowToken) {
      return { action: 'error', error: 'Missing flow_token' };
    }

    let ctx: FlowTokenPayload;
    try {
      ctx = this.decodeFlowToken(flowToken);
    } catch {
      return { action: 'error', error: 'Invalid flow_token' };
    }

    if (Date.now() - ctx.iat > 15 * 60 * 1000) {
      return { action: 'error', error: 'Session expired. Please try again.' };
    }

    const name = (data.item_name ?? '').trim();
    const priceStr = (data.item_price ?? '').trim();
    const quantityStr = (data.item_quantity ?? '').trim();
    const price = priceStr ? parseFloat(priceStr) : NaN;
    const quantity = quantityStr ? parseInt(quantityStr, 10) : NaN;

    // Validate
    const errors: Record<string, string> = {};
    if (!name) errors.item_name = 'Name is required';
    if (priceStr && (isNaN(price) || price <= 0))
      errors.item_price = 'Enter a valid price (e.g. 60)';
    if (quantityStr && (isNaN(quantity) || quantity < 1 || quantity > 10))
      errors.item_quantity = 'Quantity must be 1–10';

    if (Object.keys(errors).length > 0) {
      return { action: 'data_exchange', error: errors, data: body.data };
    }

    // Build update
    const updateData: Record<string, unknown> = {};
    if (name) updateData.name = name;
    if (!isNaN(price) && price > 0) updateData.estimatedPrice = price;
    if (!isNaN(quantity) && quantity >= 1 && quantity <= 10)
      updateData.quantity = quantity;

    try {
      await this.prisma.orderItem.update({
        where: { id: ctx.itemId },
        data: updateData,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to update item ${ctx.itemId}: ${msg}`);
      return { action: 'error', error: 'Could not save changes. Please try again.' };
    }

    this.logger.log(
      `Flow edit: item=${ctx.itemId} name="${name}" price=${price} qty=${quantity}`,
    );

    return {
      action: 'data_exchange',
      data: { success: true, item_id: ctx.itemId },
    };
  }

  // ── Token encoding/decoding ──────────────────────────────────────

  /** Encode item context into an opaque token passed through the flow */
  encodeFlowToken(ctx: Omit<FlowTokenPayload, 'iat' | 'v'>): string {
    const payload: FlowTokenPayload = { ...ctx, v: 1, iat: Date.now() };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  /** Decode and validate a flow token. Throws on malformed tokens. */
  decodeFlowToken(token: string): FlowTokenPayload {
    let payload: unknown;
    try {
      const json = Buffer.from(token, 'base64url').toString('utf8');
      payload = JSON.parse(json);
    } catch {
      throw new BadRequestException('Invalid flow_token encoding');
    }

    const p = payload as Record<string, unknown>;
    if (p?.v !== 1 || !p?.itemId || !p?.phone || !p?.action) {
      throw new BadRequestException('Invalid flow_token payload');
    }

    return payload as FlowTokenPayload;
  }
}
