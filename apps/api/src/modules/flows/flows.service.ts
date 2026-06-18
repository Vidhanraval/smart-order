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
    this.logger.log(`Flow request: action=${decrypted.action} screen=${decrypted.screen}`);

    // 2. Process based on action
    this.logger.log(`Flow: action=${decrypted.action} screen=${decrypted.screen} dataKeys=${decrypted.data ? Object.keys(decrypted.data).join(',') : 'none'}`);
    let response: FlowResponse;
    switch (decrypted.action) {
      case 'ping':
        response = { data: { status: 'active' } };
        break;
      case 'INIT':
        response = await this.handleInit(decrypted);
        break;
      case 'data_exchange':
        response = await this.handleDataExchange(decrypted);
        break;
      default:
        this.logger.warn(`Unknown flow action: ${decrypted.action}`);
        response = { screen: 'EDIT_ITEM', data: { error_message: 'Unknown action' } };
    }

    // 3. Encrypt and return response
    this.logger.log(`Flow response: screen=${response.screen} dataKeys=${response.data ? Object.keys(response.data).join(',') : 'none'}`);
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
      return { screen: 'EDIT_ITEM', data: { error_message: 'Missing flow_token' } };
    }

    let ctx: FlowTokenPayload;
    try {
      ctx = this.decodeFlowToken(flowToken);
    } catch {
      return { screen: 'EDIT_ITEM', data: { error_message: 'Invalid session' } };
    }

    // Expire after 15 minutes
    if (Date.now() - ctx.iat > 15 * 60 * 1000) {
      return { screen: 'EDIT_ITEM', data: { error_message: 'Session expired. Please try again.' } };
    }

    const item = await this.prisma.orderItem.findUnique({
      where: { id: ctx.itemId },
    });

    if (!item) {
      return { screen: 'EDIT_ITEM', data: { error_message: 'Item not found.' } };
    }

    return {
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

    // Extract flow_token — may be in data.flow_token or top-level payload.flow_token
    const flowToken = (rawData.flow_token || payload.flow_token) as string | undefined;

    if (!flowToken) {
      return { screen: 'EDIT_ITEM', data: { error_message: 'Missing flow_token' } };
    }

    let ctx: FlowTokenPayload;
    try {
      ctx = this.decodeFlowToken(flowToken);
    } catch {
      return { screen: 'EDIT_ITEM', data: { error_message: 'Invalid session' } };
    }

    if (Date.now() - ctx.iat > 15 * 60 * 1000) {
      return { screen: 'EDIT_ITEM', data: { error_message: 'Session expired. Please try again.' } };
    }

    // Extract form values — Meta may send them in several ways:
    //   1. Flat inside data:  payload.data.item_name
    //   2. Nested:            payload.data.edit_form.item_name
    //   3. Top-level:         payload.item_name (with payload.data absent)
    //   4. Double-nested:     payload.data.EDIT_ITEM.edit_form.item_name
    // Merge both payload.data and top-level payload keys for search.
    const searchData: Record<string, unknown> = {
      ...(payload.data ?? {}),
    };
    // Also copy top-level string values (form fields may arrive at payload root)
    for (const [key, val] of (Object.entries(payload) as [string, unknown][])) {
      if (typeof val === 'string' && !(key in searchData)) {
        searchData[key] = val;
      }
    }
    // Also handle the case where form data is at the top level of data.
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
      this.logger.error(`Flow update failed: ${msg}`);
      return { screen: 'EDIT_ITEM', data: { error_message: 'Could not save. Please try again.' } };
    }

    // Fetch updated item for SUCCESS screen
    const item = await this.prisma.orderItem.findUnique({
      where: { id: ctx.itemId },
    });

    return {
      screen: 'SUCCESS',
      data: {
        item_name: item?.name ?? name,
        item_price: item?.estimatedPrice?.toString() ?? priceStr,
        item_quantity: item?.quantity.toString() ?? quantityStr,
      },
    };
  }

  // ── Form data extraction ─────────────────────────────────────────

  /**
   * Meta may send form data in various nested structures:
   *   Flat:     { item_name: "...", item_price: "...", ... }
   *   Form:     { edit_form: { item_name: "...", ... } }
   *   Screen:   { EDIT_ITEM: { edit_form: { item_name: "...", ... } } }
   * This recursively searches all levels for the form field values.
   */
  private extractFormData(data: Record<string, unknown>): Record<string, string> {
    const skipKeys = new Set(['flow_token', 'screen', 'error_message']);
    const result: Record<string, string> = {};

    const search = (obj: Record<string, unknown>) => {
      for (const [key, val] of Object.entries(obj)) {
        if (skipKeys.has(key)) continue;

        if (typeof val === 'string') {
          // Only capture known form fields
          if (key === 'item_name' || key === 'item_price' || key === 'item_quantity') {
            result[key] = val;
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
