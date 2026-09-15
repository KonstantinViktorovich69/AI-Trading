import 'dotenv/config';

async function run() {
  const urls = [
    '/api/settings',
    '/api/knowledge',
    '/api/paper-trade',
    '/api/real-trade/positions'
  ];
  
  for (const url of urls) {
    try {
      const res = await fetch(`http://127.0.0.1:3000${url}`);
      console.log(`${url} => Status:`, res.status);
      const text = await res.text();
      console.log(`Response:`, text.substring(0, 100));
    } catch (e) {
      console.log(`${url} => Error:`, e.message);
    }
  }
}

run();
