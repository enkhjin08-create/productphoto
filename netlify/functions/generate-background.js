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

// ---------- Бүтээгдэхүүнийг дэвсгэрээс нь цэвэрхэн тайрч авах (remove.bg) ----------
// ЯАГААД: Photoroom зэрэг мэргэжлийн tool-ууд бүтээгдэхүүний pixel-ийг ХЭЗЭЭ Ч
// дахин зурдаггүй — зөвхөн нарийн segmentation-оор тайрч аваад шинэ дэвсгэр дээр
// байрлуулдаг. Ингэснээр лого, текст, нарийн ширхэг 100% хадгалагдана. Манай
// өмнөх (Gemini-ээр бүхэлд нь дахин зурах) арга нарийвчлал алддаг байсан тул
// одоо ижил зарчмаар ажиллана.
async function removeBackground(base64, mimeType) {
  const apiKey = process.env.REMOVEBG_API_KEY;
  if (!apiKey) {
    throw new Error('REMOVEBG_API_KEY тохируулагдаагүй байна (Netlify env var).');
  }

  const res = await fetch('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      image_file_b64: base64,
      size: 'auto',
      format: 'png'
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`remove.bg алдаа: ${errText}`);
  }

  const buffer = await res.arrayBuffer();
  return { base64: Buffer.from(buffer).toString('base64'), mimeType: 'image/png' };
}

// ---------- Зөвхөн дэвсгэр (бүтээгдэхүүнгүй) зураг үүсгэх ----------
// Бүтээгдэхүүн энд огт оролцохгүй тул Gemini reference-ийн mood-г дуурайхдаа
// бодит бүтээгдэхүүнтэй "тэмцэх" шаардлагагүй — зөвхөн орчин, гэрэлтүүлэг,
// өнгийг цэвэр дүрсэлнэ.
async function generateBackgroundScene(fullPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-2.5-flash-image';

  const parts = [{
    text: [
      fullPrompt,
      'Generate ONLY the empty scene/background for this photoshoot — do NOT include any product, person, hand, or object that would be the main subject.',
      'Leave a clear, uncluttered open area (a surface, floor, or open space) roughly in the lower-center of the frame, where a product will be composited in afterward.',
      'Square 1:1 aspect ratio, high resolution, photographically realistic (not illustration/render style).'
    ].join(' ')
  }];

  const callGemini = () => fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] })
    }
  );

  let res = await callGemini();
  let attempt = 0;
  while (res.status === 503 && attempt < 2) {
    attempt++;
    await new Promise(r => setTimeout(r, attempt * 4000));
    res = await callGemini();
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API алдаа (дэвсгэр): ${errText}`);
  }

  const data = await res.json();
  const responseParts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = responseParts.find(p => p.inlineData || p.inline_data);
  if (!imagePart) {
    throw new Error('Gemini дэвсгэр зураг буцаагүй байна.');
  }
  const inline = imagePart.inlineData || imagePart.inline_data;
  return { base64: inline.data, mimeType: inline.mimeType || inline.mime_type };
}

// ---------- Бүтээгдэхүүний cutout-ийг дэвсгэр дээр байрлуулж, сүүдэртэй нэгтгэх ----------
// sharp ашиглан deterministic (тогтмол, найдвартай) байдлаар composite хийнэ —
// AI биш, тиймээс бүтээгдэхүүний pixel 100% хадгалагдана.
async function compositeProductOntoBackground({ cutoutBase64, backgroundBase64 }) {
  const sharp = require('sharp');
  const CANVAS_SIZE = 1600;

  const cutoutBuffer = Buffer.from(cutoutBase64, 'base64');
  const backgroundBuffer = Buffer.from(backgroundBase64, 'base64');

  // Дэвсгэрийг канвасын хэмжээнд бүрэн дүүргэж тааруулна
  const background = await sharp(backgroundBuffer)
    .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: 'cover' })
    .toBuffer();

  // Бүтээгдэхүүнийг канвасын ойролцоогоор 55% өргөнд багтаана
  const targetWidth = Math.round(CANVAS_SIZE * 0.55);
  const cutoutResizer = sharp(cutoutBuffer).resize({ width: targetWidth, withoutEnlargement: true });
  const cutoutMeta = await cutoutResizer.metadata();
  const cutoutFinalBuffer = await cutoutResizer.toBuffer();
  const cutoutW = cutoutMeta.width || targetWidth;
  const cutoutH = cutoutMeta.height || targetWidth;

  const left = Math.round((CANVAS_SIZE - cutoutW) / 2);
  const top = Math.round(CANVAS_SIZE * 0.62 - cutoutH / 2); // арай доод хэсэгт "hero" байрлал

  // Зөөлөн бүдгэрсэн эллипс сүүдэр (SVG)
  const shadowWidth = Math.round(cutoutW * 0.8);
  const shadowHeight = Math.round(cutoutW * 0.18);
  const shadowSvg = `<svg width="${shadowWidth}" height="${shadowHeight}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="g" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="black" stop-opacity="0.38"/>
        <stop offset="100%" stop-color="black" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <ellipse cx="${shadowWidth / 2}" cy="${shadowHeight / 2}" rx="${shadowWidth / 2}" ry="${shadowHeight / 2}" fill="url(#g)"/>
  </svg>`;
  const shadowBuffer = await sharp(Buffer.from(shadowSvg)).png().toBuffer();
  const shadowLeft = Math.round((CANVAS_SIZE - shadowWidth) / 2);
  const shadowTop = Math.round(top + cutoutH - shadowHeight * 0.55);

  const finalBuffer = await sharp(background)
    .composite([
      { input: shadowBuffer, left: shadowLeft, top: shadowTop },
      { input: cutoutFinalBuffer, left, top }
    ])
    .png()
    .toBuffer();

  return finalBuffer.toString('base64');
}

// ---------- Gemini image API дуудах (ЗАСВАР/EDIT горимд ашиглагдана) ----------
// productImage: { base64, mimeType } — өөрчлөгдөхгүй байх ёстой бүтээгдэхүүн
// referenceStyleText: reference зургуудаас урьдчилан гаргуулсан текст тайлбар (pixel биш!)
async function generateWithGemini({ productImage, referenceStyleText, fullPrompt }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-2.5-flash-image';

  // ЗОРИЛГОТОЙГООР зөвхөн productImage-ийг pixel хэлбэрээр өгнө. Reference-ийн
  // pixel-ийг энд огт дамжуулахгүй тул загвар түүнийг хуулбарлах боломжгүй.
  const parts = [];

  parts.push({ text: 'THE EXISTING PHOTO — its shape, logo, printed text, and true colors of the product must stay 100% recognizable while you apply the requested edit:' });
  parts.push({ inline_data: { mime_type: productImage.mimeType, data: productImage.base64 } });

  parts.push({
    text: [
      fullPrompt,
      'Apply the requested edit while keeping the photo as ONE cohesive, believable photograph with unified lighting, shadows, and styling — not a collage.',
      'Never return the input photo completely unchanged if an edit was requested.'
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
  // mode: 'compose' (анхны generate — segmentation+composite) | 'edit' (Дахин
  // үүсгэх/засварлах — бүтэн зургийг Gemini-ээр шууд edit хийнэ)
  const { requestId, brand, description, productImageUrl, referenceImageUrls, mode } = JSON.parse(event.body);
  const effectiveMode = mode === 'edit' ? 'edit' : 'compose';

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
    mode: effectiveMode,
    referenceCount: (referenceImageUrls || []).length,
    createdAt: new Date().toISOString()
  });

  try {
    let finalBase64;
    let finalExtension;

    if (effectiveMode === 'compose') {
      // ---------- COMPOSE ГОРИМ: segmentation + дэвсгэр generate + composite ----------
      const productImage = await fetchImageAsBase64(productImageUrl);
      const referenceImages = [];
      for (const url of (referenceImageUrls || [])) {
        referenceImages.push(await fetchImageAsBase64(url));
      }

      let referenceStyleText = null;
      if (referenceImages.length) {
        referenceStyleText = await describeReferenceStyle(referenceImages);
      }

      const BASE_PROMPT = [
        'Generate a single, cohesive, high-resolution professional product photoshoot BACKGROUND SCENE.',
        'CRITICAL COMPOSITION RULES: this must look like ONE real photograph taken in a single shot, with a clear, intentional, uncluttered composition — not a random pile of unrelated items.',
        'Arrange the scene like an experienced stylist would: balanced composition with clear visual hierarchy, leaving open space in the lower-center for a product to be placed afterward.',
        'If props are present, keep the palette and materials harmonious; when in doubt, use fewer, more deliberate props rather than many mismatched ones.',
        'PREMIUM COLOR GRADING & FINISH: apply polished, high-end commercial color grading — rich but controlled saturation, deep confident contrast (not flat or washed out), clean true blacks and bright-but-not-blown highlights, a subtle cinematic tone curve like a big-budget ad campaign.',
        'Avoid a dull, flat, snapshot, or amateur look at all costs — this must feel like it belongs in a premium brand advertisement.'
      ].join(' ');

      const fullPrompt = [
        BASE_PROMPT,
        description ? `Additional direction from the user: ${description}.` : '',
        referenceStyleText ? `Style/mood direction (described in words only): ${referenceStyleText}` : '',
        'High resolution, natural lighting, commercial product photography quality, shot on a full-frame camera with shallow depth of field, premium advertising color grade.'
      ].filter(Boolean).join(' ');

      // 2. Бүтээгдэхүүнийг дэвсгэрээс нь цэвэрхэн тайрч авах (pixel 100% хадгалагдана)
      const cutout = await removeBackground(productImage.base64, productImage.mimeType);

      // 3. Зөвхөн дэвсгэр зураг Gemini-ээр үүсгэх (бүтээгдэхүүнгүй)
      const background = await generateBackgroundScene(fullPrompt);

      // 4. Хоёуланг нь sharp-аар deterministic байдлаар нэгтгэх
      finalBase64 = await compositeProductOntoBackground({
        cutoutBase64: cutout.base64,
        backgroundBase64: background.base64
      });
      finalExtension = 'png';
    } else {
      // ---------- EDIT ГОРИМ: өмнөх бүтэн зургийг Gemini-ээр шууд засварлах ----------
      const productImage = await fetchImageAsBase64(productImageUrl);

      const fullPrompt = [
        'Apply the following edit to this existing product photoshoot image while keeping the product itself fully recognizable (shape, logo, text, proportions unchanged):',
        description ? description : 'Improve the overall lighting and color grading.',
        'The result must remain ONE cohesive, believable photograph — not a collage.'
      ].join(' ');

      const generated = await generateWithGemini({
        productImage,
        referenceStyleText: null,
        fullPrompt
      });
      finalBase64 = generated.base64Data;
      finalExtension = (generated.mimeType || 'image/png').split('/')[1] || 'png';
    }

    // 5. Үр дүнгийн зургийг GitHub-д хадгалах
    const imageUrl = await commitImageToGithub({
      base64Data: finalBase64,
      brand,
      extension: finalExtension
    });

    // 6. Firestore бичлэгийг "done" болгож шинэчилнэ
    await docRef.update({
      status: 'done',
      imageUrl,
      completedAt: new Date().toISOString()
    });

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error(err);
    // 6b. Алдаа гарвал "error" статус бичээд, frontend талд ойлгомжтой мессеж үлдээнэ
    await docRef.update({
      status: 'error',
      errorMessage: err.message || 'Тодорхойгүй алдаа',
      completedAt: new Date().toISOString()
    });
    return { statusCode: 200, body: 'handled error' };
  }
};
