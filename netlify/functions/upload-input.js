// netlify/functions/upload-input.js
//
// SYNCHRONOUS function — Gemini орохгүй тул хурдан (2-5 секунд орчим), 6MB хүртэлх
// payload зөвшөөрдөг. Зорилго нь: client-с ирсэн base64 зургуудыг (бүтээгдэхүүн +
// reference-үүд) шууд GitHub-д commit хийж, тэдгээрийн raw URL-г буцаах.
//
// Яагаад ийм зуучлагч алхам хэрэгтэй вэ:
// generate-background.js бол Netlify BACKGROUND FUNCTION бөгөөд ердөө ~256KB
// хүртэлх payload л зөвшөөрдөг (synchronous function-ий 6MB-тай харьцуулбал маш
// бага). Иймд base64 зургуудыг шууд background function руу дамжуулж болохгүй —
// эхлээд энд GitHub-д хадгалаад, дараа нь зөвхөн URL (жижиг текст) дамжуулна.

async function commitToGithub({ base64Data, path }) {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const branch = process.env.GITHUB_BRANCH || 'main';

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
        message: `upload input: ${path}`,
        content: base64Data,
        branch
      })
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub upload амжилтгүй (${path}): ${errText}`);
  }

  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { requestId, image, mimeType, references } = JSON.parse(event.body);

    if (!requestId || !image) {
      return { statusCode: 400, body: 'requestId, image шаардлагатай' };
    }

    const productExt = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
    const productUrl = await commitToGithub({
      base64Data: image,
      path: `uploads/${requestId}/product.${productExt}`
    });

    const referenceUrls = [];
    for (let i = 0; i < (references || []).length; i++) {
      const ref = references[i];
      const ext = (ref.mimeType || 'image/jpeg').split('/')[1] || 'jpg';
      const url = await commitToGithub({
        base64Data: ref.base64,
        path: `uploads/${requestId}/ref-${i}.${ext}`
      });
      referenceUrls.push(url);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ productUrl, referenceUrls })
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: err.message || 'Тодорхойгүй алдаа' };
  }
};
