import { describe, expect, it } from 'vitest';
import { isPromotionalText } from './offers.ts';

/**
 * Banner text decides what the product reports as "offers". Found on a real shop's home page: "We Offer Kitchen Pre-Stocking Service for
 * Vacation Rentals Properties" was counted as an active offer because it contains the word "offer".
 */
describe('which banner texts advertise a price benefit', () => {
  it.each([
    'Free delivery on orders over Afl. 150 - Weekend sale: up to 20% off pantry staples',
    'Weekly Specials',
    'Bonus Specials',
    'Save 10% on your first order with code WELCOME10',
    'Save up to $20 this week',
    'Buy 2 get 1 free on all snacks',
    'Special offers on beverages',
    'Exclusive offer for members',
    'Offer ends Sunday',
    'Clearance — everything must go',
    'Flash deal: 3 for $10',
    'Ofertas de la semana',
    'Free shipping over $100',
  ])('is promotional: %s', (t) => expect(isPromotionalText(t)).toBe(true));

  it.each([
    'We Offer Kitchen Pre-Stocking Service for Vacation Rentals Properties',
    'DO YOU RENT OR OWN AN AIRBNB IN NASSAU, THE BAHAMAS, OR THE CARIBBEAN? We Offer Kitchen Pre-Stocking Service for Vacation Rentals Properties Shop Now',
    'We offer delivery across the island',
    'Our team offers advice on special diets',
    'Contact our sales team',
    'Save time with our mobile app',
    'Download our new mobile app!',
    'Opening hours: Monday to Saturday, 8 to 6',
  ])('is not promotional: %s', (t) => expect(isPromotionalText(t)).toBe(false));
});
