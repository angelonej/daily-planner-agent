import { readFileSync, writeFileSync } from 'fs';

let c = readFileSync('public/dashboard.html', 'utf8');

// Fix the mangled onclick from PowerShell double-quoting
const bad = "openEmail(''+JSON.stringify(id)+'')";
const good = 'openEmail(" + JSON.stringify(id) + ")';

if (c.includes(bad)) {
  c = c.replace(bad, good);
  writeFileSync('public/dashboard.html', c, 'utf8');
  console.log('FIXED');
} else {
  console.log('Bad string not found — checking current state:');
  const i = c.indexOf('Handle open-email');
  console.log(c.substring(i, i + 400));
}
