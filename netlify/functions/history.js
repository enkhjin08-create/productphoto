// netlify/functions/history.js
// Firestore-с тухайн brand-ийн сүүлийн үеийн generate хийсэн зургуудын жагсаалтыг буцаана

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function getDb() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

exports.handler = async (event) => {
  try {
    const brand = event.queryStringParameters?.brand;
    const db = getDb();

    let query = db.collection('photoshoots').orderBy('createdAt', 'desc').limit(20);
    if (brand) {
      query = db.collection('photoshoots')
        .where('brand', '==', brand)
        .orderBy('createdAt', 'desc')
        .limit(20);
    }

    const snap = await query.get();
    const items = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    return {
      statusCode: 200,
      body: JSON.stringify(items)
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: err.message || 'Тодорхойгүй алдаа' };
  }
};
