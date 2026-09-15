async function main() {
  try {
    const res = await fetch('http://localhost:3000/api/logs/structured');
    const logsObj = await res.json();
    console.log('Keys of logsObj:', Object.keys(logsObj));
    if (logsObj.success || Array.isArray(logsObj.data)) {
       const array = logsObj.data || logsObj.logs || [];
       console.log('Total items:', array.length);
       array.slice(-25).forEach((l: any) => {
          console.log(`[${l.level?.toUpperCase() || 'INFO'}] ${l.message || JSON.stringify(l)}`);
       });
    } else {
       console.log('Response:', JSON.stringify(logsObj).slice(0, 500));
    }
  } catch (err: any) {
    console.error('ERROR:', err.message);
  }
}

main();
