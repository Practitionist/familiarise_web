import fs from 'fs';
import path from 'path';
import { glob } from 'glob';

const targetDirectories = ['app', 'components']; // Add other directories if needed
const fileExtensions = ['.tsx', '.jsx'];

async function processFiles() {
  console.log('Starting to process files to escape HTML entities...');
  const CWD = process.cwd();
  let filesChangedCount = 0;

  for (const dir of targetDirectories) {
    const pattern = path.join(CWD, dir, `**/*{${fileExtensions.join(',')}}`).replace(/\\/g, '/'); // Normalize path for glob
    const files = await glob(pattern, { nodir: true, ignore: ['node_modules/**', '.next/**'] });

    for (const file of files) {
      try {
        const originalContent = fs.readFileSync(file, 'utf8');
        let newContent = originalContent;
        let madeChangeInFile = false;

        // Replace ' and " within JSX text nodes: >text_content<
        newContent = newContent.replace(/>([^<]*)</g, (match, textContent) => {
          let modifiedTextContent = textContent;
          let changedInThisMatch = false;

          if (textContent.includes("'")) {
            modifiedTextContent = modifiedTextContent.replace(/'/g, "&apos;");
            changedInThisMatch = true;
          }
          if (textContent.includes('"')) {
            modifiedTextContent = modifiedTextContent.replace(/"/g, "&quot;");
            changedInThisMatch = true;
          }
          
          // Example for handling > within text, be cautious:
          // if (textContent.includes('>') && !textContent.match(/^\s*<\/?.*>\s*$/)) { // Avoid replacing > in stray tags
          //   modifiedTextContent = modifiedTextContent.replace(/>/g, "&gt;");
          //   changedInThisMatch = true;
          // }

          if (changedInThisMatch) {
            madeChangeInFile = true;
          }
          return `>${modifiedTextContent}<`;
        });
        
        /*
        Handle cases where text might be at the start or end of a multi-line JSX element,
        not strictly between > and < on the same line.
        This is a simplified additional pass, might need refinement for complex cases.
        Example: 
        <p>
          It's here
        </p>
        Regex to find ' or " not in an attribute and likely in text content
        This is complex and best handled by AST or more sophisticated regex.
        The above regex `/>([^<]*)</g` is safer for a first pass.
        */

        if (madeChangeInFile) {
          fs.writeFileSync(file, newContent, 'utf8');
          console.log(`Updated entities in: ${file}`);
          filesChangedCount++;
        }
      } catch (error) {
        console.error(`Could not process file ${file}:`, error);
      }
    }
  }

  if (filesChangedCount > 0) {
    console.log(`
Finished processing files. ${filesChangedCount} file(s) were modified.`);
    console.log("Please review the changes and run your linter again.");
  } else {
    console.log("\nFinished processing files. No files required changes based on the current script logic.");
  }
  console.log("You might need to manually fix remaining or complex cases.");
}

processFiles().catch(console.error);
