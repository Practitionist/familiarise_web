#!/usr/bin/env node

/**
 * This script optimizes images in the public directory by:
 * 1. Converting JPG/PNG to WebP and AVIF formats
 * 2. Resizing large images to more reasonable dimensions
 * 3. Compressing images without significant quality loss
 * 
 * Usage: ts-node scripts/optimize-images.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Define color formatting functions
const colors = {
  red: (text: string): string => `\x1b[31m${text}\x1b[0m`,
  green: (text: string): string => `\x1b[32m${text}\x1b[0m`,
  yellow: (text: string): string => `\x1b[33m${text}\x1b[0m`,
  blue: (text: string): string => `\x1b[34m${text}\x1b[0m`,
  gray: (text: string): string => `\x1b[90m${text}\x1b[0m`,
  bold: {
    blue: (text: string): string => `\x1b[1m\x1b[34m${text}\x1b[0m`,
    green: (text: string): string => `\x1b[1m\x1b[32m${text}\x1b[0m`
  }
};

// Check if required tools are installed
try {
  execSync('which convert', { stdio: 'ignore' });
  execSync('which cwebp', { stdio: 'ignore' });
  execSync('which avifenc', { stdio: 'ignore' });
} catch {
  // No need to capture the error object
  console.error(colors.red('Error: Required tools not found.'));
  console.log(colors.yellow('Please install the following tools:'));
  console.log('- ImageMagick (for convert command)');
  console.log('- WebP (for cwebp command)');
  console.log('- AVIF tools (for avifenc command)');
  console.log('\nInstallation on macOS:');
  console.log('brew  install imagemagick webp libavif');
  process.exit(1);
}

// Configuration
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif'];
const MAX_WIDTH = 1920;
const QUALITY = 80;
const FORMATS = ['webp', 'avif'];

// Create optimized directories if they don't exist
FORMATS.forEach(format => {
  const formatDir = path.join(PUBLIC_DIR, format);
  if (!fs.existsSync(formatDir)) {
    fs.mkdirSync(formatDir, { recursive: true });
  }
});

interface ImageResult {
  path: string;
  originalSize: number;
  webpSize: number;
  avifSize: number;
}

// Find all images recursively
function findImages(dir: string): string[] {
  let results: string[] = [];
  const items = fs.readdirSync(dir);
  
  for (const item of items) {
    const itemPath = path.join(dir, item);
    const stat = fs.statSync(itemPath);
    
    if (stat.isDirectory()) {
      // Skip the optimized directories
      if (!FORMATS.includes(item)) {
        results = results.concat(findImages(itemPath));
      }
    } else {
      const ext = path.extname(item).toLowerCase();
      if (IMAGE_EXTENSIONS.includes(ext)) {
        results.push(itemPath);
      }
    }
  }
  
  return results;
}

// Process an image
async function processImage(imagePath: string): Promise<ImageResult | null> {
  const relativePath = path.relative(PUBLIC_DIR, imagePath);
  const filename = path.basename(imagePath, path.extname(imagePath));
  const directory = path.dirname(relativePath);
  
  console.log(colors.blue(`Processing: ${relativePath}`));
  
  try {
    // Get image dimensions
    const dimensions = execSync(`identify -format "%wx%h" "${imagePath}"`).toString().trim();
    const [width, height] = dimensions.split('x').map(Number);
    
    // Skip if image is already optimized
    if (width <= MAX_WIDTH) {
      console.log(colors.gray(`  - Image already within size limits (${width}x${height})`));
    } else {
      console.log(colors.yellow(`  - Resizing from ${width}x${height} to fit within ${MAX_WIDTH}px width`));
    }
    
    // Create directory structure in the optimized directories
    FORMATS.forEach(format => {
      const targetDir = path.join(PUBLIC_DIR, format, directory);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
    });
    
    // Convert to WebP
    const webpPath = path.join(PUBLIC_DIR, 'webp', directory, `${filename}.webp`);
    execSync(`cwebp -q ${QUALITY} -resize ${Math.min(width, MAX_WIDTH)} 0 "${imagePath}" -o "${webpPath}"`);
    
    // Convert to AVIF
    const avifPath = path.join(PUBLIC_DIR, 'avif', directory, `${filename}.avif`);
    execSync(`avifenc --min 0 --max 63 --speed 6 --jobs 4 -a end-usage=q -a cq-level=25 -a tune=ssim "${imagePath}" "${avifPath}"`);
    
    // Get file sizes
    const originalSize = fs.statSync(imagePath).size;
    const webpSize = fs.statSync(webpPath).size;
    const avifSize = fs.statSync(avifPath).size;
    
    const webpSavings = ((originalSize - webpSize) / originalSize * 100).toFixed(1);
    const avifSavings = ((originalSize - avifSize) / originalSize * 100).toFixed(1);
    
    console.log(colors.green(`  - WebP: ${formatSize(webpSize)} (${webpSavings}% smaller)`));
    console.log(colors.green(`  - AVIF: ${formatSize(avifSize)} (${avifSavings}% smaller)`));
    
    return {
      path: relativePath,
      originalSize,
      webpSize,
      avifSize
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(colors.red(`  - Error processing ${relativePath}: ${errorMessage}`));
    return null;
  }
}

// Format file size
function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return bytes + ' B';
  } else if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + ' KB';
  } else {
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }
}

// Main function
async function main(): Promise<void> {
  console.log(colors.bold.blue('🖼️  Starting image optimization...'));
  
  const images = findImages(PUBLIC_DIR);
  console.log(colors.blue(`Found ${images.length} images to process`));
  
  const results: ImageResult[] = [];
  
  for (const image of images) {
    const result = await processImage(image);
    if (result) {
      results.push(result);
    }
  }
  
  // Calculate total savings
  const totalOriginal = results.reduce((sum, item) => sum + item.originalSize, 0);
  const totalWebp = results.reduce((sum, item) => sum + item.webpSize, 0);
  const totalAvif = results.reduce((sum, item) => sum + item.avifSize, 0);
  
  const webpSavings = ((totalOriginal - totalWebp) / totalOriginal * 100).toFixed(1);
  const avifSavings = ((totalOriginal - totalAvif) / totalOriginal * 100).toFixed(1);
  
  console.log(colors.bold.green('\n✅ Image optimization complete!'));
  console.log(colors.bold.blue('\nSummary:'));
  console.log(`Original: ${formatSize(totalOriginal)}`);
  console.log(`WebP: ${formatSize(totalWebp)} (${webpSavings}% smaller)`);
  console.log(`AVIF: ${formatSize(totalAvif)} (${avifSavings}% smaller)`);
  
  console.log(colors.bold.blue('\nNext steps:'));
  console.log('1. Use the next/image component for all images');
  console.log('2. Update your code to use the optimized images with the "next/image" component');
  console.log('3. Consider adding "priority" prop to LCP images');
}

main().catch(error => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(colors.red(`Error: ${errorMessage}`));
  process.exit(1);
});
