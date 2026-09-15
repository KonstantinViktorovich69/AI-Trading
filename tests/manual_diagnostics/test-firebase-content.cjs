const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const firebaseConfig = require('./firebase-applet-config.json');

try {
  let credential;
  let hasCreds = false;

  if (fs.existsSync('./firebase-service-account.json')) {
    try {
      const fileCreds = JSON.parse(fs.readFileSync('./firebase-service-account.json', 'utf8'));
      credential = admin.credential.cert(fileCreds);
      hasCreds = true;
    } catch (e) {
      console.error("Error reading service account file:", e.message);
    }
  }

  if (hasCreds && credential) {
    admin.initializeApp({
      credential
    });
    console.log("Firebase Admin: Initialized with service account credentials.");
  } else {
    admin.initializeApp({
      projectId: firebaseConfig.projectId
    });
    console.log("Firebase Admin: Initialized with project ID (no custom credentials found).");
  }

  const db = getFirestore(admin.app(), firebaseConfig.firestoreDatabaseId);
  const ownerId = "polyakovats3110@gmail.com";

  async function check() {
    console.log("Connecting to Firestore database:", firebaseConfig.firestoreDatabaseId);
    
    const settingsDoc = await db.collection('users').doc(ownerId).collection('settings').doc('main').get();
    if (settingsDoc.exists) {
      console.log("FOUND REMOTE SETTINGS UNDER /users/ ownerId /settings/main:", JSON.stringify(settingsDoc.data(), null, 2));
    } else {
      console.log("NO REMOTE SETTINGS FOUND UNDER /users/ ownerId /settings/main FOR:", ownerId);
    }

    const tradesSnap = await db.collection('users').doc(ownerId).collection('trades').limit(500).get();
    console.log(`FOUND ${tradesSnap.size} TRADES TOTAL in users/ownerId/trades.`);
    if (!tradesSnap.empty) {
      console.log("RECENT TRADES UNDER /users/ ownerId /trades:");
      tradesSnap.forEach(doc => {
        const trade = doc.data();
        console.log(`- ID: ${trade.id}, Symbol: ${trade.symbol}, status: ${trade.status}, Date: ${trade.openTime ? new Date(trade.openTime).toISOString() : 'N/A'}`);
      });
    }
  }

  check().then(() => process.exit(0)).catch(e => {
    console.error("Error in check:", e);
    process.exit(1);
  });
} catch (e) {
  console.error("Initialization failed:", e);
  process.exit(1);
}
