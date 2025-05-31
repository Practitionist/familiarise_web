#!/usr/bin/env node

/**
 * This script analyzes the Next.js bundle output to identify large dependencies
 * and opportunities for optimization.
 * 
 * Usage:
 * - First run: ANALYZE=true npm run build
 * - Then run: ts-node scripts/analyze-bundle.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// Define color formatting functions
const colors = {
  red: (text: string): string => `\x1b[31m${text}\x1b[0m`,
  green: (text: string): string => `\x1b[32m${text}\x1b[0m`,
  yellow: (text: string): string => `\x1b[33m${text}\x1b[0m`,
  blue: (text: string): string => `\x1b[34m${text}\x1b[0m`,
  bold: {
    blue: (text: string): string => `\x1b[1m\x1b[34m${text}\x1b[0m`,
    green: (text: string): string => `\x1b[1m\x1b[32m${text}\x1b[0m`
  }
};

// Path to the bundle analysis JSON file
const ANALYSIS_PATH = path.join(process.cwd(), '.next', 'analyze', 'client.json');

// Define interfaces for our data structures
interface Module {
  name: string;
  size: number;
}

interface DuplicatePackage {
  name: string;
  count: number;
  totalSize: number;
}

interface BundleData {
  groups?: BundleData[];
  modules?: Record<string, { size: number }>;
}

try {
  if (!fs.existsSync(ANALYSIS_PATH)) {
    console.error(colors.red('Bundle analysis file not found!'));
    console.log(colors.yellow('Run ANALYZE=true npm run build first to generate the analysis file.'));
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(ANALYSIS_PATH, 'utf8')) as BundleData;
  
  // Extract modules and sort by size
  const modules = extractModules(data);
  const sortedModules = modules.sort((a, b) => b.size - a.size);
  
  // Print report
  console.log(colors.bold.blue('\n=== BUNDLE SIZE ANALYSIS ===\n'));
  
  // Top 20 largest dependencies
  console.log(colors.bold.green('Top 20 largest dependencies:'));
  sortedModules.slice(0, 20).forEach((mod, index) => {
    console.log(
      `${index + 1}. ${colors.yellow(mod.name)} - ${formatSize(mod.size)} ${mod.size > 50000 ? colors.red('⚠️') : ''}`
    );
  });
  
  // Group by package and show total size
  console.log(colors.bold.green('\nPackage size overview:'));
  const packageSizes = groupByPackage(sortedModules);
  Object.entries(packageSizes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([pkg, size], index) => {
      console.log(
        `${index + 1}. ${colors.yellow(pkg)} - ${formatSize(size)} ${size > 100000 ? colors.red('⚠️') : ''}`
      );
    });
  
  // Optimization suggestions
  console.log(colors.bold.green('\nOptimization suggestions:'));
  
  // Check for large UI libraries
  const uiLibraries = ['@mui', '@chakra-ui', 'antd', '@material-ui', '@radix-ui', '@headlessui'];
  const foundUiLibraries = uiLibraries.filter(lib => 
    sortedModules.some(mod => mod.name.includes(lib))
  );
  
  if (foundUiLibraries.length > 0) {
    console.log(colors.yellow('- Consider using tree-shaking for UI libraries:'), foundUiLibraries.join(', '));
  }
  
  // Check for large utility libraries
  const largeUtils = sortedModules
    .filter(mod => 
      (mod.name.includes('lodash') || mod.name.includes('moment') || mod.name.includes('date-fns')) && 
      mod.size > 30000
    )
    .map(mod => mod.name);
  
  if (largeUtils.length > 0) {
    console.log(colors.yellow('- Consider importing specific utilities instead of entire libraries:'), largeUtils.join(', '));
    if (largeUtils.some(name => name.includes('moment'))) {
      console.log('  → Replace moment.js with date-fns or day.js for smaller bundle size');
    }
    if (largeUtils.some(name => name.includes('lodash'))) {
      console.log('  → Import specific lodash functions: import _map from "lodash/map"');
    }
  }
  
  // Check for duplicate packages
  const duplicates = findDuplicatePackages(sortedModules);
  if (duplicates.length > 0) {
    console.log(colors.yellow('- Potential duplicate packages detected:'));
    duplicates.forEach(dup => {
      console.log(`  → ${dup.name} (${dup.count} instances, total: ${formatSize(dup.totalSize)})`);
    });
  }
  
  console.log(colors.bold.blue('\n=== NEXT STEPS ===\n'));
  console.log('1. Use dynamic imports for large components not needed on initial load');
  console.log('2. Implement proper code-splitting with React.lazy() and Suspense');
  console.log('3. Consider using lightweight alternatives for large dependencies');
  console.log('4. Remove unused CSS with PurgeCSS or Tailwind\'s built-in purging');
  console.log('5. Optimize images further with next/image and modern formats');
  
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(colors.red('Error analyzing bundle:'), errorMessage);
  process.exit(1);
}

// Helper functions
function extractModules(data: BundleData): Module[] {
  const modules: Module[] = [];
  
  function traverse(node: BundleData): void {
    if (node.groups) {
      node.groups.forEach(traverse);
    }
    
    if (node.modules) {
      Object.entries(node.modules).forEach(([name, module]) => {
        modules.push({
          name,
          size: module.size
        });
      });
    }
  }
  
  traverse(data);
  return modules;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return bytes + ' B';
  } else if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(2) + ' KB';
  } else {
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }
}

function groupByPackage(modules: Module[]): Record<string, number> {
  const packages: Record<string, number> = {};
  
  modules.forEach(mod => {
    // Extract package name from node_modules path
    const match = mod.name.match(/node_modules[/\\](@[^/\\]+[/\\][^/\\]+|[^/\\]+)/);
    if (match) {
      const pkgName = match[1];
      packages[pkgName] = (packages[pkgName] || 0) + mod.size;
    }
  });
  
  return packages;
}

function findDuplicatePackages(modules: Module[]): DuplicatePackage[] {
  const packageVersions: Record<string, number> = {};
  
  modules.forEach(mod => {
    // Match package with version pattern
    const match = mod.name.match(/node_modules[/\\](@[^/\\]+[/\\][^/\\]+|[^/\\]+)/g);
    if (match) {
      match.forEach(pkg => {
        packageVersions[pkg] = (packageVersions[pkg] || 0) + 1;
      });
    }
  });
  
  // Find packages with multiple instances
  const duplicates = Object.entries(packageVersions)
    .filter(([_, count]) => count > 1)
    .map(([pkg, count]) => {
      // Calculate total size
      const totalSize = modules
        .filter(mod => mod.name.includes(pkg))
        .reduce((sum, mod) => sum + mod.size, 0);
      
      return {
        name: pkg.replace('node_modules/', ''),
        count,
        totalSize
      };
    })
    .sort((a, b) => b.totalSize - a.totalSize);
  
  return duplicates;
}
