import { readFileSync, writeFileSync } from 'fs';

function fix(filePath, placeholderToken) {
  let src = readFileSync(filePath, 'utf8');

  // The problem: auto-link runs AFTER placeholder re-insertion, so phone numbers
  // inside already-rendered <a> tags get double-wrapped.
  // Fix: run auto-link BEFORE re-inserting placeholders.

  if (filePath.includes('dashboard')) {
    const before = `  html = html.replace(/\\x00L(\\d+)\\x00/g, (_, i) => links[+i]);
  // Auto-link bare phone numbers: +1 (555) 555-5555 / 555-555-5555 / (555) 555-5555
  html = html.replace(/(?<!href="tel:)(?<![\\d-])((\\.?\\+?1[\\s.-]?)?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4})(?![\\d])/g, (m, num) => {
    const digits = num.replace(/\\D/g, '');
    return \`<a href="tel:+\${digits}">\u{1F4DE}\u202f\${m}</a>\`;
  });`;

    const after = `  // Auto-link bare phone numbers BEFORE re-inserting link placeholders (prevents double icons)
  html = html.replace(/((?:\\+1[\\s.-]?)?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4})(?!\\d)/g, (m, num) => {
    const digits = num.replace(/\\D/g, '');
    if (digits.length < 10) return m;
    return \`<a href="tel:+\${digits}">\u{1F4DE}\u202f\${m}</a>\`;
  });
  html = html.replace(/\\x00L(\\d+)\\x00/g, (_, i) => links[+i]);`;

    if (src.includes('Auto-link bare phone numbers: +1')) {
      // Find and replace the block
      const startMarker = '  html = html.replace(/\\x00L(\\d+)\\x00/g, (_, i) => links[+i]);\n  // Auto-link';
      const endMarker = '  });\n  html = html.replace(/\\*\\*';
      const start = src.indexOf(startMarker);
      const end = src.indexOf(endMarker);
      if (start !== -1 && end !== -1) {
        src = src.slice(0, start) + after + '\n  html = html.replace(/\\*\\*' + src.slice(end + endMarker.length);
        writeFileSync(filePath, src, 'utf8');
        console.log('Fixed:', filePath);
      } else {
        console.log('Markers not found in', filePath, 'start:', start, 'end:', end);
      }
    } else {
      console.log('Already fixed or pattern not found:', filePath);
    }
  }

  if (filePath.includes('index')) {
    const startMarker = '    // Re-insert the links (already safe HTML)\n    processed = processed.replace(/\\x00LINK(\\d+)\\x00/g, (_, i) => linkPlaceholders[+i]);\n    // Auto-link bare phone numbers';
    const endMarker = '    });\n    // **bold**';

    const start = src.indexOf(startMarker);
    const end = src.indexOf(endMarker);
    if (start !== -1 && end !== -1) {
      const newBlock = `    // Auto-link bare phone numbers BEFORE re-inserting link placeholders (prevents double icons)
    processed = processed.replace(/((?:\\+1[\\s.-]?)?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4})(?!\\d)/g, (m, num) => {
      const digits = num.replace(/\\D/g, '');
      if (digits.length < 10) return m;
      return \`<a href="tel:+\${digits}">\u{1F4DE}\u202f\${m}</a>\`;
    });
    // Re-insert the links (already safe HTML)
    processed = processed.replace(/\\x00LINK(\\d+)\\x00/g, (_, i) => linkPlaceholders[+i]);`;
      src = src.slice(0, start) + newBlock + '\n    // **bold**' + src.slice(end + endMarker.length);
      writeFileSync(filePath, src, 'utf8');
      console.log('Fixed:', filePath);
    } else {
      console.log('Markers not found in', filePath, 'start:', start, 'end:', end);
    }
  }
}

fix('public/dashboard.html');
fix('public/index.html');
