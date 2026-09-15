const http = require('http');

http.get('http://localhost:3000/api/signals', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    let parsed = JSON.parse(data);
    console.log("Health:", parsed.marketHealth);
    console.log("Signals limit:", parsed.data.slice(0, 5));
  });
}).on('error', console.error);
