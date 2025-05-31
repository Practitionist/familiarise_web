#!/usr/bin/env node

/**
 * This script scans TypeScript/JavaScript files to find potentially unused imports
 * It helps identify imports that can be removed to reduce bundle size
 * 
 * Usage: ts-node scripts/find-unused-imports.ts
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
  gray: (text: string): string => `\x1b[90m${text}\x1b[0m`,
  bold: {
    blue: (text: string): string => `\x1b[1m\x1b[34m${text}\x1b[0m`,
    green: (text: string): string => `\x1b[1m\x1b[32m${text}\x1b[0m`,
    yellow: (text: string): string => `\x1b[1m\x1b[33m${text}\x1b[0m`
  }
};

// Configuration
const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/*.d.ts'
];

// Define interfaces for our data structures
interface NamedImport {
  name: string;
  alias: string | null;
  usage: number;
}

interface ImportBase {
  module: string;
  fullImport: string;
}

interface NamedImportGroup extends ImportBase {
  type: 'named';
  imports: NamedImport[];
}

interface DefaultImport extends ImportBase {
  type: 'default';
  name: string;
  usage: number;
}

interface NamespaceImport extends ImportBase {
  type: 'namespace';
  name: string;
  usage: number;
}

type ImportItem = NamedImportGroup | DefaultImport | NamespaceImport;

interface UnusedImport {
  file: string;
  name: string;
  module: string;
  import: string;
}

interface Results {
  potentiallyUnused: UnusedImport[];
  typeOnlyImports: UnusedImport[];
  unusedDefaultImports: UnusedImport[];
  unusedNamedImports: UnusedImport[];
}

// Get all source files
const sourceFiles = glob.sync('**/*{.ts,.tsx,.js,.jsx}', {
  ignore: IGNORE_PATTERNS,
  cwd: process.cwd(),
  absolute: true
});

console.log(colors.bold.blue('🔍 Scanning for unused imports...'));
console.log(colors.gray(`Found ${sourceFiles.length} files to analyze\n`));

const results: Results = {
  potentiallyUnused: [],
  typeOnlyImports: [],
  unusedDefaultImports: [],
  unusedNamedImports: []
};

// Regular expressions for imports
const importRegex = /import\s+(?:{([^}]+)}|([^{}\s;]+)|\*\s+as\s+([^{}\s;]+))\s+from\s+['"]([^'"]+)['"]/g;
const namedImportRegex = /\s*([^,\s]+)(?:\s+as\s+([^,\s]+))?\s*,?/g;

// Process each file
sourceFiles.forEach(filePath => {
  const relativePath = path.relative(process.cwd(), filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  
  // Find all imports in the file
  const imports: ImportItem[] = [];
  let match: RegExpExecArray | null;
  
  while ((match = importRegex.exec(content)) !== null) {
    const [fullImport, namedImports, defaultImport, namespaceImport, modulePath] = match;
    
    if (namedImports) {
      // Process named imports
      let namedMatch: RegExpExecArray | null;
      const namedImportsList: NamedImport[] = [];
      
      // Reset lastIndex to start from the beginning of namedImports
      namedImportRegex.lastIndex = 0;
      
      while ((namedMatch = namedImportRegex.exec(namedImports)) !== null) {
        const [, importName, aliasName] = namedMatch;
        if (importName && importName.trim() !== 'type') {
          namedImportsList.push({
            name: importName.trim(),
            alias: aliasName ? aliasName.trim() : null,
            usage: 0
          });
        }
      }
      
      if (namedImportsList.length > 0) {
        imports.push({
          type: 'named',
          imports: namedImportsList,
          module: modulePath,
          fullImport
        });
      }
    }
    
    if (defaultImport) {
      // Process default import
      imports.push({
        type: 'default',
        name: defaultImport,
        module: modulePath,
        usage: 0,
        fullImport
      });
    }
    
    if (namespaceImport) {
      // Process namespace import
      imports.push({
        type: 'namespace',
        name: namespaceImport,
        module: modulePath,
        usage: 0,
        fullImport
      });
    }
  }
  
  // Count usage of each import
  imports.forEach(importItem => {
    if (importItem.type === 'named') {
      importItem.imports.forEach(namedImport => {
        const name = namedImport.alias || namedImport.name;
        // Count occurrences outside of import statements
        const importRegex = new RegExp(`import`);
        const contentWithoutImports = content.split('\n')
          .filter(line => !importRegex.test(line))
          .join('\n');
        
        // Look for usage patterns
        const usageRegex = new RegExp(`\\b${name}\\b`, 'g');
        const usageCount = (contentWithoutImports.match(usageRegex) || []).length;
        namedImport.usage = usageCount;
        
        if (usageCount === 0) {
          results.unusedNamedImports.push({
            file: relativePath,
            name: namedImport.name,
            module: importItem.module,
            import: importItem.fullImport
          });
        }
      });
    } else if (importItem.type === 'default' || importItem.type === 'namespace') {
      // Count occurrences outside of import statements
      const importRegex = new RegExp(`import`);
      const contentWithoutImports = content.split('\n')
        .filter(line => !importRegex.test(line))
        .join('\n');
      
      // Look for usage patterns
      const usageRegex = new RegExp(`\\b${importItem.name}\\b`, 'g');
      const usageCount = (contentWithoutImports.match(usageRegex) || []).length;
      importItem.usage = usageCount;
      
      if (usageCount === 0) {
        if (importItem.type === 'default') {
          results.unusedDefaultImports.push({
            file: relativePath,
            name: importItem.name,
            module: importItem.module,
            import: importItem.fullImport
          });
        } else {
          results.potentiallyUnused.push({
            file: relativePath,
            name: importItem.name,
            module: importItem.module,
            import: importItem.fullImport
          });
        }
      }
    }
  });
  
  // Look for type-only imports that could be optimized
  const typeImportRegex = /import\s+type\s+/g;
  const typeImportCount = (content.match(typeImportRegex) || []).length;
  
  if (typeImportCount === 0 && imports.length > 0) {
    // Check for imports that are only used in type positions
    const typeOnlyUsageRegex = /:\s*([A-Za-z0-9_]+)(\[\])?(\s*\|[^;,=)]+)?/g;
    let typeMatch: RegExpExecArray | null;
    const typeUsages = new Set<string>();
    
    while ((typeMatch = typeOnlyUsageRegex.exec(content)) !== null) {
      if (typeMatch[1]) {
        typeUsages.add(typeMatch[1]);
      }
    }
    
    imports.forEach(importItem => {
      if (importItem.type === 'named') {
        importItem.imports.forEach(namedImport => {
          if (typeUsages.has(namedImport.name) && namedImport.usage === 1) {
            results.typeOnlyImports.push({
              file: relativePath,
              name: namedImport.name,
              module: importItem.module,
              import: importItem.fullImport
            });
          }
        });
      }
    });
  }
});

// Print results
console.log(colors.bold.yellow('\n🚫 Unused Default Imports:'));
if (results.unusedDefaultImports.length === 0) {
  console.log(colors.green('  No unused default imports found!'));
} else {
  results.unusedDefaultImports.forEach(item => {
    console.log(colors.red(`  ${item.file}:`));
    console.log(colors.yellow(`    ${item.import.trim()}`));
    console.log(colors.blue(`    Suggestion: Remove this import if not needed`));
    console.log();
  });
}

console.log(colors.bold.yellow('\n🚫 Unused Named Imports:'));
if (results.unusedNamedImports.length === 0) {
  console.log(colors.green('  No unused named imports found!'));
} else {
  results.unusedNamedImports.forEach(item => {
    console.log(colors.red(`  ${item.file}:`));
    console.log(colors.yellow(`    ${item.import.trim()}`));
    console.log(colors.blue(`    Suggestion: Remove "${item.name}" from the import`));
    console.log();
  });
}

console.log(colors.bold.yellow('\n⚠️ Potentially Unused Namespace Imports:'));
if (results.potentiallyUnused.length === 0) {
  console.log(colors.green('  No potentially unused namespace imports found!'));
} else {
  results.potentiallyUnused.forEach(item => {
    console.log(colors.red(`  ${item.file}:`));
    console.log(colors.yellow(`    ${item.import.trim()}`));
    console.log(colors.blue(`    Suggestion: Check if this import is actually used`));
    console.log();
  });
}

console.log(colors.bold.yellow('\n🔄 Type-Only Imports (could be optimized):'));
if (results.typeOnlyImports.length === 0) {
  console.log(colors.green('  No type-only imports that need optimization found!'));
} else {
  results.typeOnlyImports.forEach(item => {
    console.log(colors.red(`  ${item.file}:`));
    console.log(colors.yellow(`    ${item.import.trim()}`));
    console.log(colors.blue(`    Suggestion: Change to "import type { ${item.name} } from '${item.module}'"`));
    console.log();
  });
}

console.log(colors.bold.green('\n✅ Analysis complete!'));
console.log(colors.bold.blue('\nSummary:'));
console.log(`Unused default imports: ${results.unusedDefaultImports.length}`);
console.log(`Unused named imports: ${results.unusedNamedImports.length}`);
console.log(`Potentially unused namespace imports: ${results.potentiallyUnused.length}`);
console.log(`Type-only imports that could be optimized: ${results.typeOnlyImports.length}`);

console.log(colors.bold.blue('\nNext steps:'));
console.log('1. Review and remove unused imports to reduce bundle size');
console.log('2. Convert regular imports to type imports where appropriate');
console.log('3. Run the bundle analyzer to see the impact of your changes');
