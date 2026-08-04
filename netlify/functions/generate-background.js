// netlify/functions/generate-background.js
//
// Энэ бол Netlify BACKGROUND FUNCTION — client-г огт хүлээлгэхгүй.
// Дуудахад Netlify шууд 202 хариу буцаагаад, доорх кодыг арын талд
// (client холболтоос үл хамааран) хамгийн ихдээ 15 минут ажиллуулна.
//
// Урсгал:
// 1. requestId-аар Firestore дээр "pending" статустай бичлэг үүсгэнэ
// 2. Gemini image API дуудаж шинэ photoshoot зураг үүсгэнэ
// 3. Үр дүнг GitHub repo руу commit хийнэ
// 4. Firestore бичлэгийг "done" (эсвэл алдаа гарвал "error") болгож шинэчилнэ
// 5. Frontend талд шууд хариу буцаахгүй — тэнд өөр status.js функцээр polling хийнэ

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

// ---------- GitHub raw URL-аас зураг татаж base64 болгох ----------
// Дөнгөж commit хийсэн файл raw.githubusercontent.com дээр CDN-ий улмаас
// хэдэн секунд саатаж болзошгүй тул 3 удаа хүртэл дахин оролдоно.
async function fetchImageAsBase64(url) {
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url);
    if (res.ok) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  if (!res || !res.ok) {
    throw new Error(`Оролтын зураг татахад алдаа гарлаа: ${url}`);
  }
  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const mimeType = res.headers.get('content-type') || 'image/jpeg';
  return { base64, mimeType };
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
      parts.push({ text: `IMAGE ${i + 2} — STYLE REFERENCE ONLY. Look at this only to understand the mood, color palette, lighting quality, and composition style. Do NOT use this image as a base canvas or background plate. Do NOT paste, overlay, or composite the product onto this exact photo. Do NOT reuse its exact background, framing, or any of its other objects/props pixel-for-pixel. You must imagine and render a completely NEW photograph in a similar style — not edit or build on top of this one:` });
      parts.push({ inline_data: { mime_type: ref.mimeType, data: ref.base64 } });
    });
  }

  parts.push({
    text: [
      fullPrompt,
      'You must generate a brand-new composed image — never return IMAGE 1 or any reference image unchanged or uncropped.',
      'The output must clearly show IMAGE 1\'s product placed inside a newly rendered scene, as one single believable photograph with unified lighting, shadows, and styling — not a cut-and-paste collage of separate objects.',
      referenceImages && referenceImages.length
        ? 'IMPORTANT: the output must NOT be the reference photo with the product pasted on top of it. Treat the reference purely as a mood board — render an entirely original scene that merely shares its style, not its literal pixels, background, or props.'
        : ''
    ].filter(Boolean).join(' ')
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

  // Background function-д цаг хугацааны дарамт бага тул 503 (high demand) үед
  // 2 удаа хүртэл, backoff-той дахин оролдоно.
  let attempt = 0;
  while (res.status === 503 && attempt < 2) {
    attempt++;
    await new Promise(r => setTimeout(r, attempt * 4000));
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

  // Payload одоо зөвхөн URL агуулна (base64 биш) — background function-ий
  // ~256KB payload хязгаарт багтаах зорилготой. Зургууд upload-input.js-аар
  // дамжуулан GitHub-д аль хэдийн commit хийгдсэн байна.
  const { requestId, brand, description, productImageUrl, referenceImageUrls } = JSON.parse(event.body);

  if (!requestId || !brand || !productImageUrl) {
    console.error('Дутуу параметр:', { requestId: !!requestId, brand, productImageUrl: !!productImageUrl });
    return { statusCode: 400, body: 'requestId, brand, productImageUrl шаардлагатай' };
  }

  const db = getDb();
  const docRef = db.collection('photoshoots').doc(requestId);

  // 1. Эхлээд "pending" статустай бичлэг үүсгэнэ — frontend үүнийг шууд polling хийж эхэлнэ
  await docRef.set({
    status: 'pending',
    brand,
    description: description || null,
    referenceCount: (referenceImageUrls || []).length,
    createdAt: new Date().toISOString()
  });

  try {
    // 2. GitHub-с оролтын зургуудыг татаж base64 болгоно
    const productImage = await fetchImageAsBase64(productImageUrl);
    const referenceImages = [];
    for (const url of (referenceImageUrls || [])) {
      referenceImages.push(await fetchImageAsBase64(url));
    }

    // Ерөнхий (base) prompt — үргэлж хэрэглэгдэнэ, доор нь хэрэглэгчийн бичсэн
    // тайлбар нэмэгдэж холбогдоно.
    const BASE_PROMPT = [
      'Generate a single, cohesive, high-resolution professional product photoshoot image, similar in style and mood to the attached reference image(s) if provided, featuring the attached product image.',
      'Keep the product itself (shape, color, logo, text, proportions) completely unchanged — only the surrounding scene, background, and lighting should change.',
      'CRITICAL COMPOSITION RULES: this must look like ONE real photograph taken in a single shot, never like a collage of separately-photographed objects pasted together.',
      'Do NOT use any reference image as the base photo/canvas and place the product on top of it — that produces an obviously fake, pasted-on look. Instead, render a completely new scene from scratch that only borrows the mood, palette, and lighting style of the reference.',
      'Every element in the frame must share the exact same light source, direction, color temperature, and shadow softness.',
      'Objects must rest naturally on surfaces with physically accurate contact shadows and realistic scale relative to each other — nothing should look flat, cut-out, or floating.',
      'Arrange the scene like an experienced stylist would: intentional, balanced, uncluttered composition with clear visual hierarchy around the product — not a random pile of unrelated items.',
      'If multiple props are present, keep the palette and materials harmonious with the product and with each other; when in doubt, use fewer, more deliberate props rather than many mismatched ones.'
    ].join(' ');

    const fullPrompt = [
      BASE_PROMPT,
      description ? `Additional direction from the user: ${description}.` : '',
      referenceImages.length
        ? 'Reference images are attached below purely for style, background, and lighting inspiration — do not simply copy every object from them; adapt only the mood, palette, and composition style to suit the product.'
        : '',
      'High resolution, natural lighting, commercial product photography quality, shot on a full-frame camera with shallow depth of field.'
    ].filter(Boolean).join(' ');

    // 3. Gemini-с зураг үүсгэх
    const generated = await generateWithGemini({
      productImage,
      referenceImages,
      fullPrompt
    });

    // 4. Үр дүнгийн зургийг GitHub-д хадгалах
    const extension = (generated.mimeType || 'image/png').split('/')[1] || 'png';
    const imageUrl = await commitImageToGithub({
      base64Data: generated.base64Data,
      brand,
      extension
    });

    // 5. Firestore бичлэгийг "done" болгож шинэчилнэ
    await docRef.update({
      status: 'done',
      imageUrl,
      completedAt: new Date().toISOString()
    });

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error(err);
    // 5b. Алдаа гарвал "error" статус бичээд, frontend талд ойлгомжтой мессеж үлдээнэ
    await docRef.update({
      status: 'error',
      errorMessage: err.message || 'Тодорхойгүй алдаа',
      completedAt: new Date().toISOString()
    });
    return { statusCode: 200, body: 'handled error' };
  }
};
