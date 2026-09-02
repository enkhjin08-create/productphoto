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
        'Look at the attached photo(s) as a location/style scout would, to brief a product photographer on where and how to shoot.',
        'Write 4-6 concise, specific, visually descriptive sentences covering: the TYPE of location/setting in detail (e.g. outdoor coastal walkway with stone balustrade overlooking the sea and hills, or indoor minimalist wooden cafe table by a window, etc.), any distinctive surfaces/materials/architecture visible (stone, wood, water, tile, fabric, plants, sky, etc.), the lighting direction/quality/time of day, the overall color palette, and the general mood/atmosphere.',
        'Be concrete and specific rather than generic — name actual visual elements you see (e.g. "weathered stone balustrade", "distant hills and calm sea", "overcast soft daylight") so a photographer could recreate a similar-feeling scene without seeing the original photo.',
        'Do NOT describe or mention any people, faces, or the specific product/subject being held or worn — skip over them entirely and describe only the environment around them.'
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

// ---------- Дэвсгэр зураг дээр бүтээгдэхүүнийг хаана, ямар хэмжээгээр байрлуулбал
// зохимжтой болохыг Gemini-ээр ("ухаалаг" placement) тодорхойлуулах ----------
// Тогтмол heuristic (төв, 55%)-ийн оронд, зурган бүрд тохирсон байрлал/хэмжээг
// динамик санал болгуулна. Алдаа гарвал null буцааж, дуудагч тал default руу шилжинэ.
async function analyzePlacement(backgroundBase64) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-2.5-flash';

  const parts = [
    {
      text: [
        'This image is a photoshoot background scene with intentionally left empty space where a product will be placed afterward.',
        'Respond with ONLY a raw JSON object (no markdown fences, no explanation) with exactly these fields:',
        '"xRatio": number 0-1, the horizontal center of the empty placement area as a fraction of image width;',
        '"yRatio": number 0-1, the vertical CENTER of where the product should sit as a fraction of image height (usually resting on a visible surface, so above the bottom edge);',
        '"widthRatio": number 0-1, the suggested width of the product relative to the full image width so it looks proportionate and well-scaled for this specific scene.',
        'Example response: {"xRatio":0.5,"yRatio":0.6,"widthRatio":0.5}'
      ].join(' ')
    },
    { inline_data: { mime_type: 'image/png', data: backgroundBase64 } }
  ];

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] })
      }
    );
    if (!res.ok) {
      console.error('analyzePlacement алдаа:', await res.text());
      return null;
    }
    const data = await res.json();
    const textPart = data?.candidates?.[0]?.content?.parts?.find(p => p.text);
    if (!textPart) return null;
    const cleaned = textPart.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (
      typeof parsed.xRatio === 'number' &&
      typeof parsed.yRatio === 'number' &&
      typeof parsed.widthRatio === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch (err) {
    console.error('analyzePlacement алдаа:', err);
    return null;
  }
}

// ---------- Цэвэр, зөөлөн градиент дэвсгэр үүсгэх (Product Beautifier горимд) ----------
// Gemini дуудалт огт хэрэггүй тул хурдан бөгөөд хямд — цэвэр e-commerce каталогийн
// маягийн дэвсгэр, brand-ийн өнгөтэй тохирсон зөөлөн градиент.
async function generateSolidBackdrop(brand) {
  const sharp = require('sharp');
  const CANVAS_SIZE = 1600;

  const BRAND_GRADIENTS = {
    zuvhuntuund: ['#f7f0ec', '#e9d8d2'],
    meowie: ['#fdf3e6', '#f6dcb9'],
    cutecups: ['#f7f0fb', '#e9d9f2']
  };
  const [c1, c2] = BRAND_GRADIENTS[brand] || ['#f5f5f2', '#e6e4df'];

  const svg = `<svg width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="bg" cx="50%" cy="40%" r="75%">
        <stop offset="0%" stop-color="${c1}"/>
        <stop offset="100%" stop-color="${c2}"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
  </svg>`;

  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { base64: buffer.toString('base64') };
}

// ---------- Бүтээгдэхүүний cutout-ийг дэвсгэр дээр байрлуулж, сүүдэртэй нэгтгэх ----------
// sharp ашиглан deterministic (тогтмол, найдвартай) байдлаар composite хийнэ —
// AI биш, тиймээс бүтээгдэхүүний pixel 100% хадгалагдана.
// placement: { xRatio, yRatio, widthRatio } — analyzePlacement-с ирсэн эсвэл default
async function compositeProductOntoBackground({ cutoutBase64, backgroundBase64, placement }) {
  const sharp = require('sharp');
  const CANVAS_SIZE = 1600;

  const xRatio = placement && typeof placement.xRatio === 'number' ? placement.xRatio : 0.5;
  const yRatio = placement && typeof placement.yRatio === 'number' ? placement.yRatio : 0.62;
  const widthRatio = placement && typeof placement.widthRatio === 'number' ? placement.widthRatio : 0.55;

  const cutoutBuffer = Buffer.from(cutoutBase64, 'base64');
  const backgroundBuffer = Buffer.from(backgroundBase64, 'base64');

  // Дэвсгэрийг канвасын хэмжээнд бүрэн дүүргэж тааруулна
  const background = await sharp(backgroundBuffer)
    .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: 'cover' })
    .toBuffer();

  // Бүтээгдэхүүнийг санал болгосон (эсвэл default) өргөнд багтаана
  const targetWidth = Math.round(CANVAS_SIZE * Math.min(Math.max(widthRatio, 0.2), 0.85));
  const cutoutResizer = sharp(cutoutBuffer).resize({ width: targetWidth, withoutEnlargement: true });
  const cutoutMeta = await cutoutResizer.metadata();
  const cutoutFinalBuffer = await cutoutResizer.toBuffer();
  const cutoutW = cutoutMeta.width || targetWidth;
  const cutoutH = cutoutMeta.height || targetWidth;

  // Канвасаас гарахгүй байхаар clamp хийнэ
  let left = Math.round(CANVAS_SIZE * xRatio - cutoutW / 2);
  let top = Math.round(CANVAS_SIZE * yRatio - cutoutH / 2);
  left = Math.max(0, Math.min(left, CANVAS_SIZE - cutoutW));
  top = Math.max(0, Math.min(top, CANVAS_SIZE - cutoutH));

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
  let shadowLeft = Math.round(left + cutoutW / 2 - shadowWidth / 2);
  let shadowTop = Math.round(top + cutoutH - shadowHeight * 0.55);
  shadowLeft = Math.max(0, Math.min(shadowLeft, CANVAS_SIZE - shadowWidth));
  shadowTop = Math.max(0, Math.min(shadowTop, CANVAS_SIZE - shadowHeight));

  const finalBuffer = await sharp(background)
    .composite([
      { input: shadowBuffer, left: shadowLeft, top: shadowTop },
      { input: cutoutFinalBuffer, left, top }
    ])
    .png()
    .toBuffer();

  return finalBuffer.toString('base64');
}

// ---------- Gemini image API дуудах (ЗАСВАР/EDIT ба VIRTUAL MODEL горимд ашиглагдана) ----------
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
  // shootType: 'lifestyle' (default) | 'flatlay' | 'beautifier' | 'model'
  const { requestId, brand, description, productImageUrl, referenceImageUrls, mode, shootType } = JSON.parse(event.body);
  const effectiveMode = mode === 'edit' ? 'edit' : 'compose';
  const effectiveShootType = ['flatlay', 'beautifier', 'model', 'campaign'].includes(shootType) ? shootType : 'lifestyle';

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
    shootType: effectiveShootType,
    referenceCount: (referenceImageUrls || []).length,
    createdAt: new Date().toISOString()
  });

  try {
    let finalBase64;
    let finalExtension;

    if (effectiveMode === 'compose' && effectiveShootType === 'model') {
      // ---------- VIRTUAL MODEL ГОРИМ: segmentation ашиглахгүй ----------
      // Учир нь бодит хүн загварт cutout-ийг deterministic байдлаар зохимжтой
      // байрлуулах боломжгүй (pose, хэмжээ, өнгөлөг зэрэг маш нарийн warping
      // шаардана) — тиймээс энд Gemini-ээр бүхэлд нь дахин зурах хуучин аргыг
      // санаатайгаар ашиглана (бүтээгдэхүүний identity хадгалах зааврыг хатуу
      // тавьсан хэвээр).
      const productImage = await fetchImageAsBase64(productImageUrl);
      const referenceImages = [];
      for (const url of (referenceImageUrls || [])) {
        referenceImages.push(await fetchImageAsBase64(url));
      }
      let referenceStyleText = null;
      if (referenceImages.length) {
        referenceStyleText = await describeReferenceStyle(referenceImages);
      }

      const fullPrompt = [
        'Generate a professional lifestyle/editorial photo of a realistic human model naturally wearing, holding, or using this exact product — choose the most natural interaction based on what kind of product it is (worn on shoulder/back if it is a bag, held in hand if small, worn on the body if clothing, etc.).',
        'PRODUCT IDENTITY: the product\'s shape, logo, printed text, and true colors must stay 100% recognizable.',
        'The model should look natural, candid, and professionally lit, with premium commercial color grading — not a flat snapshot.',
        description ? `Additional direction from the user: ${description}.` : '',
        referenceStyleText ? `Style/mood reference (described in words only): ${referenceStyleText}` : ''
      ].filter(Boolean).join(' ');

      const generated = await generateWithGemini({ productImage, referenceStyleText: null, fullPrompt });
      finalBase64 = generated.base64Data;
      finalExtension = (generated.mimeType || 'image/png').split('/')[1] || 'png';
    } else if (effectiveMode === 'compose' && effectiveShootType === 'campaign') {
      // ---------- CAMPAIGN ГОРИМ: нэг бүтээгдэхүүнээс олон orchин зэрэг үүсгэх ----------
      // Cutout (remove.bg) ЗӨВХӨН НЭГ УДАА тооцоологдоно — доорх бүх orchинд ижил
      // cutout-ийг дахин ашигладаг тул бүтээгдэхүүний identity (лого, хэлбэр, өнгө)
      // orchин бүрт 100% ижил хэвээр байна, MEC-ийн жишээ пост дээрх шиг.
      const productImage = await fetchImageAsBase64(productImageUrl);
      const cutout = await removeBackground(productImage.base64, productImage.mimeType);

      // Хэрэглэгч "Тайлбар" талбарт мөр мөрөөр өөрийн orchин бичсэн бол ашиглана,
      // үгүй бол brand тус бүрийн 5 стандарт orchин.
      const customScenes = (description || '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

      const DEFAULT_CAMPAIGN_SCENES = {
        meowie: [
          'Cozy warm wooden shelf with a small potted plant and soft knit blanket blurred in the background, soft afternoon window light from the left',
          'Clean studio flat backdrop in soft cream/beige tone with subtle shadow beneath the product, minimal styling, one small dried flower stem to the side',
          'Round marble side table with a blurred cozy cat-cafe interior in the background, warm string lights and plants, natural warm lighting',
          'Outdoor pastel picnic blanket with soft dappled sunlight and blurred greenery in the background, slight overhead angle',
          'Extreme close-up on a soft neutral surface showing fine texture and detail, gentle directional light creating soft highlights'
        ],
        zuvhuntuund: [
          'Warm minimalist wooden desk with soft daylight from a window, a cup of tea blurred nearby',
          'Clean studio backdrop in soft blush tone with subtle shadow, one dried flower stem styling',
          'Cozy reading nook with a knit blanket and soft lamp light in the blurred background',
          'Outdoor cafe table with warm afternoon sunlight and blurred greenery',
          'Extreme close-up showing fine paper/material texture and detail with soft directional light'
        ],
        cutecups: [
          'Bright kitchen counter with soft morning light and blurred greenery in the background',
          'Clean studio backdrop in soft lavender tone with subtle shadow, minimal styling',
          'Cozy cafe table scene with warm ambient light and blurred cups in the background',
          'Outdoor picnic setting with soft dappled sunlight',
          'Extreme close-up showing fine texture and glaze detail with soft directional light'
        ]
      };

      const scenes = customScenes.length
        ? customScenes
        : (DEFAULT_CAMPAIGN_SCENES[brand] || DEFAULT_CAMPAIGN_SCENES.meowie);

      const SHARED_TAIL = [
        'PREMIUM COLOR GRADING & FINISH: apply polished, high-end commercial color grading — rich but controlled saturation, deep confident contrast, clean true blacks and bright-but-not-blown highlights, a subtle cinematic tone curve like a big-budget ad campaign.',
        'Avoid a dull, flat, snapshot, or amateur look at all costs — this must feel like it belongs in a premium brand advertisement.'
      ].join(' ');

      const campaignImageUrls = [];
      // Хамгийн ихдээ 6 orchин — Netlify background function-ий 15 минутын
      // хугацаанд бүгд багтаах үүднээс хязгаарлав.
      for (const scene of scenes.slice(0, 6)) {
        const fullPrompt = [
          'Generate a single, cohesive, high-resolution professional product photoshoot BACKGROUND SCENE.',
          'CRITICAL COMPOSITION RULES: this must look like ONE real photograph taken in a single shot, with a clear, intentional, uncluttered composition — not a random pile of unrelated items.',
          `SCENE: ${scene}.`,
          'Leave a clear, uncluttered open area (a surface, floor, or open space) roughly in the lower-center of the frame, where a product will be composited in afterward.',
          SHARED_TAIL
        ].join(' ');

        try {
          const background = await generateBackgroundScene(fullPrompt);
          const placement = await analyzePlacement(background.base64);
          const composited = await compositeProductOntoBackground({
            cutoutBase64: cutout.base64,
            backgroundBase64: background.base64,
            placement
          });
          const url = await commitImageToGithub({ base64Data: composited, brand, extension: 'png' });
          campaignImageUrls.push(url);
        } catch (sceneErr) {
          // Нэг orchин амжилтгүй болсон ч бусдыг нь үргэлжлүүлнэ
          console.error('Campaign orchин алдаа (алгасав):', sceneErr.message);
        }
      }

      if (!campaignImageUrls.length) {
        throw new Error('Ямар ч orchин амжилттай үүсгэгдсэнгүй.');
      }

      await docRef.update({
        status: 'done',
        imageUrl: campaignImageUrls[0],
        imageUrls: campaignImageUrls,
        completedAt: new Date().toISOString()
      });

      return { statusCode: 200, body: 'OK' };
    } else if (effectiveMode === 'compose') {
      // ---------- LIFESTYLE / FLAT LAY / BEAUTIFIER: segmentation + composite ----------
      const productImage = await fetchImageAsBase64(productImageUrl);
      const referenceImages = [];
      for (const url of (referenceImageUrls || [])) {
        referenceImages.push(await fetchImageAsBase64(url));
      }

      let referenceStyleText = null;
      if (referenceImages.length) {
        referenceStyleText = await describeReferenceStyle(referenceImages);
      }

      // 2. Бүтээгдэхүүнийг дэвсгэрээс нь цэвэрхэн тайрч авах (pixel 100% хадгалагдана)
      const cutout = await removeBackground(productImage.base64, productImage.mimeType);

      let background;
      let placement;

      if (effectiveShootType === 'beautifier') {
        // Gemini дуудалт хэрэггүй — хурдан, цэвэр e-commerce каталог маягийн дэвсгэр
        background = await generateSolidBackdrop(brand);
        placement = { xRatio: 0.5, yRatio: 0.55, widthRatio: 0.6 };
      } else {
        const SHARED_TAIL = [
          'PREMIUM COLOR GRADING & FINISH: apply polished, high-end commercial color grading — rich but controlled saturation, deep confident contrast (not flat or washed out), clean true blacks and bright-but-not-blown highlights, a subtle cinematic tone curve like a big-budget ad campaign.',
          'Avoid a dull, flat, snapshot, or amateur look at all costs — this must feel like it belongs in a premium brand advertisement.'
        ].join(' ');

        const BASE_PROMPT = effectiveShootType === 'flatlay'
          ? [
              'Generate a single, cohesive, high-resolution FLAT LAY product photography BACKGROUND SCENE, shot from directly overhead (top-down / bird\'s-eye view).',
              'Show a flat surface filling the frame (e.g. wood table, marble counter, linen fabric, concrete, or similar), styled with a few harmonious, deliberate props arranged around a clear open area in the center where the product will be placed afterward.',
              'If props are present, keep the palette and materials harmonious; when in doubt, use fewer, more deliberate props rather than many mismatched ones.',
              SHARED_TAIL
            ].join(' ')
          : [
              'Generate a single, cohesive, high-resolution professional product photoshoot BACKGROUND SCENE.',
              'CRITICAL COMPOSITION RULES: this must look like ONE real photograph taken in a single shot, with a clear, intentional, uncluttered composition — not a random pile of unrelated items.',
              'Arrange the scene like an experienced stylist would: balanced composition with clear visual hierarchy, leaving open space in the lower-center for a product to be placed afterward.',
              'If props are present, keep the palette and materials harmonious; when in doubt, use fewer, more deliberate props rather than many mismatched ones.',
              SHARED_TAIL
            ].join(' ');

        const fullPrompt = [
          // Reference тайлбар байвал эхэнд, ХАМГИЙН ЧУХАЛ зааврын хувьд байрлуулна —
          // ингэснээр generic "premium studio" boilerplate үүнийг дарж, Gemini
          // өөрийн "default" неутраль дэвсгэр рүү шилжихээс сэргийлнэ.
          referenceStyleText
            ? `PRIORITY SCENE BRIEF (this defines what the background must actually look like — follow it closely, do not default to a generic neutral studio backdrop instead): ${referenceStyleText}`
            : '',
          BASE_PROMPT,
          description ? `Additional direction from the user: ${description}.` : '',
          'High resolution, natural lighting, commercial product photography quality, shot on a full-frame camera with shallow depth of field, premium advertising color grade.'
        ].filter(Boolean).join(' ');

        // 3. Зөвхөн дэвсгэр зураг Gemini-ээр үүсгэх (бүтээгдэхүүнгүй)
        background = await generateBackgroundScene(fullPrompt);

        // 4. Уг дэвсгэрт тохирсон байрлал/хэмжээг Gemini-ээр ухаалаг тодорхойлуулах
        // (алдаа гарвал null буцаж, compositeProductOntoBackground default руу шилжинэ)
        placement = await analyzePlacement(background.base64);
        if (effectiveShootType === 'flatlay' && !placement) {
          placement = { xRatio: 0.5, yRatio: 0.5, widthRatio: 0.6 };
        }
      }

      // 5. Хоёуланг нь sharp-аар deterministic байдлаар нэгтгэх
      finalBase64 = await compositeProductOntoBackground({
        cutoutBase64: cutout.base64,
        backgroundBase64: background.base64,
        placement
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
