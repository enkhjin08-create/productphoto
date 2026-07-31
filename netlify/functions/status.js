// netlify/functions/status.js
// Frontend-с requestId-аар polling хийж, generate-background.js-ийн явцыг шалгана.
// Хариу: { status: "pending" | "done" | "error", imageUrl?, errorMessage? }

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
    const requestId = event.queryStringParameters?.id;
    if (!requestId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'id шаардлагатай' }) };
    }

    const db = getDb();
    const doc = await db.collection('photoshoots').doc(requestId).get();

    if (!doc.exists) {
      // Background function хараахан pending бичлэгээ үүсгэж амжаагүй байж болно
      // (маш эхэн үед polling эхэлбэл) — client талд "pending"-тэй адилхан тайлбарлана.
      return { statusCode: 200, body: JSON.stringify({ status: 'pending' }) };
    }

    return { statusCode: 200, body: JSON.stringify(doc.data()) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Тодорхойгүй алдаа' }) };
  }
};
