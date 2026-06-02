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
  // Triple-tap detector: itemId → { count, firstTap }
  private readonly tapTracker = new Map<string, { count: number; firstTap: number }>();
  private readonly TRIPLE_TAP_WINDOW_MS = 5000; // 5 seconds
  private readonly TRIPLE_TAP_COUNT = 3;

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
        const { messages, contacts, metadata } = change.value;
        if (!messages || messages.length === 0) continue;

        // Extract which business number the buyer messaged
        const sellerPhone = metadata?.display_phone_number ?? '';
        const sellerPhoneNumberId = metadata?.phone_number_id ?? '';

        for (const message of messages) {
          await this.processMessage(
            message,
            contacts?.[0]?.profile?.name,
            sellerPhone,
            sellerPhoneNumberId,
          );
        }
      }
    }
  }

  private async processMessage(
    message: WhatsAppMessage,
    senderName?: string,
    sellerPhone?: string,
    sellerPhoneNumberId?: string,
  ): Promise<void> {
    const from = message.from;

    // Resolve which platform number/ID to use for sending replies
    // metadata.phone_number_id from webhook tells us which platform number the buyer messaged
    const resolvedPhoneNumberId = sellerPhoneNumberId || (this.configService.get<string>('whatsapp.phoneNumberId') ?? '');

    // Seller is resolved later — from store prefix or config fallback.
    // metadata.display_phone_number is the PLATFORM number, not a seller, so we DON'T
    // auto-create a seller from it.
    const resolvedSellerPhone = (this.configService.get<string>('seller.phoneNumber') ?? '');

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
          to: resolvedSellerPhone,
          direction: 'INBOUND',
          body: message.text?.body ?? message.button?.text ?? message.interactive?.button_reply?.title ?? null,
          mediaId: message.image?.id ?? message.audio?.id ?? null,
          mediaType: message.type === 'image' ? 'image' : message.type === 'audio' ? 'audio' : null,
        },
      });

      // Check for interactive reply (button or list)
      if (message.type === 'interactive') {
        await this.handleInteractiveReply(from, message, resolvedPhoneNumberId);
        return;
      }

      // Check for pending context (replacement response, edit, etc.)
      if (message.type === 'text' && message.text?.body) {
        const text = message.text.body.trim();

        // Detect greetings — reply with welcome message instead of parsing as order
        if (this.isGreeting(text)) {
          await this.sendGreeting(from, text, senderName, resolvedPhoneNumberId);
          return;
        }

        // Detect seller registration: "join seller, Store Name"
        if (this.isJoinSeller(text)) {
          await this.handleJoinSeller(from, text);
          return;
        }

        // Extract store name prefix if present: "StoreName: actual items..."
        const storePrefix = this.extractStorePrefix(text);
        let orderSellerPhone = resolvedSellerPhone;
        let orderPhoneNumberId = resolvedPhoneNumberId;

        if (storePrefix) {
          // Look up seller by store name
          const matchedSeller = await this.sellersService.findByStoreName(storePrefix.storeName);
          if (matchedSeller) {
            orderSellerPhone = matchedSeller.phoneNumber;
            orderPhoneNumberId = matchedSeller.phoneNumberId ?? resolvedPhoneNumberId;
            this.logger.log(`Store prefix matched: "${storePrefix.storeName}" → ${orderSellerPhone}`);
          } else {
            // Unknown store — send helpful message
            await this.sendText(
              from,
              `❓ *"${storePrefix.storeName}"* store not found.\n\n` +
                `Please check the store name or just type your shopping list directly.`,
              resolvedPhoneNumberId,
            );
            return;
          }
        }

        const handled = await this.handleContextualReply(from, text, resolvedPhoneNumberId);
        if (!handled) {
          await this.handleNewOrderInput(
            from,
            storePrefix?.text ?? text,
            null,
            senderName,
            orderSellerPhone,
            orderPhoneNumberId,
          );
        }
      } else if (message.type === 'audio' && message.audio?.id) {
        await this.handleAudioOrder(from, message.audio.id, senderName, resolvedSellerPhone, resolvedPhoneNumberId);
      } else if (message.type === 'image' && message.image?.id) {
        await this.handleImageOrder(from, message.image.id, message.image.caption, senderName, resolvedSellerPhone, resolvedPhoneNumberId);
      }
      // Ignore 'button' and other unhandled types silently (status updates, etc.)
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error processing message from ${from}: ${errMsg}`);
      await this.sendText(from, 'Sorry, something went wrong. Please try again or contact the shop directly.', resolvedPhoneNumberId);
    }
  }

  // ── New order input handlers ──────────────────────────────────────

  private async handleContextualReply(from: string, text: string, phoneNumberId?: string): Promise<boolean> {
    // Check for pending action
    const pending = this.pendingActions.get(from);
    if (!pending) return false;

    this.pendingActions.delete(from);

    if (pending.action === 'replacement') {
      await this.handleSellerReplacement(from, pending.itemId, text, phoneNumberId);
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
        await this.sendInteractive(from, reviewList, phoneNumberId);
      }

      await this.sendText(from, `✅ Updated to: ${name}, ${quantity} ${unit}, ₹${price}`, phoneNumberId);
      return true;
    }

    if (pending.action === 'seller_rename') {
      const name = text.trim();
      if (!name) {
        await this.sendText(from, '⚠️ Please reply with the new name.', phoneNumberId);
        this.pendingActions.set(from, { action: 'seller_rename', itemId: pending.itemId });
        return true;
      }

      await this.prisma.orderItem.update({
        where: { id: pending.itemId },
        data: { name },
      });

      const item = await this.prisma.orderItem.findUnique({
        where: { id: pending.itemId },
        include: { order: { include: { items: true } } },
      });

      await this.sendText(from, `✅ Renamed to: ${name}`, phoneNumberId);

      if (item) {
        const packingSlip = buildPackingSlip(item.orderId, item.order.items ?? []);
        await this.sendInteractive(from, packingSlip, phoneNumberId);
      }
      return true;
    }

    if (pending.action === 'seller_edit') {
      // Seller edit: "Name, Price" or "Name - Price" or "Name 40"
      // Clean input: remove ₹, strip trailing chars
      let cleanText = text.replace(/[₹]/g, '').trim();

      // Try splitting by common separators
      let parts: string[] = [];
      if (cleanText.includes(',')) {
        parts = cleanText.split(',').map((p) => p.trim());
      } else if (cleanText.includes(' - ')) {
        parts = cleanText.split(' - ').map((p) => p.trim());
      } else if (cleanText.includes('-')) {
        parts = cleanText.split('-').map((p) => p.trim());
      } else {
        // Try "Name Number" — find last number in text
        const match = cleanText.match(/^(.+?)\s+(\d+\.?\d*)$/);
        if (match) {
          parts = [match[1]!.trim(), match[2]!];
        } else {
          parts = [cleanText, '0'];
        }
      }

      const name = parts[0] || null;
      const price = parseFloat(parts[1] ?? '0') || 0;

      if (!name) {
        await this.sendText(from, '⚠️ Please reply with: Name, Price\n\nExample: "Aashirvaad Atta, 65"', phoneNumberId);
        this.pendingActions.set(from, { action: 'seller_edit', itemId: pending.itemId });
        return true;
      }

      await this.prisma.orderItem.update({
        where: { id: pending.itemId },
        data: { name, estimatedPrice: price },
      });

      const item = await this.prisma.orderItem.findUnique({
        where: { id: pending.itemId },
        include: { order: { include: { items: true } } },
      });

      await this.sendText(from, `✅ Item Updated!\n\n${name} — ₹${price}`, phoneNumberId);

      // Resend updated packing slip
      if (item) {
        const packingSlip = buildPackingSlip(item.orderId, item.order.items ?? []);
        await this.sendInteractive(from, packingSlip, phoneNumberId);
      }

      return true;
    }

    return false;
  }

  private async handleNewOrderInput(
    from: string,
    text: string,
    mediaUrl: string | null,
    senderName?: string,
    sellerPhone?: string,
    phoneNumberId?: string,
  ) {
    await this.sendText(from, '🔍 Parsing your order... Please wait a moment.', phoneNumberId);

    const parsed = await this.aiService.parseText(text);
    await this.createOrderAndSendReview(from, parsed, text, senderName, sellerPhone, phoneNumberId);
  }

  // ── Seller inline price change ────────────────────────────────────

  private async handleSellerPriceChange(sellerPhone: string, itemId: string, price: number, phoneNumberId?: string) {
    const item = await this.prisma.orderItem.findUnique({
      where: { id: itemId },
      include: { order: { include: { items: true } } },
    });
    if (!item) return;

    await this.prisma.orderItem.update({
      where: { id: itemId },
      data: { estimatedPrice: price },
    });

    await this.sendText(sellerPhone, `✅ ${item.name} — ₹${price}`, phoneNumberId);

    // Resend updated packing slip
    const packingSlip = buildPackingSlip(item.orderId, item.order.items ?? []);
    await this.sendInteractive(sellerPhone, packingSlip, phoneNumberId);
  }

  // ── Greeting detection ──────────────────────────────────────────
  // Categorised so each greeting type gets a contextual reply

  private readonly GREETING_WELCOME = [
    'hi', 'hii', 'hiii', 'hello', 'hey', 'heyy', 'heyyy',
    'namaste', 'namaskar', 'namaskaram', 'vanakkam',
    'ram ram', 'jai shri ram', 'jai shree ram', 'radhe radhe',
    'salam', 'as-salamu alaykum', 'assalamualaikum', 'adaab',
    'ola', 'hola',
  ];

  private readonly GREETING_WELLNESS = [
    'kaise ho', 'kaise hai', 'kaisi ho', 'kaisi hai',
    'kya haal', 'kya haal hai', 'kesi ho', 'kaise ho aap',
    'aur batao', 'aur batao kya haal', 'kya chal raha',
  ];

  private readonly GREETING_MORNING = [
    'good morning', 'suprabhat', 'shubh prabhat', 'gd mrng', 'gm',
  ];

  private readonly GREETING_AFTERNOON = [
    'good afternoon',
  ];

  private readonly GREETING_EVENING = [
    'good evening',
  ];

  private readonly GREETING_NIGHT = [
    'good night', 'gn',
  ];

  private readonly GREETING_CASUAL = [
    'yo', 'yo yo', 'sup', 'wsg',
  ];

  private readonly ALL_GREETINGS: string[] = [
    ...this.GREETING_WELCOME,
    ...this.GREETING_WELLNESS,
    ...this.GREETING_MORNING,
    ...this.GREETING_AFTERNOON,
    ...this.GREETING_EVENING,
    ...this.GREETING_NIGHT,
    ...this.GREETING_CASUAL,
  ];

  private matchGreeting(text: string): string | null {
    const cleaned = text.toLowerCase().replace(/[!?.]+$/, '').trim();
    if (cleaned.length <= 1) return 'welcome';
    for (const g of this.ALL_GREETINGS) {
      if (cleaned === g || cleaned.startsWith(g)) return g;
    }
    return null;
  }

  private isGreeting(text: string): boolean {
    return this.matchGreeting(text) !== null;
  }

  private async sendGreeting(to: string, text: string, senderName?: string, phoneNumberId?: string): Promise<void> {
    // Ensure the buyer's number is stored in the DB even if they only send a greeting
    await this.customersService.findOrCreate(to, senderName);

    const lower = text.toLowerCase().replace(/[!?.]+$/, '').trim();

    if (this.GREETING_WELLNESS.some((g) => lower === g || lower.startsWith(g))) {
      await this.sendText(to, '🙏 Main theek hoon, shukriya! Aap batao, aaj kya shopping karna chahoge?', phoneNumberId);
      return;
    }

    if (this.GREETING_MORNING.some((g) => lower === g || lower.startsWith(g))) {
      await this.sendText(to, '☀️ Shubh prabhat! aaj ka din subh ho aapka. Aaj kya shopping karna pasand karoge aap.', phoneNumberId);
      return;
    }

    if (this.GREETING_AFTERNOON.some((g) => lower === g || lower.startsWith(g))) {
      await this.sendText(to, '🌤️ Good afternoon! Kripya apni shopping list bhejein.', phoneNumberId);
      return;
    }

    if (this.GREETING_EVENING.some((g) => lower === g || lower.startsWith(g))) {
      await this.sendText(to, '🌅 Good evening! Aaj kya shopping karna pasand karoge aap.', phoneNumberId);
      return;
    }

    if (this.GREETING_NIGHT.some((g) => lower === g || lower.startsWith(g))) {
      await this.sendText(to, '🌙 Good night! Kal subah 9 baje hamari dukaan khulegi.', phoneNumberId);
      return;
    }

    if (this.GREETING_CASUAL.some((g) => lower === g || lower.startsWith(g))) {
      await this.sendText(to, '😄 Haan ji boliye! Kya shopping karna pasand karoge aaj?', phoneNumberId);
      return;
    }

    // Default welcome (hi, hello, namaste, ram ram, salam, etc.)
    const name = senderName ? ` ${senderName} ji` : '';
    await this.sendText(
      to,
      `🙏 *Namaste${name}!*\n\n` +
      `Hamari dukaan mein aapka swagat hai. 🛒\n\n` +
      `Kripya apni shopping list bhejein, hum foran aapka order taiyar kar denge!`,
      phoneNumberId,
    );
  }

  // ── Seller registration — "join seller, Store Name" ──────────────

  private readonly JOIN_SELLER_PATTERNS = [
    /^join\s+(?:as\s+)?seller[,:\s]+(.+)$/i,
    /^register\s+(?:as\s+)?seller[,:\s]+(.+)$/i,
  ];

  private isJoinSeller(text: string): boolean {
    return this.JOIN_SELLER_PATTERNS.some((p) => p.test(text.trim()));
  }

  private async handleJoinSeller(from: string, text: string): Promise<void> {
    let storeName = 'Local Shop';

    for (const pattern of this.JOIN_SELLER_PATTERNS) {
      const match = text.trim().match(pattern);
      if (match?.[1]) {
        storeName = match[1].trim();
        break;
      }
    }

    // Use the seller's WhatsApp Business number to register them
    const seller = await this.sellersService.upsert(from, undefined, storeName);
    this.logger.log(`Seller registered/updated via WhatsApp: ${from} → ${storeName} (${seller.id})`);

    await this.sendText(
      from,
      `✅ *Registration Successful!*\n\n` +
        `Welcome, *${storeName}*! 🎉\n\n` +
        `Aap seller ke roop mein register ho gaye hain. Ab buyers aapka naam lekar order bhejenge:\n\n` +
        `📝 _${storeName}: Atta 5kg, Chawal 3kg_\n\n` +
        `Jab koi buyer order confirm karega, aapko packing slip yahi bheji jayegi.\n\n` +
        `Happy selling! 🛒`,
    );
  }

  // ── Store name prefix extraction ─────────────────────────────────

  /**
   * Detects "StoreName: rest of order" prefix.
   * Returns the store name and remaining text for routing.
   */
  private extractStorePrefix(text: string): { storeName: string; text: string } | null {
    // Match "StoreName: rest"
    const match = text.match(/^(.+?)\s*[:]\s*(.+)$/);
    if (!match) return null;

    const storeName = match[1]!.trim();
    const rest = match[2]!.trim();

    // Quick check: if the prefix looks like a single item (Qty Unit Name),
    // it's probably not a store name — skip
    if (/^\d/.test(storeName)) return null;
    if (rest.length < 2) return null;

    this.logger.debug(`Detected store prefix: "${storeName}" → rest: "${rest}"`);
    return { storeName, text: rest };
  }

  // ── Audio & Image handlers ──────────────────────────────────────

  private async handleAudioOrder(
    from: string,
    mediaId: string,
    senderName?: string,
    sellerPhone?: string,
    phoneNumberId?: string,
  ) {
    await this.sendText(from, '🎤 Transcribing your voice note...', phoneNumberId);

    const audioBuffer = await this.downloadMedia(mediaId);
    const parsed = await this.aiService.parseVoiceNote(audioBuffer);
    await this.createOrderAndSendReview(from, parsed, null, senderName, sellerPhone, phoneNumberId);
  }

  private async handleImageOrder(
    from: string,
    mediaId: string,
    caption?: string,
    senderName?: string,
    sellerPhone?: string,
    phoneNumberId?: string,
  ) {
    await this.sendText(from, '📷 Reading your shopping list...', phoneNumberId);

    const imageBuffer = await this.downloadMedia(mediaId);
    const imageUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
    const parsed = await this.aiService.parseImage(imageUrl, caption);
    await this.createOrderAndSendReview(from, parsed, caption ?? null, senderName, sellerPhone, phoneNumberId);
  }

  private async createOrderAndSendReview(
    from: string,
    parsed: { items: Array<{ name: string; quantity: number; unit: string; estimatedPrice: number }>; detectedLanguage: string },
    originalInput: string | null,
    senderName?: string,
    sellerPhone?: string,
    phoneNumberId?: string,
  ) {
    // If AI couldn't parse any items, ask user to try again
    if (!parsed.items || parsed.items.length === 0) {
      await this.sendText(
        from,
        'Please send your shopping list like:\n"1 kg atta, 2 pcs soap, 1 kg rice"',
        phoneNumberId,
      );
      return;
    }

    const resolvedSellerPhone = sellerPhone || (this.configService.get<string>('seller.phoneNumber') ?? '');
    const resolvedPhoneNumberId = phoneNumberId || (this.configService.get<string>('whatsapp.phoneNumberId') ?? '');

    const customer = await this.customersService.findOrCreate(from, senderName);
    const seller = await this.sellersService.upsert(resolvedSellerPhone, resolvedPhoneNumberId, 'Local Shop');

    const order = await this.ordersService.createFromParsed(
      customer.id,
      seller.id,
      parsed,
      originalInput ?? undefined,
    );

    const reviewList = buildOrderReviewList(order.id, order.items ?? []);
    await this.sendInteractive(from, reviewList, resolvedPhoneNumberId);
  }

  // ── Interactive reply handler ─────────────────────────────────────

  private async handleInteractiveReply(from: string, message: WhatsAppMessage, phoneNumberId?: string) {
    const replyId =
      message.interactive?.button_reply?.id ??
      message.interactive?.list_reply?.id;

    if (!replyId) return;

    this.logger.log(`Interactive reply: ${replyId} from ${from}`);

    try {
      // edit_<itemId> — Buyer wants to edit an item
      if (replyId.startsWith('edit_')) {
        const itemId = replyId.replace('edit_', '');
        const item = await this.prisma.orderItem.findUnique({ where: { id: itemId } });
        await this.sendText(
          from,
          `Editing: ${item?.name ?? 'item'}\n\nPlease reply with:\nName, Quantity, Unit, Price\n\nExample: "Atta, 5, kg, 300"`,
          phoneNumberId,
        );
        this.pendingActions.set(from, { action: 'edit', itemId });
        return;
      }

      // confirm_<orderId> — Buyer confirms order
      if (replyId.startsWith('confirm_')) {
        const orderId = replyId.replace('confirm_', '');
        await this.confirmOrder(orderId, from, phoneNumberId);
        return;
      }

      // found_<itemId> — Seller found the item
      if (replyId.startsWith('found_')) {
        const itemId = replyId.replace('found_', '');
        await this.markItemFound(from, itemId, phoneNumberId);
        return;
      }

      // notfound_<itemId> — Seller didn't find the item
      if (replyId.startsWith('notfound_')) {
        const itemId = replyId.replace('notfound_', '');
        await this.markItemNotFound(from, itemId, phoneNumberId);
        return;
      }

      // accept_<itemId> — Buyer accepts replacement
      if (replyId.startsWith('accept_')) {
        const itemId = replyId.replace('accept_', '');
        await this.acceptReplacement(from, itemId, phoneNumberId);
        return;
      }

      // skip_<itemId> — Buyer skips replacement
      if (replyId.startsWith('skip_')) {
        const itemId = replyId.replace('skip_', '');
        await this.skipReplacement(from, itemId, phoneNumberId);
        return;
      }

      // price_<itemId>_<amount> — Seller picked a price inline from packing slip
      if (replyId.startsWith('price_')) {
        const parts = replyId.split('_');
        const price = parseFloat(parts.pop()!);
        const itemId = parts.slice(1).join('_');
        await this.handleSellerPriceChange(from, itemId, price, phoneNumberId);
        return;
      }

      // rename_<itemId> — Seller wants to rename (via inline editor)
      if (replyId.startsWith('rename_')) {
        const itemId = replyId.replace('rename_', '');
        const item = await this.prisma.orderItem.findUnique({ where: { id: itemId } });
        if (item) {
          await this.sendText(
            from,
            `✏️ Rename: *${item.name}*\n\nReply with new name:`,
            phoneNumberId,
          );
          this.pendingActions.set(from, { action: 'seller_rename', itemId });
        }
        return;
      }

      // pack_<itemId> — Seller wants to pack this item
      if (replyId.startsWith('pack_')) {
        const itemId = replyId.replace('pack_', '');
        await this.promptPackItem(from, itemId, phoneNumberId);
        return;
      }

      // finalize_<orderId> — Seller finished packing
      if (replyId.startsWith('finalize_')) {
        const orderId = replyId.replace('finalize_', '');
        await this.finalizeOrder(from, orderId, phoneNumberId);
        return;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Action failed for replyId=${replyId} from ${from}: ${msg}`);
      await this.sendText(from, '⚠️ Kuch galat ho gaya. Kripya dubara try karein ya nayi process shuru karein.', phoneNumberId);
    }
  }

  // ── Order actions ─────────────────────────────────────────────────

  private readonly ORDER_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

  private async confirmOrder(orderId: string, buyerPhone: string, phoneNumberId?: string) {
    let order;
    try {
      order = await this.ordersService.findById(orderId);
    } catch {
      await this.sendText(
        buyerPhone,
        '⚠️ Order ab uplabdh nahi hai. Kripya nayi shopping list bhejkar nayi process shuru karein.',
        phoneNumberId,
      );
      return;
    }

    // Use seller's stored phoneNumberId, fall back to passed param
    const sellerPhoneNumberId = order.seller.phoneNumberId ?? phoneNumberId;

    // Check if order has expired (3 minutes since creation)
    const elapsed = Date.now() - order.createdAt.getTime();
    if (elapsed > this.ORDER_TIMEOUT_MS) {
      try {
        await this.ordersService.transitionStatus(orderId, 'EXPIRED');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Could not mark order ${orderId} as EXPIRED (may already be expired): ${msg}`);
      }
      await this.sendText(
        order.customer.phoneNumber,
        '⏰ Aapki shopping process ki samay seema samapt ho chuki hai.\nKripya nayi shopping list bhejkar nayi process shuru karein.',
        sellerPhoneNumberId,
      );
      return;
    }

    await this.ordersService.transitionStatus(orderId, 'SUBMITTED');

    // Fire buyer + seller notifications in parallel — seller gets instant alert
    const buyerMsg = this.sendText(
      order.customer.phoneNumber,
      `✅ Order confirmed! Your order has been sent to the shop.\n\nWe'll notify you once packing begins.`,
      sellerPhoneNumberId,
    );

    const sellerMsg = this.sendText(
      order.seller.phoneNumber,
      `🛒 New Order from ${order.customer.name ?? order.customer.phoneNumber}!\n\n` +
        `Items: ${order.items?.length ?? 0}\n` +
        `Order #${order.id.slice(-6).toUpperCase()}`,
      sellerPhoneNumberId,
    );

    await Promise.all([buyerMsg, sellerMsg]);

    // Start packing and send packing slip
    await this.ordersService.transitionStatus(orderId, 'PACKING');
    const packingSlip = buildPackingSlip(orderId, order.items ?? []);
    await this.sendInteractive(order.seller.phoneNumber, packingSlip, sellerPhoneNumberId);
  }

  private async promptPackItem(sellerPhone: string, itemId: string, phoneNumberId?: string) {
    const item = await this.prisma.orderItem.findUnique({ where: { id: itemId } });
    if (!item) return;

    // Triple-tap detection for inline editing
    const now = Date.now();
    const tracked = this.tapTracker.get(itemId);

    if (tracked && (now - tracked.firstTap) < this.TRIPLE_TAP_WINDOW_MS) {
      tracked.count++;
      if (tracked.count >= this.TRIPLE_TAP_COUNT) {
        // Show inline price and rename editor
        this.tapTracker.delete(itemId);
        await this.showInlineEditor(sellerPhone, item, phoneNumberId);
        return;
      }
    } else {
      // First tap — start tracking
      this.tapTracker.set(itemId, { count: 1, firstTap: now });
    }

    // Normal behavior: show Found / Not Found
    const prompt = buildPackItemPrompt(item);
    await this.sendInteractive(sellerPhone, prompt, phoneNumberId);
  }

  // ── Inline editor (triple-tap) ─────────────────────────────────────

  private async showInlineEditor(
    sellerPhone: string,
    item: { id: string; name: string; estimatedPrice: number | null },
    phoneNumberId?: string,
  ) {
    const price = item.estimatedPrice ?? 50;
    const prices = [price, price + 10, price + 20, price - 10, price + 50].filter((p) => p > 0);

    await this.sendInteractive(
      sellerPhone,
      {
        type: 'list',
        header: { type: 'text', text: `✏️ ${item.name}` },
        body: { text: `Edit price or rename` },
        action: {
          button: 'Edit',
          sections: [
            {
              title: '💰 Quick Price',
              rows: prices.map((p) => ({
                id: `price_${item.id}_${p}`,
                title: p === price ? `₹${p} ✓` : `₹${p}`,
              })),
            },
            {
              title: '✏️ Rename',
              rows: [{ id: `rename_${item.id}`, title: '✏️ Rename Item' }],
            },
          ],
        },
      },
      phoneNumberId,
    );
  }

  private async markItemFound(sellerPhone: string, itemId: string, phoneNumberId?: string) {
    await this.ordersService.updateItemStatus(itemId, 'FOUND');
    await this.sendText(sellerPhone, '✅ Marked as found!', phoneNumberId);

    // Resend updated packing slip
    const item = await this.prisma.orderItem.findUnique({
      where: { id: itemId },
      include: { order: { include: { items: true } } },
    });
    if (item) {
      const packingSlip = buildPackingSlip(item.orderId, item.order.items ?? []);
      await this.sendInteractive(sellerPhone, packingSlip, phoneNumberId);
    }
  }

  private async markItemNotFound(sellerPhone: string, itemId: string, phoneNumberId?: string) {
    await this.ordersService.updateItemStatus(itemId, 'NOT_FOUND');
    await this.sendText(
      sellerPhone,
      'Please reply with the suggested replacement:\nName, Price\n\nExample: "Aashirvaad Atta, 65"',
      phoneNumberId,
    );
    this.pendingActions.set(sellerPhone, { action: 'replacement', itemId });
  }

  // ── Replacement flow ──────────────────────────────────────────────

  async handleSellerReplacement(sellerPhone: string, itemId: string, text: string, phoneNumberId?: string) {
    // Parse "Name, Price" from text
    const parts = text.split(',').map((p) => p.trim());
    const replacementName = parts[0] ?? 'Replacement Item';
    const replacementPrice = parseFloat(parts[1] ?? '0') || 0;

    await this.ordersService.addReplacement(itemId, replacementName, replacementPrice);

    const item = await this.prisma.orderItem.findUnique({
      where: { id: itemId },
      include: { order: { include: { customer: true, items: true } } },
    });

    if (!item) return;

    // Move order to awaiting replacement
    await this.ordersService.transitionStatus(item.orderId, 'AWAITING_REPLACEMENT');

    // Notify buyer with full order context
    const allItems = item.order.items ?? [];
    const replacementMsg = buildReplacementReview(
      allItems,
      item,
      replacementName,
      replacementPrice,
    );
    await this.sendInteractive(item.order.customer.phoneNumber, replacementMsg, phoneNumberId);

    await this.sendText(sellerPhone, `Replacement suggested and sent to customer for approval.`, phoneNumberId);
  }

  private async acceptReplacement(buyerPhone: string, itemId: string, phoneNumberId?: string) {
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

    await this.sendText(buyerPhone, '✅ Replacement accepted!', phoneNumberId);

    // Resume packing for seller
    await this.ordersService.transitionStatus(item.orderId, 'PACKING');
    const seller = await this.prisma.order.findUnique({
      where: { id: item.orderId },
      include: { seller: true, items: true },
    });

    if (seller) {
      const sellerPnId = seller.seller.phoneNumberId ?? phoneNumberId;
      await this.sendText(seller.seller.phoneNumber, `Customer accepted replacement for "${item.name}".`, sellerPnId);
      const packingSlip = buildPackingSlip(item.orderId, seller.items ?? []);
      await this.sendInteractive(seller.seller.phoneNumber, packingSlip, sellerPnId);
    }
  }

  private async skipReplacement(buyerPhone: string, itemId: string, phoneNumberId?: string) {
    const item = await this.prisma.orderItem.findUnique({
      where: { id: itemId },
      include: { order: true },
    });
    if (!item) return;

    await this.ordersService.skipReplacement(itemId);
    await this.sendText(buyerPhone, 'Item skipped — will be removed from your order.', phoneNumberId);

    // Resume packing for seller
    await this.ordersService.transitionStatus(item.orderId, 'PACKING');
    const seller = await this.prisma.order.findUnique({
      where: { id: item.orderId },
      include: { seller: true, items: true },
    });

    if (seller) {
      const sellerPnId = seller.seller.phoneNumberId ?? phoneNumberId;
      await this.sendText(seller.seller.phoneNumber, `Customer skipped "${item.name}".`, sellerPnId);
      const packingSlip = buildPackingSlip(item.orderId, seller.items ?? []);
      await this.sendInteractive(seller.seller.phoneNumber, packingSlip, sellerPnId);
    }
  }

  // ── Finalization ──────────────────────────────────────────────────

  private async finalizeOrder(sellerPhone: string, orderId: string, phoneNumberId?: string) {
    const finalized = await this.ordersService.finalizeTotal(orderId);
    const total = finalized.totalPrice ?? 0;

    await this.ordersService.transitionStatus(orderId, 'READY_FOR_PICKUP');

    const order = await this.ordersService.findById(orderId);
    const sellerPnId = order.seller.phoneNumberId ?? phoneNumberId;
    const message = buildPickupReady(
      order.seller.storeName ?? order.seller.name ?? 'Your Shop',
      total,
      order.items ?? [],
    );

    await this.sendText(order.customer.phoneNumber, message, sellerPnId);
    await this.sendText(sellerPhone, `Order finalized! Total: ₹${total}. Customer notified for pickup.`, sellerPnId);

    await this.ordersService.transitionStatus(orderId, 'COMPLETED');
  }

  // ── WhatsApp Cloud API send methods ───────────────────────────────

  async sendText(to: string, text: string, phoneNumberId?: string): Promise<string | null> {
    try {
      const resolvedPhoneNumberId = phoneNumberId || this.configService.get<string>('whatsapp.phoneNumberId');
      const accessToken = this.configService.get<string>('whatsapp.accessToken');

      const { data } = await axios.post(
        `https://graph.facebook.com/v22.0/${resolvedPhoneNumberId}/messages`,
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
      if (waMessageId && resolvedPhoneNumberId) {
        await this.prisma.message.create({
          data: {
            waMessageId,
            from: resolvedPhoneNumberId,
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

  async sendInteractive(to: string, interactive: InteractiveMessage, phoneNumberId?: string): Promise<string | null> {
    try {
      const resolvedPhoneNumberId = phoneNumberId || this.configService.get<string>('whatsapp.phoneNumberId');
      const accessToken = this.configService.get<string>('whatsapp.accessToken');

      const { data } = await axios.post(
        `https://graph.facebook.com/v22.0/${resolvedPhoneNumberId}/messages`,
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
      if (waMessageId && resolvedPhoneNumberId) {
        await this.prisma.message.create({
          data: {
            waMessageId,
            from: resolvedPhoneNumberId,
            to,
            direction: 'OUTBOUND',
            body: JSON.stringify(interactive),
          },
        });
      }

      return waMessageId;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const detail = (error as any)?.response?.data ? JSON.stringify((error as any).response.data) : '';
      this.logger.error(`Failed to send interactive to ${to}: ${errMsg} ${detail}`);

      // Fallback: send body text as plain text
      const body = interactive.body as { text?: string } | undefined;
      const header = interactive.header as { text?: string } | undefined;
      if (body?.text) {
        try {
          await this.sendText(to, `📋 ${header?.text ?? 'Update'}\n\n${body.text}`, phoneNumberId);
        } catch {}
      }

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
