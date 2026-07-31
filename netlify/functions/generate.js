// netlify/functions/generate.js
//
// Урсгал:
// 1. Frontend-с бүтээгдэхүүний зураг (base64) + brand + style prompt хүлээж авна
// 2. Gemini image API руу дуудаж шинэ photoshoot зураг үүсгэнэ
// 3. Үр дүнг GitHub repo руу commit хийнэ (Contents API)
// 4. Firestore-д metadata (brand, style, github url, огноо) хадгална
// 5. Frontend рүү GitHub raw URL буцаана

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// ---------- Firebase Admin эхлүүлэх ----------
function getDb() {
  if (!getApps().length) {
    // FIREBASE_SERVICE_ACCOUNT env var-д бүтэн service account JSON-г нэг мөр string болгож хадгална
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

// ---------- GitHub-д зураг commit хийх ----------
async function commitImageToGithub({ base64Data, brand, extension }) {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const branch = process.env.GITHUB_BRANCH || 'main';

  const timestamp = Date.now();
  const path = `generated/${brand}/${timestamp}.${extension}`;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json'
      },
      body: JSON.stringify({
        message: `photoshoot: ${brand} ${timestamp}`,
        content: base64Data,
        branch
      })
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub commit амжилтгүй: ${errText}`);
  }

  // raw.githubusercontent.com URL нь public repo дээр шууд ажиллана
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

// ---------- Gemini image API дуудах ----------
// productImage: { base64, mimeType } — өөрчлөгдөхгүй байх ёстой бүтээгдэхүүн
// referenceImages: [{ base64, mimeType }] — зөвхөн орчин/тайлбарын жишээ, бүтээгдэхүүнийг эндээс аваагүй болно
async function generateWithGemini({ productImage, referenceImages, fullPrompt }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-2.5-flash-image';

  // Зургуудыг эхэнд, тодорхой шошготойгоор өгч, тушаалыг хамгийн адагт
  // тавьснаар загвар "оролтын зургийг шууд буцаах" магадлал багасна.
  const parts = [];

  parts.push({ text: 'IMAGE 1 — THE PRODUCT (this exact product must appear in the final output, unchanged in shape/color/logo/text):' });
  parts.push({ inline_data: { mime_type: productImage.mimeType, data: productImage.base64 } });

  if (referenceImages && referenceImages.length) {
    referenceImages.forEach((ref, i) => {
      parts.push({ text: `IMAGE ${i + 2} — STYLE REFERENCE ONLY (copy the mood/background/lighting from this, do NOT copy any object or product shown in it):` });
      parts.push({ inline_data: { mime_type: ref.mimeType, data: ref.base64 } });
    });
  }

  parts.push({
    text: [
      fullPrompt,
      'You must generate a brand-new composed image — never return IMAGE 1 or any reference image unchanged or uncropped.',
      'The output must clearly show IMAGE 1\'s product placed inside a newly rendered scene.'
    ].join(' ')
  });

  const callGemini = () => fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }]
      })
    }
  );

  let res = await callGemini();

  // Gemini "high demand / UNAVAILABLE" (503) ихэвчлэн түр зуурын тул нэг удаа
  // богино хугацаа хүлээгээд дахин оролдоно (нийт function timeout-д багтаах үүднээс зөвхөн 1 удаа)
  if (res.status === 503) {
    await new Promise(r => setTimeout(r, 2000));
    res = await callGemini();
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API алдаа: ${errText}`);
  }

  const data = await res.json();
  const responseParts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = responseParts.find(p => p.inlineData || p.inline_data);

  if (!imagePart) {
    throw new Error('Gemini-с зураг буцаагүй байна. Prompt-оо шалгана уу.');
  }

  const inline = imagePart.inlineData || imagePart.inline_data;
  return { base64Data: inline.data, mimeType: inline.mimeType || inline.mime_type };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { image, mimeType, brand, description, references } = JSON.parse(event.body);

    if (!image || !brand || !description) {
      return { statusCode: 400, body: 'image, brand, description шаардлагатай' };
    }

    const fullPrompt = [
      'Take this exact product and place it into a new professional product photography scene.',
      'Keep the product itself (shape, color, logo, text, proportions) completely unchanged.',
      `Scene / mood direction from the user: ${description}.`,
      references && references.length
        ? 'Reference images are attached below purely for style, background, and lighting inspiration.'
        : '',
      'High resolution, natural lighting, commercial product photography quality.'
    ].filter(Boolean).join(' ');

    // 1. Gemini-с зураг үүсгэх
    const generated = await generateWithGemini({
      productImage: { base64: image, mimeType: mimeType || 'image/jpeg' },
      referenceImages: (references || []).map(r => ({ base64: r.base64, mimeType: r.mimeType || 'image/jpeg' })),
      fullPrompt
    });

    // 2. GitHub-д хадгалах
    const extension = (generated.mimeType || 'image/png').split('/')[1] || 'png';
    const imageUrl = await commitImageToGithub({
      base64Data: generated.base64Data,
      brand,
      extension
    });

    // 3. Firestore-д metadata хадгалах
    const db = getDb();
    const docRef = await db.collection('photoshoots').add({
      brand,
      description,
      referenceCount: (references || []).length,
      imageUrl,
      createdAt: new Date().toISOString()
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ imageUrl, id: docRef.id })
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: err.message || 'Тодорхойгүй алдаа' };
  }
};
