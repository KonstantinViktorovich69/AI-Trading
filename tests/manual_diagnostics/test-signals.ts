import http from 'http';

function getJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

async function test() {
  try {
    const debug = await getJson('http://localhost:3000/api/debug/state');
    console.log('DEBUG STATE:', debug);
    const signals = await getJson('http://localhost:3000/api/signals');
    console.log('TOTAL SIGNALS:', signals.data?.length);
    console.log('SIGNALS COINS:', signals.data?.map((s: any) => `${s.symbol} (${s.signal}, aiScore: ${s.aiScore}, type: ${s.type})`));
  } catch (e: any) {
    console.error('Error:', e.message);
  }
}

test();
