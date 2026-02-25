const https = require('https');
const body = JSON.stringify({
  origin: { address: '7399 NW 23rd St, Pembroke Pines, FL' },
  destination: { address: '200 SW 2nd St, Fort Lauderdale, FL' },
  travelMode: 'DRIVE',
  routingPreference: 'TRAFFIC_AWARE'
});
const opts = {
  hostname: 'routes.googleapis.com',
  path: '/directions/v2:computeRoutes',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': 'AIzaSyAIXeiVsoncs7BziDIKM6MS847vX8Tkz9I',
    'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters',
    'Content-Length': Buffer.byteLength(body)
  }
};
const req = https.request(opts, res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => console.log(data));
});
req.write(body);
req.end();
