#!/usr/bin/env node

/**
 * This script analyzes the codebase to suggest components that would benefit 
 * from code splitting and dynamic imports to improve performance.
 * 
 * Usage: ts-node scripts/suggest-code-splitting.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as glob from 'glob';

// Define color formatting functions
const colors = {
  red: (text: string): string => `\x1b[31m${text}\x1b[0m`,
  green: (text: string): string => `\x1b[32m${text}\x1b[0m`,
  yellow: (text: string): string => `\x1b[33m${text}\x1b[0m`,
  blue: (text: string): string => `\x1b[34m${text}\x1b[0m`,
  magenta: (text: string): string => `\x1b[35m${text}\x1b[0m`,
  cyan: (text: string): string => `\x1b[36m${text}\x1b[0m`,
  gray: (text: string): string => `\x1b[90m${text}\x1b[0m`,
  bold: {
    blue: (text: string): string => `\x1b[1m\x1b[34m${text}\x1b[0m`,
    green: (text: string): string => `\x1b[1m\x1b[32m${text}\x1b[0m`,
    red: (text: string): string => `\x1b[1m\x1b[31m${text}\x1b[0m`,
    yellow: (text: string): string => `\x1b[1m\x1b[33m${text}\x1b[0m`
  }
};

// Configuration
const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/public/**',
  '**/*.d.ts',
  '**/*.test.{ts,tsx,js,jsx}',
  '**/*.spec.{ts,tsx,js,jsx}',
  '**/*.stories.{ts,tsx,js,jsx}',
  '**/scripts/**'
];

// Thresholds for suggesting code splitting
const LARGE_COMPONENT_THRESHOLD = 150; // lines of code
const IMPORT_HEAVY_THRESHOLD = 10; // number of imports
const BELOW_FOLD_KEYWORDS = ['footer', 'bottom', 'modal', 'dialog', 'drawer', 'popup'];

// Component types for analysis
interface Component {
  name: string;
  file: string;
  lines: number;
  imports: number;
  importList: string[];
  isDynamic: boolean;
}

interface AnalysisResults {
  largeComponents: Component[];
  importHeavyComponents: Component[];
  belowFoldComponents: Component[];
  routeComponents: Component[];
}

// Get all source files
const sourceFiles = glob.sync('**/*{.ts,.tsx,.js,.jsx}', {
  ignore: IGNORE_PATTERNS,
  cwd: process.cwd(),
  absolute: true
});

console.log('\x1b[1m\x1b[34m🔍 Analyzing codebase for code splitting opportunities...\x1b[0m');
console.log(colors.gray(`Found ${sourceFiles.length} files to analyze\n`));

// Results storage
const results: AnalysisResults = {
  largeComponents: [],
  importHeavyComponents: [],
  belowFoldComponents: [],
  routeComponents: []
};

// Regular expressions
const importRegex = /import\s+(?:{([^}]+)}|([^{}\s;]+)|\*\s+as\s+([^{}\s;]+))\s+from\s+['"]([^'"]+)['"]/g;
const componentRegex = /(?:export\s+(?:default\s+)?)?(?:function|class|const)\s+([A-Z][A-Za-z0-9_]*)/g;
const dynamicImportRegex = /dynamic\s*\(\s*\(\s*\)\s*=>\s*import\s*\(/g;

sourceFiles.forEach(filePath => {
  const relativePath = path.relative(process.cwd(), filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  // Split content into lines (used for component size calculation later)
  const lines = content.split('\n');
  
  // Find all imports in the file
  const imports: string[] = [];
  let match: RegExpExecArray | null;
  
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[4];
    if (importPath && !importPath.startsWith('.')) {
      imports.push(importPath);
    }
  }
  
  // Reset regex lastIndex
  importRegex.lastIndex = 0;
  
  // Check if file contains dynamic imports
  const hasDynamicImports = dynamicImportRegex.test(content);
  
  // Find components in the file
  while ((match = componentRegex.exec(content)) !== null) {
    const componentName = match[1];
    if (componentName) {
      // Calculate component size (approximate)
      const startPos = match.index;
      const endPos = content.indexOf('export', startPos + 1);
      const componentContent = endPos > startPos 
        ? content.substring(startPos, endPos) 
        : content.substring(startPos);
      const componentLines = componentContent.split('\n').length;
      
      // Create component object
      const component: Component = {
        name: componentName,
        file: relativePath,
        lines: componentLines,
        imports: imports.length,
        importList: imports,
        isDynamic: hasDynamicImports
      };
      
      // Check if it's a large component
      if (componentLines > LARGE_COMPONENT_THRESHOLD) {
        results.largeComponents.push(component);
      }
      
      // Check if it's import-heavy
      if (imports.length > IMPORT_HEAVY_THRESHOLD) {
        results.importHeavyComponents.push(component);
      }
      
      // Check if it's likely a below-the-fold component
      const isBelowFold = BELOW_FOLD_KEYWORDS.some(keyword => 
        componentName.toLowerCase().includes(keyword) || 
        relativePath.toLowerCase().includes(keyword)
      );
      
      if (isBelowFold) {
        results.belowFoldComponents.push(component);
      }
      
      // Check if it's a route component
      const isRouteComponent = 
        relativePath.includes('/pages/') || 
        relativePath.includes('/app/') ||
        componentName.includes('Page') ||
        componentName.includes('Route');
      
      if (isRouteComponent) {
        results.routeComponents.push(component);
      }
    }
  }
});

// Sort results by size
results.largeComponents.sort((a, b) => b.lines - a.lines);
results.importHeavyComponents.sort((a, b) => b.imports - a.imports);
results.belowFoldComponents.sort((a, b) => b.lines - a.lines);
results.routeComponents.sort((a, b) => b.lines - a.lines);

// Print results
console.log('\x1b[1m\x1b[33m\n🔸 Large Components (good candidates for splitting):\x1b[0m');
if (results.largeComponents.length === 0) {
  console.log(colors.green('  No large components found!'));
} else {
  results.largeComponents.forEach(component => {
    console.log(colors.red(`  ${component.name} (${component.file}):`));
    console.log(colors.yellow(`    - ${component.lines} lines, ${component.imports} imports`));
    console.log(colors.blue(`    Suggestion: Split this component into smaller parts or use dynamic imports`));
  });
}

console.log('\x1b[1m\x1b[33m\n🔸 Import-Heavy Components:\x1b[0m');
if (results.importHeavyComponents.length === 0) {
  console.log(colors.green('  No import-heavy components found!'));
} else {
  results.importHeavyComponents.forEach(component => {
    console.log(colors.red(`  ${component.name} (${component.file}):`));
    console.log(colors.yellow(`    - ${component.lines} lines, ${component.imports} imports`));
    console.log(colors.gray(`    - Imports: ${component.importList.join(', ')}`));
    console.log(colors.blue(`    Suggestion: Use dynamic imports for heavy dependencies`));
  });
}

console.log('\x1b[1m\x1b[33m\n🔸 Below-the-fold Components:\x1b[0m');
if (results.belowFoldComponents.length === 0) {
  console.log(colors.green('  No below-the-fold components found!'));
} else {
  results.belowFoldComponents.forEach(component => {
    console.log(colors.red(`  ${component.name} (${component.file}):`));
    console.log(colors.yellow(`    - ${component.lines} lines, ${component.imports} imports`));
    console.log(colors.blue(`    Suggestion: Load this component lazily with dynamic imports`));
  });
}

console.log('\x1b[1m\x1b[33m\n🔸 Route Components:\x1b[0m');
if (results.routeComponents.length === 0) {
  console.log(colors.green('  No route components found!'));
} else {
  results.routeComponents.forEach(component => {
    console.log(colors.red(`  ${component.name} (${component.file}):`));
    console.log(colors.yellow(`    - ${component.lines} lines, ${component.imports} imports`));
    console.log(colors.blue(`    Suggestion: Use Next.js built-in code splitting or dynamic imports`));
  });
}

console.log('\x1b[1m\x1b[32m\n✅ Analysis complete!\x1b[0m');
console.log('\x1b[1m\x1b[34m\nSummary:\x1b[0m');
console.log(`Large components: ${results.largeComponents.length}`);
console.log(`Import-heavy components: ${results.importHeavyComponents.length}`);
console.log(`Below-the-fold components: ${results.belowFoldComponents.length}`);
console.log(`Route components: ${results.routeComponents.length}`);

console.log('\x1b[1m\x1b[34m\nHow to implement dynamic imports:\x1b[0m');
console.log(`
import dynamic from 'next/dynamic';

// Example 1: Basic dynamic import
const DynamicComponent = dynamic(() => import('./path/to/Component'));

// Example 2: With loading component
const DynamicComponentWithLoading = dynamic(
  () => import('./path/to/Component'),
  { loading: () => <p>Loading...</p> }
);

// Example 3: With SSR disabled (for components with browser-only APIs)
const DynamicComponentNoSSR = dynamic(
  () => import('./path/to/Component'),
  { ssr: false }
);
`);

console.log('\x1b[1m\x1b[34m\nNext steps:\x1b[0m');
console.log('1. Review the suggested components for code splitting');
console.log('2. Implement dynamic imports for below-the-fold and heavy components');
console.log('3. Run the bundle analyzer to see the impact of your changes');
console.log('4. Measure performance improvements with Lighthouse or Core Web Vitals');
