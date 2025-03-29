import { Filter } from "bad-words";
import { Redis } from '@upstash/redis';

// Initialize Upstash Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Create a single filter instance
const filter = new Filter();

export interface ContentValidationResult {
  isValid: boolean;
  invalidFields: { field: string; value: string }[];
}

/**
 * Convert text to a simple vector representation
 * This is a basic implementation that creates a vector based on word frequencies
 */
function textToVector(text: string, dimensions: number = 100): number[] {
  // Normalize text: lowercase, remove special chars except spaces
  const normalizedText = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const words = normalizedText.split(/\s+/);
  
  // Initialize vector with zeros
  const vector = new Array(dimensions).fill(0);
  
  // Simple hashing function
  const hash = (str: string) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash) % dimensions;
  };
  
  // Fill vector based on word frequencies
  words.forEach(word => {
    if (word) {
      const index = hash(word);
      vector[index] += 1;
    }
  });
  
  // Normalize vector
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  return magnitude === 0 ? vector : vector.map(v => v / magnitude);
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Find similar topics using vector search
 * Returns array of similar topics with similarity scores
 */
export async function findSimilarTopics(topic: string, similarityThreshold = 0.85): Promise<{ topic: string; similarity: number }[]> {
  try {
    // Generate vector for the new topic
    const newTopicVector = textToVector(topic);
    
    // Get all existing topics and their vectors from Redis
    const existingTopics = await redis.hgetall('topic_vectors');
    if (!existingTopics) return [];
    
    // Calculate similarities
    const similarities = Object.entries(existingTopics).map(([existingTopic, vectorStr]) => {
      const vector = JSON.parse(vectorStr as string);
      const similarity = cosineSimilarity(newTopicVector, vector);
      
      return {
        topic: existingTopic,
        similarity
      };
    });
    
    // Filter and sort by similarity
    return similarities
      .filter(s => s.similarity >= similarityThreshold)
      .sort((a, b) => b.similarity - a.similarity);
  } catch (error) {
    console.error('Error finding similar topics:', error);
    return [];
  }
}

/**
 * Store a new topic with its vector representation
 */
export async function storeTopicVector(topic: string): Promise<void> {
  try {
    const vector = textToVector(topic);
    await redis.hset('topic_vectors', {
      [topic]: JSON.stringify(vector)
    });
  } catch (error) {
    console.error('Error storing topic vector:', error);
  }
}

/**
 * Check if a string contains profanity
 */
export function isProfane(text: string | null | undefined): boolean {
  if (!text || typeof text !== 'string' || !text.trim()) return false;
  
  try {
    return filter.isProfane(text);
  } catch (error) {
    console.error('Error checking profanity:', error);
    return false;
  }
}

/**
 * Generic profanity validation function that handles various data types
 */
export function validateProfanity(
  content: Record<string, any> | string[], 
  fieldsToCheck?: string[]
): ContentValidationResult {
  const invalidFields: { field: string; value: string }[] = [];
  
  // Handle array input (e.g., topics)
  if (Array.isArray(content)) {
    content.forEach((item, index) => {
      if (typeof item === 'string' && isProfane(item)) {
        invalidFields.push({ field: `[${index}]`, value: item });
      }
    });
    
    return {
      isValid: invalidFields.length === 0,
      invalidFields
    };
  }
  
  // Handle object input
  const fields = fieldsToCheck || Object.keys(content);
  
  for (const field of fields) {
    const value = content[field];
    
    if (typeof value === 'string') {
      if (isProfane(value)) {
        invalidFields.push({ field, value });
      }
    } else if (Array.isArray(value)) {
      // Check each item in array if it's a string
      value.forEach((item, index) => {
        if (typeof item === 'string' && isProfane(item)) {
          invalidFields.push({ field: `${field}[${index}]`, value: item });
        }
      });
    }
  }
  
  return {
    isValid: invalidFields.length === 0,
    invalidFields
  };
}
