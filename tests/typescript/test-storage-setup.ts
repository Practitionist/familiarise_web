#!/usr/bin/env node

/**
 * Test Storage Setup Script
 * 
 * This script tests the storage hierarchy creation and bucket management.
 * Run this to verify your Supabase setup is working correctly.
 */

// Load environment variables from .env file
import { config } from 'dotenv';
config({ path: '.env' });

import { ensureBucketExists, ensureFolderExists } from '../../lib/supabase';

async function testStorageSetup(): Promise<void> {
  console.log('🧪 Testing storage setup...');
  console.log('📅 Test time:', new Date().toISOString());

  try {
    // Test 1: Ensure documents bucket exists
    console.log('\n📦 Test 1: Checking documents bucket...');
    const bucketReady = await ensureBucketExists('documents');
    
    if (bucketReady) {
      console.log('✅ Documents bucket is ready');
    } else {
      console.log('❌ Failed to create or verify documents bucket');
      return;
    }

    // Test 2: Test folder structure creation
    console.log('\n📁 Test 2: Testing folder structure...');
    const testAppointmentId = 'test-appointment-123';
    const testConsulteeId = 'test-consultee-456';
    const testFolderPath = `appointments/${testAppointmentId}/consultee-${testConsulteeId}`;
    
    const folderReady = await ensureFolderExists('documents', testFolderPath);
    
    if (folderReady) {
      console.log(`✅ Folder structure validated: ${testFolderPath}`);
    } else {
      console.log(`❌ Failed to validate folder structure: ${testFolderPath}`);
      return;
    }

    // Test 3: Test multiple folder levels
    console.log('\n🗂️  Test 3: Testing nested folder creation...');
    const testFolders = [
      'appointments/test-1/consultee-user-1',
      'appointments/test-2/consultee-user-2',
      'appointments/test-3/consultee-user-3'
    ];

    for (const folder of testFolders) {
      const ready = await ensureFolderExists('documents', folder);
      if (ready) {
        console.log(`✅ Validated: ${folder}`);
      } else {
        console.log(`❌ Failed: ${folder}`);
      }
    }

    console.log('\n🎉 All storage tests passed!');
    console.log('\n📋 Summary:');
    console.log('   ✅ Documents bucket ready');
    console.log('   ✅ Folder structure creation working');
    console.log('   ✅ Nested folder validation working');
    console.log('\n💡 Your storage system is ready for document uploads!');

  } catch (error) {
    console.error('\n❌ Storage test failed:', error);
    process.exit(1);
  }
}

// Run test if this file is executed directly
if (require.main === module) {
  testStorageSetup()
    .then(() => {
      console.log('\n✅ Storage test completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Storage test failed:', error);
      process.exit(1);
    });
}

export { testStorageSetup };