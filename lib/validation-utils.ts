// Use ESM import for bad-words as shown in the documentation
import { Filter } from 'bad-words';

// Initialize with custom configuration
const wordFilter = new Filter({
  placeHolder: '*', // Use asterisks as placeholder
  // You can add more options like regex, replaceRegex if needed
});

// Add additional words to the blacklist
wordFilter.addWords(
  'motherfu',
  'nsfw',
  'inappropriate',
  'wtf',
  'garbage'
);

// Optionally remove some words to avoid false positives
// wordFilter.removeWords('hell', 'damn', 'god');

/**
 * Utility functions for form validation
 */

// Checks if an array has duplicate values (case-insensitive for strings)
export function hasDuplicates(values: string[]): boolean {
  if (!values || !Array.isArray(values)) return false;
  
  const lowerCaseValues = values.map(val => val.toLowerCase().trim());
  return new Set(lowerCaseValues).size !== lowerCaseValues.length;
}

// Validate a form field for profanity and other quality issues
export function validateField(fieldName: string, value: string): { isValid: boolean; message?: string } {
  if (!validateSensibleContent(value)) {
    return {
      isValid: false,
      message: `The ${fieldName} contains inappropriate content`
    };
  }
  
  return { isValid: true };
}

// Check if a string contains gibberish
export function containsGibberish(text: string): boolean {
  if (!text) return false

  // Check for random character sequences
  const gibberishPatterns = [
    /([a-z])\1{3,}/i, // Repeated characters (e.g., "aaaa")
    /[^a-z0-9\s.,!?:;'"()[\]{}#@&*\-_+=<>/\\|~`^%$€£¥₹₽₩₱₿]{3,}/i, // 3+ special chars in a row
    /[a-z]{8,}(?![aeiou])/i, // Long consonant sequences
    /(?:(?![aeiou])[a-z]){6,}/i, // 6+ consonants in a row
  ]

  // Check for random keyboard smashing
  const keyboardRows = [/[qwertyuiop]{5,}/i, /[asdfghjkl]{5,}/i, /[zxcvbnm]{5,}/i]

  // Check for random numbers and letters
  const randomAlphanumeric = /(?:[a-z][0-9]|[0-9][a-z]){3,}/i

  return (
    gibberishPatterns.some((pattern) => pattern.test(text)) ||
    keyboardRows.some((pattern) => pattern.test(text)) ||
    randomAlphanumeric.test(text)
  )
}

// Check for profanity
export function containsProfanity(text: string): boolean {
  if (!text) return false

  // Basic list of profane words to check against
  // In a real application, you would use a more comprehensive list or a service
  const profanityList = [
    "ass",
    "damn",
    "hell",
    "shit",
    "fuck",
    "bitch",
    "cunt",
    "dick",
    "cock",
    "pussy",
    "whore",
    "slut",
    "bastard",
    "piss",
    "crap",
    "asshole",
    "motherfucker",
  ]

  const normalizedText = text.toLowerCase()

  // Check if any profane word is in the text
  return profanityList.some((word) => {
    // Use word boundary to match whole words only
    const regex = new RegExp(`\\b${word}\\b`, "i")
    return regex.test(normalizedText)
  })
}

/**
 * Check if a string contains profanity using the bad-words library
 * @param text The text to check
 * @returns true if no profanity is found, false otherwise
 */
export function isProfanityFree(text: string): boolean {
  if (!text) return true;
  return !wordFilter.isProfane(text);
}

/**
 * Check if text is gibberish or nonsensical
 * @param text The text to check
 * @returns true if the text is meaningful, false if it seems like gibberish
 */
export function isMeaningfulText(text: string): boolean {
  if (!text) return true;
  
  // 1. Check for repeated characters (more than 3 in a row)
  const repeatingCharsPattern = /(.)\1{3,}/;
  if (repeatingCharsPattern.test(text)) {
    return false;
  }
  
  // 2. Check for text that's too short to be meaningful
  // (allow short values for specific cases like levels: "A1", "B2", etc.)
  if (text.length < 2) {
    return false;
  }

  // 3. Check for random character sequences (no vowels or too many consecutive consonants)
  const vowels = ['a', 'e', 'i', 'o', 'u', 'y'];
  const hasVowels = vowels.some(v => text.toLowerCase().includes(v));
  if (!hasVowels && text.length > 3) {
    return false;
  }

  // 4. Check for very high consonant-to-vowel ratio (gibberish often has this)
  const consonantPattern = /[bcdfghjklmnpqrstvwxz]/gi;
  const consonantMatches = text.match(consonantPattern) || [];
  const vowelPattern = /[aeiouy]/gi;
  const vowelMatches = text.match(vowelPattern) || [];
  
  // If text has more than 5 characters and has a consonant-to-vowel ratio > 5:1
  if (text.length > 5 && consonantMatches.length > 0 && vowelMatches.length > 0) {
    const ratio = consonantMatches.length / vowelMatches.length;
    if (ratio > 5) {
      return false;
    }
  }

  return true;
}

/**
 * Comprehensive validation for content text
 * @param text The text to validate
 * @returns true if the text passes all validations, false otherwise
 */
export function validateSensibleContent(text: string): boolean {
  if (!text) return true;
  
  // Run both checks separately
  const meaningful = isMeaningfulText(text);
  const noProfanity = isProfanityFree(text);
  
  return meaningful && noProfanity;
}

/**
 * Clean a string by replacing profanity with asterisks
 * @param text The text to clean
 * @returns The cleaned text with profanity replaced by asterisks
 */
export function cleanProfanity(text: string): string {
  if (!text) return '';
  return wordFilter.clean(text);
}

/**
 * Checks text for profanity and optionally cleans it
 * @param text The text to check
 * @param autoClean If true, cleans profanity instead of rejecting
 * @returns Object with validation result and cleaned text if applicable
 */
export function validateAndCleanProfanity(text: string, autoClean = false): { 
  isValid: boolean;
  cleanedText?: string;
} {
  if (!text) return { isValid: true };
  
  const hasProfanity = wordFilter.isProfane(text);
  
  // If no profanity or auto-clean is disabled, just return validity
  if (!hasProfanity) {
    return { isValid: true };
  }
  
  // If auto-clean is enabled, clean the text and return it
  if (autoClean) {
    return {
      isValid: true,
      cleanedText: wordFilter.clean(text)
    };
  }
  
  // Otherwise, return that validation failed
  return { isValid: false };
}
