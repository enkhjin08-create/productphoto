# Product Photoshoot Generator (prototype)

Хувийн бизнес хэрэглээнд зориулсан — ZuvkhunTuund / Meowie / CuteCups брэндүүдийн бүтээгдэхүүний зургийг Gemini-ээр шинэ photoshoot scene рүү оруулах tool.

## Урсгал

```
Upload бүтээгдэхүүний зураг + reference зургууд (олноор) + тайлбар бичих
  → Netlify Function (netlify/functions/generate.js)
  → Gemini 2.5 Flash Image API руу бүтээгдэхүүний зураг + reference зургууд + тайлбарыг хамт дамжуулна
  → Үр дүнгийн зургийг GitHub repo руу commit хийнэ
  → Firestore-д metadata (brand, description, github url) хадгална
  → Frontend дээр GitHub raw URL-аар харуулна
```

Бүтээгдэхүүний зураг **өөрчлөгдөхгүй** байхаар prompt-д тодорхой заасан байгаа; reference зургууд зөвхөн орчин/гэрэл/mood-ийн жишээ болгож ашиглагдана, тэднээс бүтээгдэхүүн авахгүй.

## Файлын бүтэц

```
public/index.html              ← Frontend (PIN gate + upload + reference зураг + тайлбар + stage)
netlify/functions/generate.js  ← Gemini дуудаж, GitHub-д commit хийж, Firestore-д лог хийнэ
netlify/functions/history.js   ← Firestore-с сүүлийн зургуудыг brand-аар шүүж авчирна
netlify.toml                   ← Netlify тохиргоо
package.json                   ← firebase-admin dependency
```

## Тохируулах алхмууд

### 1. Environment variables (Netlify dashboard → Site settings → Environment variables)

| Variable | Тайлбар |
|---|---|
| `GEMINI_API_KEY` | Таны Gemini Developer API key |
| `GITHUB_TOKEN` | Зураг commit хийх Personal Access Token (`repo` эрхтэй) |
| `GITHUB_OWNER` | GitHub username |
| `GITHUB_REPO` | Зураг хадгалах repo-ийн нэр (жишээ: `zt-photoshoot-assets`) |
| `GITHUB_BRANCH` | Заавал биш, default `main` |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Console → Project settings → Service accounts → Generate new private key. Татаж авсан JSON-г **бүхэлд нь нэг мөр string** болгож энд тавина |

> ⚠️ GitHub token-ы хугацаа дуусах өдөр (8-р сарын 7) ойрхон байгаа тул энэ project-д шинэ эсвэл сунгасан token ашиглана уу.

### 2. Firestore тохиргоо

Firebase Console дээр Firestore Database үүсгээд `photoshoots` нэртэй collection автоматаар эхний бичилтээр үүснэ (нэмж юу ч хийх шаардлагагүй). Хэрэв `history.js` доторх `.where().orderBy()` query ажиллахгүй бол Firestore танд composite index үүсгэх линк өгнө — түүн дээр дарж зөвшөөрөхөд л хангалттай.

### 3. Frontend PIN солих

`public/index.html` файл доторх:
```js
const APP_PIN = "0000";
```
энийг өөрийн PIN-ээр солино.

### 4. Локал тест (Netlify CLI)

```bash
npm install
npm install -g netlify-cli
netlify dev
```

### 5. Deploy

```bash
netlify deploy --prod
```

эсвэл GitHub repo-г Netlify дээр холбоод автомат deploy тохируулж болно.

## Дараагийн сайжруулалт боломжтой зүйлс

- Тайлбарын түүхийг Firestore дээр хадгалж, өмнө бичсэн тайлбаруудаа дахин ашиглах (autocomplete/quick-pick)
- Generate хийсэн зургаа шууд GitHub дээрх бүтээгдэхүүний үндсэн галерейд оруулах товч нэмэх
- Batch горим — нэг дор олон бүтээгдэхүүний зураг upload хийж дараалан generate хийх
- Firebase Auth ашиглаж PIN-ээс илүү найдвартай нэвтрэлт хийх
