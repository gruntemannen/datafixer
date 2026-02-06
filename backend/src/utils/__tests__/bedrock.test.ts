import { describe, it, expect } from 'vitest';
import { normalizeCountryCode, isValidEmail, isValidUrl, isValidPhone } from '../bedrock.js';

describe('normalizeCountryCode', () => {
  it('should return uppercase 2-letter codes as-is', () => {
    expect(normalizeCountryCode('DE')).toBe('DE');
    expect(normalizeCountryCode('FR')).toBe('FR');
    expect(normalizeCountryCode('US')).toBe('US');
  });

  it('should normalize lowercase codes', () => {
    expect(normalizeCountryCode('de')).toBe('DE');
    expect(normalizeCountryCode('fr')).toBe('FR');
  });

  it('should convert country names to codes', () => {
    expect(normalizeCountryCode('Germany')).toBe('DE');
    expect(normalizeCountryCode('germany')).toBe('DE');
    expect(normalizeCountryCode('Deutschland')).toBe('DE');
    expect(normalizeCountryCode('France')).toBe('FR');
    expect(normalizeCountryCode('United States')).toBe('US');
    expect(normalizeCountryCode('USA')).toBe('US');
    expect(normalizeCountryCode('United Kingdom')).toBe('GB');
    expect(normalizeCountryCode('UK')).toBe('GB');
  });

  it('should return null for unknown countries', () => {
    expect(normalizeCountryCode('Unknown')).toBeNull();
    expect(normalizeCountryCode('XYZ')).toBeNull();
  });

  it('should handle null and empty strings', () => {
    expect(normalizeCountryCode(null)).toBeNull();
    expect(normalizeCountryCode('')).toBeNull();
  });
});

describe('isValidEmail', () => {
  it('should validate correct email formats', () => {
    expect(isValidEmail('test@example.com')).toBe(true);
    expect(isValidEmail('user.name@domain.co.uk')).toBe(true);
    expect(isValidEmail('test+tag@example.org')).toBe(true);
  });

  it('should reject invalid email formats', () => {
    expect(isValidEmail('notanemail')).toBe(false);
    expect(isValidEmail('@nodomain.com')).toBe(false);
    expect(isValidEmail('no@')).toBe(false);
    expect(isValidEmail('spaces in@email.com')).toBe(false);
  });
});

describe('isValidUrl', () => {
  it('should validate correct URL formats', () => {
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('http://www.example.org')).toBe(true);
    expect(isValidUrl('https://sub.domain.co.uk/path')).toBe(true);
  });

  it('should reject invalid URL formats', () => {
    expect(isValidUrl('notaurl')).toBe(false);
    expect(isValidUrl('www.example.com')).toBe(false);
    expect(isValidUrl('example.com')).toBe(false);
  });
});

describe('isValidPhone', () => {
  it('should validate correct phone formats', () => {
    expect(isValidPhone('+49 30 12345678')).toBe(true);
    expect(isValidPhone('+1-555-555-5555')).toBe(true);
    expect(isValidPhone('(555) 555-5555')).toBe(true);
    expect(isValidPhone('5555555555')).toBe(true);
  });

  it('should reject invalid phone formats', () => {
    expect(isValidPhone('123')).toBe(false);
    expect(isValidPhone('notaphone')).toBe(false);
  });
});
