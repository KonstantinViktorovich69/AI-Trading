const http = require('http');
http.get('http://localhost:3000/api/settings', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('Settings:', data));
});
