/**
 * Utility functions for seed data generation
 */

/**
 * Sanitizes a string by removing null bytes and control characters that can cause PostgreSQL errors
 */
export function sanitizeString(input: string): string {
  if (!input) return input;
  
  return input
    .replace(/\0/g, '') // Remove null bytes
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .trim();
}

/**
 * Sanitizes an email address while preserving validity
 */
export function sanitizeEmail(email: string): string {
  if (!email) return email;
  
  // Split email into local and domain parts
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return sanitizeString(email);
  
  const localPart = sanitizeString(email.substring(0, atIndex));
  const domainPart = sanitizeString(email.substring(atIndex + 1));
  
  // Ensure we have valid parts
  if (!localPart || !domainPart) {
    return 'fallback@example.com';
  }
  
  return `${localPart}@${domainPart}`;
}

/**
 * Sanitizes a phone number while preserving format
 */
export function sanitizePhone(phone: string): string {
  if (!phone) return phone;
  
  // Remove null bytes and control characters, but keep phone number characters
  return phone
    .replace(/\0/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
    .trim();
}