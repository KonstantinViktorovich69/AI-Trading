import admin from 'firebase-admin';
try {
  admin.initializeApp();
  const db = admin.firestore();
  console.log("SUCCESS");
} catch(e) {
  console.log("ERROR", e.message);
}
