// To bulk update environment variables for GitHub Actions, you'll typically want a method that avoids manually updating each variable in the repository or environment settings. Here are practical approaches:

// ## 1. Using GitHub Actions REST API

// GitHub provides REST API endpoints that let you programmatically update both repository-level and environment-level variables. This is the most flexible and scalable option for bulk updates.

// ### Repository variables
// You can use the REST API to patch each variable:
// ```bash
// curl -L \
//   -X PATCH \
//   -H "Accept: application/vnd.github+json" \
//   -H "Authorization: Bearer " \
//   -H "X-GitHub-Api-Version: 2022-11-28" \
//   https://api.github.com/repos/OWNER/REPO/actions/variables/NAME \
//   -d '{"name":"VARIABLE_NAME","value":"NEW_VALUE"}'
// ```
// Automate this with a script (e.g., Bash, Python, Node.js) that loops through a list of variable names and new values, updating each in turn.[1][3][7]

// ### Environment variables
// Similar approach, with the environment endpoint:
// ```bash
// curl -L \
//   -X PATCH \
//   -H "Accept: application/vnd.github+json" \
//   -H "Authorization: Bearer " \
//   -H "X-GitHub-Api-Version: 2022-11-28" \
//   https://api.github.com/repos/OWNER/REPO/environments/ENVIRONMENT_NAME/variables/NAME \
//   -d '{"name":"VARIABLE_NAME","value":"NEW_VALUE"}'
// ```
// Again, run this in a loop for bulk changes.[1]

// > Make sure your access token has the correct scopes (repo and variables write access), and check API request limits.

// ## 2. Sync Variables from `.env` File with Scripts

// For bulk updates based on a local `.env` file, prepare a script that reads key-value pairs and pushes them to the GitHub repository or environment using the API above. Example workflow:
// - Parse your `.env` file to extract all variables.
// - For each variable, make an API call to update it in your GitHub repository or environment.
// - You can achieve this with scripts in Node.js, Python, Bash, etc..[2]

// ## 3. Limitations and Considerations

// - There is **no built-in bulk update feature in the GitHub UI**; updates must be done per variable.
// - Scripting with the API is the de facto standard for automation.
// - Do not commit sensitive env files directly to your repository for security reasons.

// ## Quick Sample for Bulk Update Script (Bash & cURL)

// ```bash
// while IFS='=' read -r key value; do
//   curl -L \
//     -X PATCH \
//     -H "Accept: application/vnd.github+json" \
//     -H "Authorization: Bearer " \
//     https://api.github.com/repos/OWNER/REPO/actions/variables/$key \
//     -d "{\"name\":\"$key\",\"value\":\"$value\"}"
// done < .env
// ```
// - Replace `.env` with your file.
// - Set your GitHub token, repo, owner.

// This way, all variables in your local `.env` will be updated in your repository in bulk.[3][7][2][1]

// ***

// **In summary:**  
// To bulk update GitHub Actions environment variables, use the GitHub REST API programmatically with a script that loops through your variables. There is no official GUI for bulk editing; scripting is the standard approach. 

// If you need code for a specific language or workflow, let me know!

// [1] https://docs.github.com/en/rest/actions/variables
// [2] https://stackoverflow.com/questions/60176044/how-do-i-use-an-env-file-with-github-actions
// [3] https://www.getorchestra.io/guides/github-actions-api-update-a-repository-variable
// [4] https://github.com/orgs/community/discussions/26529
// [5] https://configu.com/blog/github-actions-environment-variables-uses-types-and-tutorial/
// [6] https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/store-information-in-variables
// [7] https://stackoverflow.com/questions/77273776/in-github-actions-how-do-i-modify-an-env-variable-in-the-repository-settings-f
// [8] https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment
// [9] https://www.kenmuse.com/blog/using-dynamic-environment-variables-with-github/
// [10] https://www.youtube.com/watch?v=5xngh29yx9A

// ===== IMPLEMENTATION =====

import * as fs from 'fs';
import * as path from 'path';
import _sodium from 'libsodium-wrappers';

interface GitHubConfig {
  owner: string;
  repo: string;
  token: string;
}

interface EnvVariable {
  key: string;
  value: string;
}

/**
 * Parse .env file and return key-value pairs
 */
function parseEnvFile(envPath: string): EnvVariable[] {
  if (!fs.existsSync(envPath)) {
    throw new Error(`Environment file not found: ${envPath}`);
  }

  const envContent = fs.readFileSync(envPath, 'utf-8');
  const variables: EnvVariable[] = [];

  envContent.split('\n').forEach((line, index) => {
    const trimmedLine = line.trim();
    
    // Skip empty lines and comments
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      return;
    }

    const equalIndex = trimmedLine.indexOf('=');
    if (equalIndex === -1) {
      console.warn(`Warning: Invalid line ${index + 1} in .env file: ${line}`);
      return;
    }

    const key = trimmedLine.substring(0, equalIndex).trim();
    const value = trimmedLine.substring(equalIndex + 1).trim();

    // Remove surrounding quotes if present
    const cleanValue = value.replace(/^["']|["']$/g, '');

    variables.push({ key, value: cleanValue });
  });

  return variables;
}

/**
 * Test if repository exists and token has access
 */
async function testRepositoryAccess(config: GitHubConfig): Promise<boolean> {
  try {
    console.log(`🔍 Testing access to repository: ${config.owner}/${config.repo}`);
    const repoResponse = await fetch(
      `https://api.github.com/repos/${config.owner}/${config.repo}`,
      {
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${config.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (repoResponse.ok) {
      const repoData = await repoResponse.json();
      console.log(`✅ Repository access confirmed: ${repoData.full_name} (${repoData.private ? 'private' : 'public'})`);
      return true;
    } else {
      console.error(`❌ Repository access failed: ${repoResponse.status} ${repoResponse.statusText}`);
      if (repoResponse.status === 404) {
        console.error('   - Repository not found or token lacks access');
        console.error('   - Check repository name and token permissions');
      }
      
      // Try to get more error details
      try {
        const errorData = await repoResponse.json();
        console.error('   - Error details:', errorData.message);
      } catch (e) {
        // Ignore JSON parse errors
      }
      
      return false;
    }
  } catch (error) {
    console.error(`❌ Network error testing repository access:`, error);
    return false;
  }
}

/**
 * Update a GitHub repository secret via REST API
 */
async function updateGitHubSecret(
  config: GitHubConfig,
  secretName: string,
  secretValue: string
): Promise<boolean> {
  try {
    // Initialize libsodium
    await _sodium.ready;
    const sodium = _sodium;

    // First, get the repository's public key for encryption
    const publicKeyUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/actions/secrets/public-key`;
    console.log(`🔑 Getting public key from: ${publicKeyUrl}`);
    
    const publicKeyResponse = await fetch(publicKeyUrl, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${config.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!publicKeyResponse.ok) {
      console.error(`Failed to get public key: ${publicKeyResponse.status} ${publicKeyResponse.statusText}`);
      
      // Try to get more error details
      try {
        const errorData = await publicKeyResponse.json();
        console.error('   - Error details:', errorData.message);
        if (errorData.documentation_url) {
          console.error('   - Documentation:', errorData.documentation_url);
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
      
      return false;
    }

    const publicKeyData = await publicKeyResponse.json();
    
    // Debug: log the public key format
    console.log(`   - Public key: ${publicKeyData.key.substring(0, 20)}...`);
    console.log(`   - Key ID: ${publicKeyData.key_id}`);
    
    // Encrypt the secret value using libsodium sealed box encryption  
    // GitHub uses libsodium sealed box for repository secrets
    let publicKeyBytes: Uint8Array;
    try {
      publicKeyBytes = sodium.from_base64(publicKeyData.key, sodium.base64_variants.ORIGINAL);
    } catch (e) {
      console.error(`   - Failed to decode public key: ${e}`);
      return false;
    }
    
    const secretBytes = sodium.from_string(secretValue);
    
    // Use sealed box encryption (anonymous encryption)
    const encrypted = sodium.crypto_box_seal(secretBytes, publicKeyBytes);
    
    // Encode as base64
    const encryptedValue = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);

    // Update the secret
    const updateResponse = await fetch(
      `https://api.github.com/repos/${config.owner}/${config.repo}/actions/secrets/${secretName}`,
      {
        method: 'PUT',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${config.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          encrypted_value: encryptedValue,
          key_id: publicKeyData.key_id,
        }),
      }
    );

    if (updateResponse.ok) {
      console.log(`✅ Successfully updated secret: ${secretName}`);
      return true;
    } else {
      console.error(`❌ Failed to update secret ${secretName}: ${updateResponse.status} ${updateResponse.statusText}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Error updating secret ${secretName}:`, error);
    return false;
  }
}

/**
 * Main function to sync .env file to GitHub Actions secrets
 */
async function syncEnvToGitHub(): Promise<void> {
  console.log('🚀 Starting environment variable sync to GitHub Actions...\n');

  try {
    // Parse .env file first to get GitHub credentials
    const envPath = path.join(process.cwd(), '.env');
    console.log(`📁 Reading environment file: ${envPath}`);
    
    const envVariables = parseEnvFile(envPath);
    console.log(`📊 Found ${envVariables.length} environment variables\n`);

    // Extract GitHub credentials from .env
    const githubToken = envVariables.find(({ key }) => key === 'GITHUB_TOKEN')?.value;

    // Configuration using values from .env (override with correct repository owner)
    const config: GitHubConfig = {
      owner: 'Practitionist', // Detected from git remote
      repo: 'familiarise_web',
      token: githubToken || '',
    };

    // Validate configuration
    if (!config.token) {
      console.error('❌ Error: GITHUB_TOKEN not found in .env file');
      console.log('Add GITHUB_TOKEN=your_token to .env file');
      console.log('Create a Personal Access Token with "repo" scope at: https://github.com/settings/tokens');
      process.exit(1);
    }

    // Note: Using hardcoded repository owner 'Practitionist' detected from git remote
    console.log(`📋 Repository: ${config.owner}/${config.repo}`);

    // Test repository access before attempting to sync secrets
    console.log(`🔍 Validating GitHub repository access...\n`);
    if (!(await testRepositoryAccess(config))) {
      console.error('\n❌ Cannot access repository. Please check:');
      console.error('   1. Repository name is correct');
      console.error('   2. GitHub token has "repo" scope');
      console.error('   3. Token has access to the repository');
      process.exit(1);
    }
    console.log(''); // Add spacing

    // Sync ALL environment variables except GitHub credentials
    // IMPORTANT: Exclude GitHub credentials to avoid uploading them to GitHub Actions
    const secretsToSync = envVariables.filter(({ key }) => 
      // Never sync GitHub credentials to avoid security issues
      !['GITHUB_TOKEN', 'GITHUB_OWNER'].includes(key)
    );

    console.log(`📋 Environment variables to sync:`);
    secretsToSync.forEach(({ key }) => console.log(`   - ${key}`));
    console.log('');

    console.log(`🔄 Syncing ${secretsToSync.length} secrets to GitHub repository: ${config.owner}/${config.repo}\n`);

    let successCount = 0;
    let failureCount = 0;

    // Update each secret
    for (const { key, value } of secretsToSync) {
      console.log(`⏳ Updating secret: ${key}...`);
      
      if (await updateGitHubSecret(config, key, value)) {
        successCount++;
      } else {
        failureCount++;
      }
      
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('\n📈 Sync Summary:');
    console.log(`✅ Successful: ${successCount}`);
    console.log(`❌ Failed: ${failureCount}`);
    
    if (failureCount === 0) {
      console.log('\n🎉 All environment variables synced successfully!');
      console.log('💡 You can now re-run your GitHub Actions workflow.');
    } else {
      console.log('\n⚠️  Some secrets failed to sync. Please check the errors above.');
    }

  } catch (error) {
    console.error('❌ Error during sync process:', error);
    process.exit(1);
  }
}

// Run the sync if this file is executed directly
if (require.main === module) {
  console.log('🔧 GitHub Actions Environment Variable Sync Tool\n');
  console.log('Usage:');
  console.log('1. Add GITHUB_TOKEN=your_token to .env file (Personal Access Token with "repo" scope)');
  console.log('2. Add GITHUB_OWNER=your_github_username to .env file');
  console.log('3. Run: npm run scripts:sync-env-github\n');
  console.log('📋 Required GitHub Token Permissions: ✅ repo (Full control of private repositories)\n');
  
  syncEnvToGitHub().catch(console.error);
}

export { syncEnvToGitHub, parseEnvFile, updateGitHubSecret };