process.stdin.resume();
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(d);
    const em = j.emails || [];
    const im = j.importantEmails || [];
    console.log('emails count:', em.length);
    console.log('importantEmails count:', im.length);
    if (em.length) {
      console.log('email[0] keys:', Object.keys(em[0]).join(', '));
      console.log('email[0] from:', JSON.stringify(em[0].from));
      console.log('email[0] subject:', JSON.stringify(em[0].subject));
    }
    if (im.length) {
      console.log('important[0] keys:', Object.keys(im[0]).join(', '));
      console.log('important[0] from:', JSON.stringify(im[0].from));
    }
  } catch(e) {
    console.log('PARSE ERROR:', e.message);
    console.log('raw (first 300):', d.slice(0, 300));
  }
});
