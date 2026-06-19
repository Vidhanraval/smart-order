import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { FlowTokenPayload } from './dto/flows.dto';

// ── Types ─────────────────────────────────────────────────────────

interface EncryptedRequest {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
}

interface DecryptedPayload {
  version: string;
  action: string;
  screen?: string;
  data?: Record<string, unknown>;
  flow_token?: string;
}

interface FlowResponse {
  version?: string;
  screen?: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class FlowsService {
  private readonly logger = new Logger(FlowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  // ── Main entry point: decrypt → process → encrypt → return ───

  async handleEncryptedRequest(body: EncryptedRequest): Promise<string> {
    // 1. Decrypt the incoming request
    const { decrypted, aesKey, iv } = this.decryptRequest(body);
    this.logger.log(`Flow: action=${decrypted.action} screen=${decrypted.screen}`);

    // 2. Process based on action
    let response: FlowResponse;
    switch (decrypted.action) {
      case 'ping':
        response = { version: '3.0', data: { status: 'active' } };
        break;
      case 'INIT':
        response = await this.handleInit(decrypted);
        break;
      case 'data_exchange':
        response = await this.handleDataExchange(decrypted);
        break;
      default:
        this.logger.warn(`Unknown flow action: ${decrypted.action}`);
        response = { version: '3.0', screen: 'EDIT_ITEM', data: { error_message: 'Unknown action' } };
    }

    // 3. Encrypt and return response
    this.logger.log(`Flow response: screen=${response.screen}`);
    return this.encryptResponse(response, aesKey, iv);
  }

  // ── Decryption ──────────────────────────────────────────────────

  private decryptRequest(body: EncryptedRequest): {
    decrypted: DecryptedPayload;
    aesKey: Buffer;
    iv: Buffer;
  } {
    const privateKeyPem = this.configService.get<string>('whatsapp.flowPrivateKey') ?? '';
    if (!privateKeyPem) {
      throw new BadRequestException('Flow private key not configured');
    }

    const encryptedFlowData = Buffer.from(body.encrypted_flow_data, 'base64');
    const encryptedAesKey = Buffer.from(body.encrypted_aes_key, 'base64');
    const iv = Buffer.from(body.initial_vector, 'base64');

    // Decrypt AES key with RSA private key
    const privateKey = crypto.createPrivateKey({
      key: privateKeyPem,
      format: 'pem',
      type: 'pkcs1',
    });

    const aesKey = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      encryptedAesKey,
    );

    // Decrypt flow data with AES-128-GCM
    const TAG_LENGTH = 16;
    const encryptedBody = encryptedFlowData.subarray(0, -TAG_LENGTH);
    const authTag = encryptedFlowData.subarray(-TAG_LENGTH);

    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encryptedBody),
      decipher.final(),
    ]);

    const payload = JSON.parse(decrypted.toString('utf8')) as DecryptedPayload;
    return { decrypted: payload, aesKey, iv };
  }

  // ── Encryption ──────────────────────────────────────────────────

  private encryptResponse(
    response: FlowResponse,
    aesKey: Buffer,
    iv: Buffer,
  ): string {
    // Flip the IV (Meta spec)
    const flippedIv = Buffer.from(iv.map((b) => b ^ 0xff));

    const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
    const json = JSON.stringify(response);

    const encrypted = Buffer.concat([
      cipher.update(json, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);

    return encrypted.toString('base64');
  }

  // ── INIT: WhatsApp opens the flow → return prefilled data ───

  private async handleInit(payload: DecryptedPayload): Promise<FlowResponse> {
    const flowToken = (payload.data?.flow_token || payload.flow_token) as string | undefined;

    if (!flowToken) {
      this.logger.warn('INIT with no flow_token');
      return { version: '3.0', screen: 'EDIT_ITEM', data: { error_message: 'Missing flow_token' } };
    }

    let ctx: FlowTokenPayload;
    try {
      ctx = this.decodeFlowToken(flowToken);
    } catch {
      return { version: '3.0', screen: 'EDIT_ITEM', data: { flow_token: flowToken, error_message: 'Invalid session' } };
    }

    // Expire after 15 minutes
    if (Date.now() - ctx.iat > 15 * 60 * 1000) {
      return { version: '3.0', screen: 'EDIT_ITEM', data: { flow_token: flowToken, error_message: 'Session expired. Please try again.' } };
    }

    const item = await this.prisma.orderItem.findUnique({
      where: { id: ctx.itemId },
    });

    if (!item) {
      this.logger.warn(`INIT: item ${ctx.itemId} not found, using payload prefill data`);
      // Return prefill data from the flow message (payload.data) instead of error
      return {
        version: '3.0',
        screen: 'EDIT_ITEM',
        data: {
          item_name: (payload.data?.item_name as string) ?? '',
          item_price: (payload.data?.item_price as string) ?? '',
          item_quantity: (payload.data?.item_quantity as string) ?? '1',
          flow_token: flowToken,
        },
      };
    }

    return {
      version: '3.0',
      screen: 'EDIT_ITEM',
      data: {
        item_name: item.name,
        item_price: item.estimatedPrice?.toString() ?? '',
        item_quantity: item.quantity.toString(),
        flow_token: flowToken,
      },
    };
  }

  // ── data_exchange: user tapped "Save Changes" → validate + update ──

  private async handleDataExchange(payload: DecryptedPayload): Promise<FlowResponse> {
    const rawData = (payload.data ?? {}) as Record<string, unknown>;

    // flow_token comes from the payload (sent via data_exchange footer)
    const flowToken = (rawData.flow_token || payload.flow_token) as string | undefined;

    if (!flowToken) {
      return { version: '3.0', screen: 'EDIT_ITEM', data: { error_message: 'Missing flow_token' } };
    }

    let ctx: FlowTokenPayload;
    try {
      ctx = this.decodeFlowToken(flowToken);
    } catch {
      return { version: '3.0', screen: 'EDIT_ITEM', data: { flow_token: flowToken, error_message: 'Invalid session' } };
    }

    if (Date.now() - ctx.iat > 15 * 60 * 1000) {
      return { version: '3.0', screen: 'EDIT_ITEM', data: { flow_token: flowToken, error_message: 'Session expired. Please try again.' } };
    }

    // Extract form values from wherever Meta puts them
    const searchData: Record<string, unknown> = {
      ...(payload.data ?? {}),
    };
    for (const [key, val] of (Object.entries(payload) as [string, unknown][])) {
      if (typeof val === 'string' && !(key in searchData)) {
        searchData[key] = val;
      }
    }
    const formData = this.extractFormData(searchData);

    const name = (formData.item_name ?? '').trim();
    const priceStr = (formData.item_price ?? '').trim();
    const quantityStr = (formData.item_quantity ?? '').trim();
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
      return {
        version: '3.0',
        screen: 'EDIT_ITEM',
        data: {
          item_name: name || formData.item_name || '',
          item_price: priceStr || formData.item_price || '',
          item_quantity: quantityStr || formData.item_quantity || '',
          flow_token: flowToken,
          error_message: Object.values(errors).join('. '),
        },
      };
    }

    // Update DB
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
      this.logger.log(
        `Flow edit saved: item=${ctx.itemId} name="${name}" price=${price} qty=${quantity}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as any)?.code as string | undefined;
      if (code === 'P2025') {
        // Record not found — try to create instead (upsert behavior)
        if (ctx.orderId) {
          try {
            // Ensure the order exists (create if needed)
            let order = await this.prisma.order.findUnique({ where: { id: ctx.orderId } });
            if (!order) {
              const seller = await this.prisma.seller.findUnique({ where: { phoneNumber: ctx.phone } });
              if (!seller) {
                return { version: '3.0', screen: 'EDIT_ITEM', data: { flow_token: flowToken, error_message: 'Seller not found.' } };
              }
              // Find or create customer
              let customer = await this.prisma.customer.findUnique({ where: { phoneNumber: ctx.phone } });
              if (!customer) {
                customer = await this.prisma.customer.create({ data: { phoneNumber: ctx.phone, name: ctx.phone } });
              }
              order = await this.prisma.order.create({
                data: { id: ctx.orderId, customerId: customer.id, sellerId: seller.id, status: 'ACTIVE' },
              });
              this.logger.log(`Flow: created order ${order.id} for item creation`);
            }
            const created = await this.prisma.orderItem.create({
              data: {
                id: ctx.itemId,
                orderId: ctx.orderId,
                name: name,
                quantity: !isNaN(quantity) && quantity >= 1 ? quantity : 1,
                estimatedPrice: !isNaN(price) && price > 0 ? price : null,
                status: 'PENDING',
              },
            });
            this.logger.log(`Flow edit created item: ${created.id} name="${name}"`);
            // Fall through to SUCCESS below
          } catch (createErr: unknown) {
            const cMsg = createErr instanceof Error ? createErr.message : String(createErr);
            this.logger.error(`Flow create also failed: ${cMsg}`);
            return { version: '3.0', screen: 'EDIT_ITEM', data: { flow_token: flowToken, error_message: `Could not save. ${cMsg}` } };
          }
        } else {
          this.logger.warn(`Flow update: item ${ctx.itemId} not found and no orderId in token`);
          return { version: '3.0', screen: 'EDIT_ITEM', data: { flow_token: flowToken, error_message: 'Item no longer exists.' } };
        }
      } else {
        this.logger.error(`Flow update failed: ${msg}`);
        return { version: '3.0', screen: 'EDIT_ITEM', data: { flow_token: flowToken, error_message: `Could not save. ${msg}` } };
      }
    }

    // Stay on EDIT_ITEM — Meta Flows data_exchange screen navigation is unreliable
    this.logger.log(`Flow edit saved: item=${ctx.itemId} name="${name}" price=${price} qty=${quantity}`);
    return {
      version: '3.0',
      screen: 'EDIT_ITEM',
      data: {
        item_name: name,
        item_price: priceStr || formData.item_price || '',
        item_quantity: quantityStr || formData.item_quantity || '1',
        flow_token: flowToken,
        error_message: '✅ Changes Saved!',
      },
    };
  }

  // ── Form data extraction ─────────────────────────────────────────

  /**
   * Meta may send form data in various nested structures.
   * This recursively searches all levels for the form field values.
   */
  private extractFormData(data: Record<string, unknown>): Record<string, string> {
    const skipKeys = new Set(['flow_token', 'screen', 'error_message']);
    const result: Record<string, string> = {};

    const search = (obj: Record<string, unknown>) => {
      for (const [key, val] of Object.entries(obj)) {
        if (skipKeys.has(key)) continue;

        if (typeof val === 'string') {
          if (key === 'item_name' || key === 'item_price' || key === 'item_quantity') {
            result[key] = val;
          }
        } else if (typeof val === 'number') {
          // Meta may send numeric fields as numbers even when declared as string type
          if (key === 'item_price' || key === 'item_quantity') {
            result[key] = val.toString();
          }
        } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          search(val as Record<string, unknown>);
        }
      }
    };

    search(data);
    return result;
  }

  // ── Token encoding/decoding ──────────────────────────────────────

  encodeFlowToken(ctx: Omit<FlowTokenPayload, 'iat' | 'v'>): string {
    const payload: FlowTokenPayload = { ...ctx, v: 1, iat: Date.now() };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  decodeFlowToken(token: string): FlowTokenPayload {
    let json: string;
    try {
      json = Buffer.from(token, 'base64url').toString('utf8');
      if (!json.startsWith('{')) throw new Error('not json');
    } catch {
      try {
        json = Buffer.from(token, 'base64').toString('utf8');
        if (!json.startsWith('{')) throw new Error('not json');
      } catch {
        json = token;
      }
    }

    let payload: unknown;
    try {
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
