import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { OrdersService } from '../orders/orders.service';
import { CustomersService } from '../customers/customers.service';
import { SellersService } from '../sellers/sellers.service';
import { WhatsAppMessage, WhatsAppWebhookPayload } from './dto/whatsapp-webhook.dto';
import {
  buildOrderReviewList,
  buildPackingSlip,
  buildPackItemPrompt,
  buildReplacementReview,
  buildPickupReady,
} from './interactive-messages';
import axios from 'axios';

type InteractiveMessage =
  | { type: 'list'; header?: object; body: object; footer?: object; action: object }
  | { type: 'button'; header?: object; body: object; footer?: object; action: object };

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  // V1 in-memory pending actions: phoneNumber → { action, itemId }
  private readonly pendingActions = new Map<string, { action: string; itemId: string }>();

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly ordersService: OrdersService,
    private readonly customersService: CustomersService,
    private readonly sellersService: SellersService,
  ) {}

  // ── Webhook verification ─────────────────────────────────────────

  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    const verifyToken = this.configService.get<string>('whatsapp.verifyToken');
    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('Webhook verified');
      return challenge;
    }
    return null;
  }

  // ── Incoming message handler ──────────────────────────────────────

  async handleIncoming(payload: WhatsAppWebhookPayload): Promise<void> {
    if (payload.object !== 'whatsapp_business_account') return;

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;
        const { messages, contacts } = change.value;
        if (!messages || messages.length === 0) continue;

        for (const message of messages) {
          await this.processMessage(message, contacts?.[0]?.profile?.name);
        }
      }
    }
  }

  private async processMessage(message: WhatsAppMessage, senderName?: string): Promise<void> {
    const from = message.from;
    const sellerPhone = this.configService.get<string>('seller.phoneNumber') ?? '';

    // Route based on message type (DB operations are inside try-catch)
    try {
      // Deduplicate: skip if this message was already processed (Meta retries)
      const existing = await this.prisma.message.findUnique({
        where: { waMessageId: message.id },
      });
      if (existing) {
        this.logger.debug(`Skipping duplicate message ${message.id}`);
        return;
      }

      // Store inbound message
      await this.prisma.message.create({
        data: {
          waMessageId: message.id,
          from,
          to: sellerPhone,
          direction: 'INBOUND',
          body: message.text?.body ?? message.button?.text ?? message.interactive?.button_reply?.title ?? null,
          mediaId: message.image?.id ?? message.audio?.id ?? null,
          mediaType: message.type === 'image' ? 'image' : message.type === 'audio' ? 'audio' : null,
        },
      });

      // Check for interactive reply (button or list)
      if (message.type === 'interactive') {
        await this.handleInteractiveReply(from, message);
        return;
      }

      // Check for pending context (replacement response, edit, etc.)
      if (message.type === 'text' && message.text?.body) {
        const handled = await this.handleContextualReply(from, message.text.body);
        if (!handled) {
          await this.handleNewOrderInput(from, message.text.body, null, senderName);
        }
      } else if (message.type === 'audio' && message.audio?.id) {
        await this.handleAudioOrder(from, message.audio.id, senderName);
      } else if (message.type === 'image' && message.image?.id) {
        await this.handleImageOrder(from, message.image.id, message.image.caption, senderName);
      }
      // Ignore 'button' and other unhandled types silently (status updates, etc.)
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error processing message from ${from}: ${errMsg}`);
      await this.sendText(from, 'Sorry, something went wrong. Please try again or contact the shop directly.');
    }
  }

  // ── New order input handlers ──────────────────────────────────────

  private async handleContextualReply(from: string, text: string): Promise<boolean> {
    // Check for pending action
    const pending = this.pendingActions.get(from);
    if (!pending) return false;

    this.pendingActions.delete(from);

    if (pending.action === 'replacement') {
      await this.handleSellerReplacement(from, pending.itemId, text);
      return true;
    }

    if (pending.action === 'edit') {
      // Parse edit: "Name, Quantity, Unit, Price"
      const parts = text.split(',').map((p) => p.trim());
      const name = parts[0];
      const quantity = parseInt(parts[1] ?? '1', 10) || 1;
      const unit = parts[2] ?? 'pcs';
      const price = parseFloat(parts[3] ?? '0') || 0;

      await this.prisma.orderItem.update({
        where: { id: pending.itemId },
        data: { name, quantity, unit, estimatedPrice: price },
      });

      // Resend updated review
      const item = await this.prisma.orderItem.findUnique({
        where: { id: pending.itemId },
        include: { order: { include: { items: true } } },
      });

      if (item) {
        const reviewList = buildOrderReviewList(item.orderId, item.order.items ?? []);
        await this.sendInteractive(from, reviewList);
      }

      await this.sendText(from, `✅ Updated to: ${name}, ${quantity} ${unit}, ₹${price}`);
      return true;
    }

    return false;
  }

  private async handleNewOrderInput(
    from: string,
    text: string,
    mediaUrl: string | null,
    senderName?: string,
  ) {
    await this.sendText(from, '🔍 Parsing your order... Please wait a moment.');

    const parsed = await this.aiService.parseText(text);
    await this.createOrderAndSendReview(from, parsed, text, senderName);
  }

  private async handleAudioOrder(from: string, mediaId: string, senderName?: string) {
    await this.sendText(from, '🎤 Transcribing your voice note...');

    const audioBuffer = await this.downloadMedia(mediaId);
    const parsed = await this.aiService.parseVoiceNote(audioBuffer);
    await this.createOrderAndSendReview(from, parsed, null, senderName);
  }

  private async handleImageOrder(
    from: string,
    mediaId: string,
    caption?: string,
    senderName?: string,
  ) {
    await this.sendText(from, '📷 Reading your shopping list...');

    const imageBuffer = await this.downloadMedia(mediaId);
    const imageUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
    const parsed = await this.aiService.parseImage(imageUrl, caption);
    await this.createOrderAndSendReview(from, parsed, caption ?? null, senderName);
  }

  private async createOrderAndSendReview(
    from: string,
    parsed: { items: Array<{ name: string; quantity: number; unit: string; estimatedPrice: number }>; detectedLanguage: string },
    originalInput: string | null,
    senderName?: string,
  ) {
    const sellerPhone = this.configService.get<string>('seller.phoneNumber') ?? '';
    const customer = await this.customersService.findOrCreate(from, senderName);
    const seller = await this.sellersService.findOrCreate(sellerPhone, 'Local Shop');

    const order = await this.ordersService.createFromParsed(
      customer.id,
      seller.id,
      parsed,
      originalInput ?? undefined,
    );

    const reviewList = buildOrderReviewList(order.id, order.items ?? []);
    await this.sendInteractive(from, reviewList);
  }

  // ── Interactive reply handler ─────────────────────────────────────

  private async handleInteractiveReply(from: string, message: WhatsAppMessage) {
    const replyId =
      message.interactive?.button_reply?.id ??
      message.interactive?.list_reply?.id;

    if (!replyId) return;

    this.logger.log(`Interactive reply: ${replyId} from ${from}`);

    // edit_<itemId> — Buyer wants to edit an item
    if (replyId.startsWith('edit_')) {
      const itemId = replyId.replace('edit_', '');
      const item = await this.prisma.orderItem.findUnique({ where: { id: itemId } });
      await this.sendText(
        from,
        `Editing: ${item?.name ?? 'item'}\n\nPlease reply with:\nName, Quantity, Unit, Price\n\nExample: "Atta, 5, kg, 300"`,
      );
      this.pendingActions.set(from, { action: 'edit', itemId });
      return;
    }

    // confirm_<orderId> — Buyer confirms order
    if (replyId.startsWith('confirm_')) {
      const orderId = replyId.replace('confirm_', '');
      await this.confirmOrder(orderId);
      return;
    }

    // found_<itemId> — Seller found the item
    if (replyId.startsWith('found_')) {
      const itemId = replyId.replace('found_', '');
      await this.markItemFound(from, itemId);
      return;
    }

    // notfound_<itemId> — Seller didn't find the item
    if (replyId.startsWith('notfound_')) {
      const itemId = replyId.replace('notfound_', '');
      await this.markItemNotFound(from, itemId);
      return;
    }

    // accept_<itemId> — Buyer accepts replacement
    if (replyId.startsWith('accept_')) {
      const itemId = replyId.replace('accept_', '');
      await this.acceptReplacement(from, itemId);
      return;
    }

    // skip_<itemId> — Buyer skips replacement
    if (replyId.startsWith('skip_')) {
      const itemId = replyId.replace('skip_', '');
      await this.skipReplacement(from, itemId);
      return;
    }

    // pack_<itemId> — Seller wants to pack this item
    if (replyId.startsWith('pack_')) {
      const itemId = replyId.replace('pack_', '');
      await this.promptPackItem(from, itemId);
      return;
    }

    // finalize_<orderId> — Seller finished packing
    if (replyId.startsWith('finalize_')) {
      const orderId = replyId.replace('finalize_', '');
      await this.finalizeOrder(from, orderId);
      return;
    }
  }

  // ── Order actions ─────────────────────────────────────────────────

  private async confirmOrder(orderId: string) {
    await this.ordersService.transitionStatus(orderId, 'SUBMITTED');
    const order = await this.ordersService.findById(orderId);
    const seller = order.seller;

    // Notify buyer
    await this.sendText(
      order.customer.phoneNumber,
      `✅ Order confirmed! Your order has been sent to the shop.\n\nWe'll notify you once packing begins.`,
    );

    // Notify seller with packing slip
    await this.sendText(
      seller.phoneNumber,
      `🛒 New Order from ${order.customer.name ?? order.customer.phoneNumber}!\n\n` +
        `Items: ${order.items?.length ?? 0}\n` +
        `Order #${order.id.slice(-6).toUpperCase()}`,
    );

    // Start packing
    await this.ordersService.transitionStatus(orderId, 'PACKING');
    const updatedOrder = await this.ordersService.findById(orderId);
    const packingSlip = buildPackingSlip(orderId, updatedOrder.items ?? []);
    await this.sendInteractive(seller.phoneNumber, packingSlip);
  }

  private async promptPackItem(sellerPhone: string, itemId: string) {
    const item = await this.prisma.orderItem.findUnique({ where: { id: itemId } });
    if (!item) return;
    const prompt = buildPackItemPrompt(item);
    await this.sendInteractive(sellerPhone, prompt);
  }

  private async markItemFound(sellerPhone: string, itemId: string) {
    await this.ordersService.updateItemStatus(itemId, 'FOUND');
    await this.sendText(sellerPhone, '✅ Marked as found!');

    // Resend updated packing slip
    const item = await this.prisma.orderItem.findUnique({
      where: { id: itemId },
      include: { order: { include: { items: true } } },
    });
    if (item) {
      const packingSlip = buildPackingSlip(item.orderId, item.order.items ?? []);
      await this.sendInteractive(sellerPhone, packingSlip);
    }
  }

  private async markItemNotFound(sellerPhone: string, itemId: string) {
    await this.ordersService.updateItemStatus(itemId, 'NOT_FOUND');
    await this.sendText(
      sellerPhone,
      'Please reply with the suggested replacement:\nName, Price\n\nExample: "Aashirvaad Atta, 65"',
    );
    this.pendingActions.set(sellerPhone, { action: 'replacement', itemId });
  }

  // ── Replacement flow ──────────────────────────────────────────────

  async handleSellerReplacement(sellerPhone: string, itemId: string, text: string) {
    // Parse "Name, Price" from text
    const parts = text.split(',').map((p) => p.trim());
    const replacementName = parts[0] ?? 'Replacement Item';
    const replacementPrice = parseFloat(parts[1] ?? '0') || 0;

    await this.ordersService.addReplacement(itemId, replacementName, replacementPrice);

    const item = await this.prisma.orderItem.findUnique({
      where: { id: itemId },
      include: { order: { include: { customer: true } } },
    });

    if (!item) return;

    // Move order to awaiting replacement
    await this.ordersService.transitionStatus(item.orderId, 'AWAITING_REPLACEMENT');

    // Notify buyer
    const replacementMsg = buildReplacementReview(
      item.orderId,
      item,
      replacementName,
      replacementPrice,
    );
    await this.sendInteractive(item.order.customer.phoneNumber, replacementMsg);

    await this.sendText(sellerPhone, `Replacement suggested and sent to customer for approval.`);
  }

  private async acceptReplacement(buyerPhone: string, itemId: string) {
    const item = await this.prisma.orderItem.findUnique({
      where: { id: itemId },
      include: { order: true },
    });
    if (!item) return;

    await this.ordersService.acceptReplacementWithPrice(
      itemId,
      item.replacementName ?? item.name,
      item.replacementPrice ?? item.estimatedPrice ?? 0,
    );

    await this.sendText(buyerPhone, '✅ Replacement accepted!');

    // Resume packing for seller
    await this.ordersService.transitionStatus(item.orderId, 'PACKING');
    const seller = await this.prisma.order.findUnique({
      where: { id: item.orderId },
      include: { seller: true, items: true },
    });

    if (seller) {
      await this.sendText(seller.seller.phoneNumber, `Customer accepted replacement for "${item.name}".`);
      const packingSlip = buildPackingSlip(item.orderId, seller.items ?? []);
      await this.sendInteractive(seller.seller.phoneNumber, packingSlip);
    }
  }

  private async skipReplacement(buyerPhone: string, itemId: string) {
    const item = await this.prisma.orderItem.findUnique({
      where: { id: itemId },
      include: { order: true },
    });
    if (!item) return;

    await this.ordersService.skipReplacement(itemId);
    await this.sendText(buyerPhone, 'Item skipped — will be removed from your order.');

    // Resume packing for seller
    await this.ordersService.transitionStatus(item.orderId, 'PACKING');
    const seller = await this.prisma.order.findUnique({
      where: { id: item.orderId },
      include: { seller: true, items: true },
    });

    if (seller) {
      await this.sendText(seller.seller.phoneNumber, `Customer skipped "${item.name}".`);
      const packingSlip = buildPackingSlip(item.orderId, seller.items ?? []);
      await this.sendInteractive(seller.seller.phoneNumber, packingSlip);
    }
  }

  // ── Finalization ──────────────────────────────────────────────────

  private async finalizeOrder(sellerPhone: string, orderId: string) {
    const finalized = await this.ordersService.finalizeTotal(orderId);
    const total = finalized.totalPrice ?? 0;

    await this.ordersService.transitionStatus(orderId, 'READY_FOR_PICKUP');

    const order = await this.ordersService.findById(orderId);
    const message = buildPickupReady(
      order.customer.name ?? '',
      total,
      order.items ?? [],
    );

    await this.sendText(order.customer.phoneNumber, message);
    await this.sendText(sellerPhone, `Order finalized! Total: ₹${total}. Customer notified for pickup.`);

    await this.ordersService.transitionStatus(orderId, 'COMPLETED');
  }

  // ── WhatsApp Cloud API send methods ───────────────────────────────

  async sendText(to: string, text: string): Promise<string | null> {
    try {
      const phoneNumberId = this.configService.get<string>('whatsapp.phoneNumberId');
      const accessToken = this.configService.get<string>('whatsapp.accessToken');

      const { data } = await axios.post(
        `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body: text },
        },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
      );

      const waMessageId = data.messages?.[0]?.id;
      if (waMessageId && phoneNumberId) {
        await this.prisma.message.create({
          data: {
            waMessageId,
            from: phoneNumberId,
            to,
            direction: 'OUTBOUND',
            body: text,
          },
        });
      }

      return waMessageId;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send text to ${to}: ${message}`);
      return null;
    }
  }

  async sendInteractive(to: string, interactive: InteractiveMessage): Promise<string | null> {
    try {
      const phoneNumberId = this.configService.get<string>('whatsapp.phoneNumberId');
      const accessToken = this.configService.get<string>('whatsapp.accessToken');

      const { data } = await axios.post(
        `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'interactive',
          interactive,
        },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
      );

      const waMessageId = data.messages?.[0]?.id;
      if (waMessageId && phoneNumberId) {
        await this.prisma.message.create({
          data: {
            waMessageId,
            from: phoneNumberId,
            to,
            direction: 'OUTBOUND',
            body: JSON.stringify(interactive),
          },
        });
      }

      return waMessageId;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send interactive to ${to}: ${message}`);
      return null;
    }
  }

  // ── Media handling ────────────────────────────────────────────────

  async downloadMedia(mediaId: string): Promise<Buffer> {
    const accessToken = this.configService.get<string>('whatsapp.accessToken');

    const urlResponse = await axios.get(
      `https://graph.facebook.com/v22.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    const mediaUrl = urlResponse.data.url;

    const mediaResponse = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: 'arraybuffer',
    });

    return Buffer.from(mediaResponse.data);
  }
}
