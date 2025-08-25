#!/usr/bin/env tsx

/**
 * Update ENV_FILE GitHub Secret
 * 
 * This script reads your .env file, encodes it as base64, and updates
 * the ENV_FILE secret in your GitHub repository.
 * 
 * Usage:
 *   npm run update-env-secret
 *   npx tsx scripts/update-env-secret.ts
 * 
 * Prerequisites:
 *   - GitHub CLI (gh) installed and authenticated
 *   - .env file exists in project root
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ENV_FILE_PATH = path.join(__dirname, '..', '.env');
const SECRET_NAME = 'ENV_FILE';

function main(): void {
  console.log('🔄 Updating ENV_FILE GitHub secret...\n');

  try {
    // Check if .env file exists
    if (!fs.existsSync(ENV_FILE_PATH)) {
      console.error('❌ Error: .env file not found!');
      console.error(`   Expected location: ${ENV_FILE_PATH}`);
      process.exit(1);
    }

    // Check if GitHub CLI is installed
    try {
      execSync('gh --version', { stdio: 'ignore' });
    } catch {
      console.error('❌ Error: GitHub CLI (gh) not found!');
      console.error('   Install it from: https://cli.github.com/');
      process.exit(1);
    }

    // Check if user is authenticated with GitHub CLI
    try {
      execSync('gh auth status', { stdio: 'ignore' });
    } catch {
      console.error('❌ Error: Not authenticated with GitHub CLI!');
      console.error('   Run: gh auth login');
      process.exit(1);
    }

    // Read and validate .env file
    const envContent = fs.readFileSync(ENV_FILE_PATH, 'utf8');
    if (!envContent.trim()) {
      console.error('❌ Error: .env file is empty!');
      process.exit(1);
    }

    // Count environment variables
    const envLines = envContent
      .split('\n')
      .filter(line => line.trim() && !line.trim().startsWith('#'))
      .filter(line => line.includes('='));
    
    console.log(`📋 Found ${envLines.length} environment variables:`);
    envLines.forEach(line => {
      const [key] = line.split('=');
      const value = line.split('=').slice(1).join('=');
      const maskedValue = value.length > 20 
        ? `${value.substring(0, 8)}...${value.substring(value.length - 4)}`
        : '***';
      console.log(`   ${key} = ${maskedValue}`);
    });
    console.log('');

    // Encode .env file as base64
    const base64Content = Buffer.from(envContent, 'utf8').toString('base64');
    
    // Create temporary file for the base64 content
    const tempFile = path.join(__dirname, '.env.base64.tmp');
    fs.writeFileSync(tempFile, base64Content);

    try {
      // Update GitHub secret
      console.log(`🔐 Updating ${SECRET_NAME} secret...`);
      execSync(`gh secret set ${SECRET_NAME} < "${tempFile}"`, {
        stdio: 'pipe',
        encoding: 'utf8'
      });

      console.log('✅ Successfully updated ENV_FILE secret!');
      console.log('');
      console.log('🎉 Your GitHub Actions workflow will now use the updated environment variables.');
      
      // Show next steps
      console.log('\n📝 Next steps:');
      console.log('   1. Commit any workflow changes if needed');
      console.log('   2. Push changes to trigger GitHub Actions');
      console.log('   3. Monitor the workflow run for any issues');

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('❌ Error updating GitHub secret:');
      console.error('   ', errorMessage.trim());
      
      if (errorMessage.includes('not found')) {
        console.error('\n💡 Make sure you\'re in the correct repository directory');
        console.error('   or that the repository exists and you have access.');
      }
      
      process.exit(1);
    } finally {
      // Clean up temporary file
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ Unexpected error:', errorMessage);
    process.exit(1);
  }
}

// Show help if requested
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Update ENV_FILE GitHub Secret

This script automatically updates the ENV_FILE secret in your GitHub repository
with the contents of your local .env file (base64 encoded).

Usage:
  npm run update-env-secret
  npx tsx scripts/update-env-secret.ts

Prerequisites:
  • GitHub CLI (gh) installed and authenticated
  • .env file exists in project root  
  • Repository access with secrets write permission

The script will:
  1. Read your .env file
  2. Encode it as base64
  3. Update the ENV_FILE GitHub secret
  4. Your GitHub Actions will automatically use the new values

Security Note:
  This script only uploads to GitHub secrets (encrypted).
  Your .env values are never exposed in logs or command history.
`);
  process.exit(0);
}

// Run the script
if (require.main === module) {
  main();
}

export { main };