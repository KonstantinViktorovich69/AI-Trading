const http = require('http');

const req = http.request({
  host: '127.0.0.1',
  port: 3000,
  path: '/health',
  method: 'GET',
  timeout: 4000
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => console.log('Response:', res.statusCode, body));
});

req.on('error', (e) => console.error('Req error:', e.message));
req.on('timeout', () => {
  console.error('Req timed out');
  req.destroy();
});
req.end();
