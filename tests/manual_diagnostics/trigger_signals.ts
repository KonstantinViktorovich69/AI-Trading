async function main() {
  const url = 'http://localhost:3000/api/debug/run-ohlcv';
  for (let i = 0; i < 20; i++) {
    try {
      console.log(`Sending trigger request (attempt ${i})...`);
      const res = await fetch(url);
      if (res.ok) {
        const result = await res.json();
        console.log('OHLCV TRIGGER RESULT:', JSON.stringify(result, null, 2));
        return;
      } else {
        const errJson = await res.json();
        console.log('TRIGGER ERROR JSON:', JSON.stringify(errJson, null, 2));
        return;
      }
    } catch (err: any) {
      console.log(`Attempt ${i} failed: ${err.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

main();
