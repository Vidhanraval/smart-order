import { Injectable, Logger } from '@nestjs/common';

export interface ParsedOrderItem {
  name: string;
  quantity: number;
  unit: string;
  estimatedPrice: number;
}

export interface ParsedOrderResult {
  items: ParsedOrderItem[];
  detectedLanguage: string;
}

// Common Indian grocery items with estimated prices (INR)
const ITEM_PRICES: Record<string, { name: string; price: number; unit: string }> = {
  atta: { name: 'Atta (Wheat Flour)', price: 60, unit: 'kg' },
  'wheat flour': { name: 'Wheat Flour', price: 55, unit: 'kg' },
  sugar: { name: 'Sugar', price: 45, unit: 'kg' },
  chini: { name: 'Sugar', price: 45, unit: 'kg' },
  rice: { name: 'Rice', price: 70, unit: 'kg' },
  chawal: { name: 'Rice', price: 70, unit: 'kg' },
  dal: { name: 'Dal', price: 120, unit: 'kg' },
  'toor dal': { name: 'Toor Dal', price: 140, unit: 'kg' },
  'moong dal': { name: 'Moong Dal', price: 130, unit: 'kg' },
  oil: { name: 'Cooking Oil', price: 160, unit: 'liter' },
  'refined oil': { name: 'Refined Oil', price: 150, unit: 'liter' },
  'mustard oil': { name: 'Mustard Oil', price: 170, unit: 'liter' },
  milk: { name: 'Milk', price: 60, unit: 'liter' },
  doodh: { name: 'Milk', price: 60, unit: 'liter' },
  butter: { name: 'Butter', price: 55, unit: 'pcs' },
  makhan: { name: 'Butter', price: 55, unit: 'pcs' },
  bread: { name: 'Bread', price: 40, unit: 'packet' },
  eggs: { name: 'Eggs', price: 6, unit: 'pcs' },
  anda: { name: 'Eggs', price: 6, unit: 'pcs' },
  maggi: { name: 'Maggi Noodles', price: 28, unit: 'packet' },
  noodles: { name: 'Noodles', price: 30, unit: 'packet' },
  namkeen: { name: 'Namkeen', price: 80, unit: 'packet' },
  'tea powder': { name: 'Tea Powder', price: 200, unit: 'packet' },
  chai: { name: 'Tea Powder', price: 200, unit: 'packet' },
  'chai patti': { name: 'Tea Powder', price: 200, unit: 'packet' },
  coffee: { name: 'Coffee', price: 150, unit: 'packet' },
  salt: { name: 'Salt', price: 20, unit: 'packet' },
  namak: { name: 'Salt', price: 20, unit: 'packet' },
  haldi: { name: 'Turmeric Powder', price: 40, unit: 'packet' },
  turmeric: { name: 'Turmeric Powder', price: 40, unit: 'packet' },
  mirchi: { name: 'Red Chilli Powder', price: 50, unit: 'packet' },
  'chilli powder': { name: 'Red Chilli Powder', price: 50, unit: 'packet' },
  jeera: { name: 'Cumin (Jeera)', price: 80, unit: 'packet' },
  dhaniya: { name: 'Coriander Powder', price: 60, unit: 'packet' },
  garam: { name: 'Garam Masala', price: 90, unit: 'packet' },
  'garam masala': { name: 'Garam Masala', price: 90, unit: 'packet' },
  sabji: { name: 'Vegetables (Mixed)', price: 60, unit: 'kg' },
  vegetables: { name: 'Vegetables (Mixed)', price: 60, unit: 'kg' },
  pyaz: { name: 'Onion', price: 30, unit: 'kg' },
  onion: { name: 'Onion', price: 30, unit: 'kg' },
  'kanda': { name: 'Onion', price: 30, unit: 'kg' },
  tamatar: { name: 'Tomato', price: 40, unit: 'kg' },
  tomato: { name: 'Tomato', price: 40, unit: 'kg' },
  aloo: { name: 'Potato', price: 25, unit: 'kg' },
  potato: { name: 'Potato', price: 25, unit: 'kg' },
  'batata': { name: 'Potato', price: 25, unit: 'kg' },
  soap: { name: 'Soap', price: 35, unit: 'pcs' },
  sabun: { name: 'Soap', price: 35, unit: 'pcs' },
  shampoo: { name: 'Shampoo', price: 120, unit: 'pcs' },
  'tooth paste': { name: 'Toothpaste', price: 70, unit: 'pcs' },
  toothpaste: { name: 'Toothpaste', price: 70, unit: 'pcs' },
  'hand wash': { name: 'Hand Wash', price: 90, unit: 'pcs' },
  detergent: { name: 'Detergent', price: 100, unit: 'packet' },
  'washing powder': { name: 'Washing Powder', price: 60, unit: 'packet' },
  surf: { name: 'Surf Excel', price: 100, unit: 'packet' },
  vim: { name: 'Vim Bar', price: 10, unit: 'pcs' },
  biscuit: { name: 'Biscuits', price: 30, unit: 'packet' },
  biscuits: { name: 'Biscuits', price: 30, unit: 'packet' },
  'amul butter': { name: 'Amul Butter', price: 55, unit: 'pcs' },
  'amul milk': { name: 'Amul Milk', price: 65, unit: 'liter' },
  'toned milk': { name: 'Toned Milk', price: 54, unit: 'liter' },
  'haldiram': { name: 'Haldiram Namkeen', price: 90, unit: 'packet' },
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  async parseText(text: string): Promise<ParsedOrderResult> {
    const items: ParsedOrderItem[] = [];

    // Split by common separators
    const parts = text.split(/[,|&+\n]+/);

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      const item = this.parseSingleItem(trimmed);
      if (item) {
        items.push(item);
      }
    }

    return {
      items,
      detectedLanguage: 'en',
    };
  }

  private parseSingleItem(text: string): ParsedOrderItem | null {
    // Pattern: "quantity unit item_name" e.g., "1 kg atta", "500g sugar", "2 Amul butter"
    // Also: "item_name quantity unit" e.g., "atta 1 kg"
    // Also: just "item_name"

    const lower = text.toLowerCase().trim();

    // Try: number + unit + item
    const qtyFirst = lower.match(/^(\d+\.?\d*)\s*(kg|kgs|kilo|g|grams?|gm|ml|ltr?|liters?|liter|pcs|packet|pack|dozen|piece)\s+(.+)/);
    if (qtyFirst) {
      const rawQty = parseFloat(qtyFirst[1]!);
      const rawUnit = qtyFirst[2]!;
      const itemName = qtyFirst[3]!.trim();
      const { qty, unit } = this.normalizeQtyUnit(rawQty, rawUnit);
      const matched = this.matchItem(itemName, unit);
      return {
        name: matched.name,
        quantity: qty,
        unit,
        estimatedPrice: matched.price, // per-unit price
      };
    }

    // Try: number + item (no unit, e.g., "2 amul butter", "2 eggs")
    const qtyNoUnit = lower.match(/^(\d+\.?\d*)\s+(.+)/);
    if (qtyNoUnit) {
      const qty = parseFloat(qtyNoUnit[1]!);
      const itemName = qtyNoUnit[2]!.trim();
      const matched = this.matchItem(itemName, 'pcs');
      return {
        name: matched.name,
        quantity: qty,
        unit: matched.unit,
        estimatedPrice: matched.price, // per-unit price
      };
    }

    // Try: item name + number + unit (e.g., "atta 1 kg")
    const nameFirst = lower.match(/^(.+?)\s+(\d+\.?\d*)\s*(kg|kgs|kilo|g|grams?|gm|ml|ltr?|liters?|liter|pcs|packet|pack|dozen|piece)?$/);
    if (nameFirst) {
      const itemName = nameFirst[1]!.trim();
      const rawQty = parseFloat(nameFirst[2]!);
      const rawUnit = nameFirst[3] ?? 'pcs';
      const { qty, unit } = this.normalizeQtyUnit(rawQty, rawUnit);
      const matched = this.matchItem(itemName, unit);
      return {
        name: matched.name,
        quantity: qty,
        unit,
        estimatedPrice: matched.price, // per-unit price
      };
    }

    // Just item name, assume qty 1
    if (lower.length > 2) {
      const matched = this.matchItem(lower, 'pcs');
      return {
        name: matched.name,
        quantity: 1,
        unit: matched.unit,
        estimatedPrice: matched.price,
      };
    }

    return null;
  }

  private matchItem(name: string, fallbackUnit: string): { name: string; price: number; unit: string } {
    // Try exact match first
    if (ITEM_PRICES[name]) return ITEM_PRICES[name]!;

    // Try partial match
    for (const [key, value] of Object.entries(ITEM_PRICES)) {
      if (name.includes(key)) {
        return value;
      }
    }

    // Unknown item — use the raw name with first letter capitalized
    const displayName = name.charAt(0).toUpperCase() + name.slice(1);
    return {
      name: displayName,
      price: 50, // default estimate
      unit: fallbackUnit,
    };
  }

  private normalizeQtyUnit(rawQty: number, rawUnit: string): { qty: number; unit: string } {
    const u = rawUnit.toLowerCase().trim();

    // Convert g to kg
    if (['g', 'grams', 'gram', 'gm'].includes(u)) {
      return { qty: rawQty / 1000, unit: 'kg' };
    }
    // Convert ml to liter
    if (['ml'].includes(u)) {
      return { qty: rawQty / 1000, unit: 'liter' };
    }
    // Keep as-is
    if (['kg', 'kgs', 'kilo'].includes(u)) return { qty: rawQty, unit: 'kg' };
    if (['ltr', 'liters', 'liter', 'l', 'litre'].includes(u)) return { qty: rawQty, unit: 'liter' };
    if (['pcs', 'piece', 'pieces'].includes(u)) return { qty: rawQty, unit: 'pcs' };
    if (['packet', 'pack'].includes(u)) return { qty: rawQty, unit: 'packet' };
    if (['dozen'].includes(u)) return { qty: rawQty, unit: 'dozen' };
    return { qty: rawQty, unit: 'pcs' };
  }

  async parseImage(_imageUrl: string, caption?: string): Promise<ParsedOrderResult> {
    if (caption) return this.parseText(caption);
    throw new Error('Please send your list as text. Image reading needs AI credits.');
  }

  async parseVoiceNote(_audioBuffer: Buffer): Promise<ParsedOrderResult> {
    throw new Error('Please send your list as text for now.');
  }
}
