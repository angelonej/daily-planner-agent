const d = require('fs').readFileSync('/dev/stdin', 'utf8');
const j = JSON.parse(d);
console.log('Top-level keys:', Object.keys(j).join(', '));
const em = j.emails || [];
console.log('emails count:', em.length);
if (em.length) {
  console.log('first email keys:', Object.keys(em[0]).join(', '));
  console.log('first email sample:', JSON.stringify(em[0]).slice(0, 200));
}
const im = j.importantEmails || [];
console.log('importantEmails count:', im.length);
if (im.length) {
  console.log('first important keys:', Object.keys(im[0]).join(', '));
  console.log('first important sample:', JSON.stringify(im[0]).slice(0, 200));
}
