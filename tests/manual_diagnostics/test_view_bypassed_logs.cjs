async function main() {
  try {
    const res = await fetch('http://localhost:3000/api/logs/structured?limit=2000');
    const logsObj = await res.json();
    const logs = logsObj.logs || [];
    console.log(`Fetched ${logs.length} logs.`);
    
    const bypassLogs = logs.filter(l => l.message && (l.message.includes('bypassed') || l.message.includes('LOCK') || l.message.includes('skipped')));
    console.log(`Found ${bypassLogs.length} logs about bypassing/skipping:`);
    bypassLogs.slice(0, 30).forEach(l => {
      console.log(`[${l.level.toUpperCase()}] ${l.message}`);
    });
  } catch (err) {
    console.error('Error:', err);
  }
}

main();
