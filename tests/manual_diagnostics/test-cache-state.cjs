const http = require('http');

function fetchEndpoint(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  try {
    const state = await fetchEndpoint('http://localhost:3000/api/debug/state');
    console.log("=== STATE ===");
    console.log(JSON.stringify(state, null, 2));

    const cache = await fetchEndpoint('http://localhost:3000/api/debug/cache');
    console.log("\n=== CACHE ===");
    console.log(JSON.stringify(cache, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
