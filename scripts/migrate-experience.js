#!/usr/bin/env node

/**
 * Migration script runner for experience field conversion
 * This should be run BEFORE applying the Prisma schema changes
 */

const { execSync } = require('child_process');
const path = require('path');

console.log('🔄 Starting experience field migration...\n');

try {
  // Step 1: Run data migration script
  console.log('Step 1: Migrating existing experience data...');
  execSync('npx ts-node migrations/migrate-experience-to-float.ts', { stdio: 'inherit' });
  
  // Step 2: Apply schema changes
  console.log('\nStep 2: Applying Prisma schema changes...');
  execSync('npx prisma db push', { stdio: 'inherit' });
  
  // Step 3: Regenerate Prisma client
  console.log('\nStep 3: Regenerating Prisma client...');
  execSync('npx prisma generate', { stdio: 'inherit' });
  
  console.log('\n✅ Experience field migration completed successfully!');
  console.log('\nWhat happened:');
  console.log('- ✓ Existing experience text data converted to numeric values');
  console.log('- ✓ Database schema updated (experience: String -> Float)');
  console.log('- ✓ Prisma client regenerated with new types');
  console.log('\nYou can now use the numeric experience field in your application.');

} catch (error) {
  console.error('\n❌ Migration failed:', error.message);
  console.log('\nTroubleshooting:');
  console.log('1. Make sure your database is running and accessible');
  console.log('2. Check that you have the necessary permissions');
  console.log('3. Verify your database connection in .env file');
  console.log('4. Try running the steps manually:');
  console.log('   - npx ts-node migrations/migrate-experience-to-float.ts');
  console.log('   - npx prisma db push');
  console.log('   - npx prisma generate');
  
  process.exit(1);
}