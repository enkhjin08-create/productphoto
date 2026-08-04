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

// ---------- Reference зургийг ЗӨВХӨН текст тайлбар болгож хувиргах ----------
// ЯАГААД: Gemini image model-д reference зургийг pixel хэлбэрээр өгвөл, текст
// зааврыг үл хайхран, reference-ийг шууд суурь болгоод бүтээгдэхүүнийг л дээр
// нь наах хандлагатай байдаг (бид үүнийг олон удаа туршилтаар баталсан). Үүнийг
// бүрмөсөн шийдэх цорын ганц найдвартай арга бол: эцсийн зураг үүсгэх дуудалтад
// reference-ийн pixel-ийг огт өгөхгүй, зөвхөн Gemini-ээр урьдчилан гаргуулсан
// текст тайлбарыг (mood, өнгө, гэрэлтүүлэг, орчны төрөл) ашиглах.
async function describeReferenceStyle(referenceImages) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-2.5-flash';

  const parts = [
    {
      text: [
        'Look at the attached photo(s) purely as an aesthetic mood board.',
        'In 2-3 concise sentences, describe ONLY the reusable style qualities: type of setting/background, lighting quality and direction, color palette, materials/textures visible, and overall mood.',
        'Do NOT mention or describe any people, faces, specific products, or identifiable objects in the photo(s) — focus exclusively on background, lighting, and color/mood, since this description will guide an entirely unrelated new photoshoot.'
      ].join(' ')
    }
  ];

  referenceImages.forEach(ref => {
    parts.push({ inline_data: { mime_type: ref.mimeType, data: ref.base64 } });
  });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] })
    }
  );

  if (!res.ok) {
    // Тайлбар авахад алдаа гарвал generate-ийг зогсоохгүй, зүгээр л reference-гүйгээр үргэлжлүүлнэ
    console.error('describeReferenceStyle алдаа:', await res.text());
    return null;
  }

  const data = await res.json();
  const textPart = data?.candidates?.[0]?.content?.parts?.find(p => p.text);
  return textPart ? textPart.text.trim() : null;
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
// referenceStyleText: reference зургуудаас урьдчилан гаргуулсан текст тайлбар (pixel биш!)
async function generateWithGemini({ productImage, referenceStyleText, fullPrompt }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-2.5-flash-image';

  // ЗОРИЛГОТОЙГООР зөвхөн productImage-ийг pixel хэлбэрээр өгнө. Reference-ийн
  // pixel-ийг энд огт дамжуулахгүй тул загвар түүнийг хуулбарлах боломжгүй.
  const parts = [];

  parts.push({ text: 'THE PRODUCT — its shape, logo, printed text, and true colors must stay 100% recognizable, but you MUST re-light it, re-grade its color/contrast, and render it from a natural camera angle so it photographically belongs in the new scene (see integration rules below):' });
  parts.push({ inline_data: { mime_type: productImage.mimeType, data: productImage.base64 } });

  parts.push({
    text: [
      fullPrompt,
      referenceStyleText ? `Style/mood direction (derived from a reference photo, described in words only — no pixels from that photo are provided, so you must imagine and render a completely new scene): ${referenceStyleText}` : '',
      'You must generate a brand-new composed image — never return the product photo unchanged or uncropped.',
      'The output must clearly show the product placed inside a newly rendered scene, as one single believable photograph with unified lighting, shadows, and styling — not a cut-and-paste collage of separate objects.'
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

    // Reference зургууд байвал, тэдгээрийг эхлээд ЗӨВХӨН текст тайлбар болгож
    // хувиргана (яагаад гэдгийг дээрх describeReferenceStyle-ийн тайлбараас үзнэ үү).
    let referenceStyleText = null;
    if (referenceImages.length) {
      referenceStyleText = await describeReferenceStyle(referenceImages);
    }

    // Ерөнхий (base) prompt — үргэлж хэрэглэгдэнэ, доор нь хэрэглэгчийн бичсэн
    // тайлбар нэмэгдэж холбогдоно.
    const BASE_PROMPT = [
      'Generate a single, cohesive, high-resolution professional product photoshoot image featuring the attached product image.',
      'PRODUCT IDENTITY (must stay 100% recognizable): keep the product\'s shape, proportions, logo, printed text, and true colors exactly as shown — never redesign, restyle, or alter the product itself.',
      'PHOTOGRAPHIC INTEGRATION (this is required, not optional): the product must be re-rendered as if it were physically photographed inside the new scene — re-light it to match the new scene\'s light source direction, intensity, and color temperature; add matching highlights, reflections, and soft shadows/contact shadows where it touches any surface; apply the same subtle color grading (white balance, warmth, contrast) as the rest of the photo so the product does not look color-mismatched or "pasted on".',
      'PERSPECTIVE: render the product from a camera angle and distance that feels natural for this specific scene and composition — do not simply reuse the exact angle/crop from the original product photo if it would look inconsistent with how the scene is framed; the product\'s implied camera position must match the rest of the photograph.',
      'CRITICAL COMPOSITION RULES: this must look like ONE real photograph taken in a single shot, never like a collage of separately-photographed objects pasted together, and never like a flat sticker overlaid on a background.',
      'Every element in the frame must share the exact same light source, direction, color temperature, and shadow softness.',
      'Objects must rest naturally on surfaces with physically accurate contact shadows and realistic scale relative to each other — nothing should look flat, cut-out, or floating.',
      'Arrange the scene like an experienced stylist would: intentional, balanced, uncluttered composition with clear visual hierarchy around the product — not a random pile of unrelated items.',
      'If multiple props are present, keep the palette and materials harmonious with the product and with each other; when in doubt, use fewer, more deliberate props rather than many mismatched ones.'
    ].join(' ');

    const fullPrompt = [
      BASE_PROMPT,
      description ? `Additional direction from the user: ${description}.` : '',
      'High resolution, natural lighting, commercial product photography quality, shot on a full-frame camera with shallow depth of field.'
    ].filter(Boolean).join(' ');

    // 3. Gemini-с зураг үүсгэх (reference-ийн pixel биш, зөвхөн текст тайлбар дамжуулна)
    const generated = await generateWithGemini({
      productImage,
      referenceStyleText,
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
