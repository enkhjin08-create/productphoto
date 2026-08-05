# Product Photoshoot Generator (prototype)

Хувийн бизнес хэрэглээнд зориулсан — ZuvkhunTuund / Meowie / CuteCups брэндүүдийн бүтээгдэхүүний зургийг Gemini-ээр шинэ photoshoot scene рүү оруулах tool.

## ⚠️ Netlify төлбөрийн багц — заавал уншина уу

Энэ prototype **Netlify Background Functions** ашигладаг (`generate-background.js`). Background Functions одоо (2026 оноос) **Free/Personal/Pro бүх credit-based багцад ажилладаг** (өмнө нь зөвхөн Pro шаарддаг байсан).

**Чухал хязгаарлалт:** Background Functions ердөө **~256KB** хүртэлх payload л зөвшөөрдөг (synchronous function-ий 6MB-тай харьцуулбал маш бага, учир нь AWS Lambda-ийн async invoke API-ийн хязгаар). Тиймээс base64 зургийг шууд background function руу дамжуулж болохгүй — доорх 2 үе шаттай архитектур яг үүнийг шийддэг.

## Урсгал (2 үе шаттай, 2 GENERATE горимтой)

```
1. Frontend: зургуудыг upload-input.js руу явуулж ХАРИУ ХҮЛЭЭНЭ
   (энэ synchronous function, Gemini орохгүй тул хурдан, 6MB хүртэл payload зөвшөөрдөг)
   → upload-input.js зургуудыг GitHub-д commit хийгээд, тэдгээрийн raw URL-г буцаана

2. Frontend: requestId + GitHub URL-ууд (жижиг payload) + mode-ыг generate-background.js
   руу явуулж, ХАРИУ ХҮЛЭЭХГҮЙ (background function, ~256KB payload хязгаарт багтана)
   → Netlify client рүү шууд 202 буцаагаад, background-д ажлаа үргэлжлүүлнэ

3. generate-background.js — mode='compose' (АНХНЫ generate, default):
   a. Firestore дээр requestId-аар "pending" бичлэг үүсгэнэ
   b. Бүтээгдэхүүнийг remove.bg-ээр дэвсгэрээс нь ЦЭВЭРХЭН ТАЙРЧ авна (pixel 100% хадгална)
   c. Reference зургууд байвал, тэдгээрийг Gemini-ээр ЗӨВХӨН текст тайлбар болгоно
   d. Gemini-ээр ЗӨВХӨН дэвсгэр (бүтээгдэхүүнгүй) зураг үүсгэнэ
   e. sharp ашиглан cutout-ийг дэвсгэр дээр байрлуулж, зөөлөн сүүдэртэй нэгтгэнэ (composite)
   f. Үр дүнг GitHub repo руу commit хийнэ
   g. Firestore бичлэгийг "done" (imageUrl-той) эсвэл "error" болгож шинэчилнэ

   mode='edit' (Дахин үүсгэх/засварлах товч):
   a-c. адилхан
   d. Өмнөх БҮТЭН зургийг Gemini-ээр шууд edit хийнэ (сегментаци ашиглахгүй,
      учир нь энд аль хэдийн нэгтгэсэн бүтэн зураг дээр жижиг өөрчлөлт хийх зорилготой)
   e-f. адилхан

4. Frontend: status.js-г 2 секунд тутам polling хийж, "done"/"error" болтол хүлээнэ
5. "done" болмогц зургийг stage дээр харуулна
```

Энэ бүтцээр **client тал хэзээ ч timeout авахгүй**, background function-ий payload хязгаарт ч мөргөлдөхгүй, мөн **бүтээгдэхүүний pixel яг эх хэвээрээ хадгалагдана** (Photoroom зэрэг мэргэжлийн tool-уудын ашигладаг segmentation+composite зарчим) — учир нь `compose` горимд Gemini бүтээгдэхүүнийг хэзээ ч дахин зурдаггүй, зөвхөн дэвсгэрийг л зурдаг.

Reference зургууд зөвхөн текст тайлбар (mood, өнгө, гэрэлтүүлэг) болгож ашиглагдана — тэдний pixel Gemini рүү хэзээ ч дамждаггүй тул шууд хуулбарлагдах эрсдэлгүй. Тайлбар (`description`) сонголтоор — хоосон орхивол ерөнхий (base) prompt дангаараа premium chанартай photoshoot зураг үүсгэнэ.

## Файлын бүтэц

```
public/index.html                          ← Frontend (PIN gate + upload + reference зураг + тайлбар + polling + засварлах)
netlify/functions/upload-input.js          ← Synchronous: оролтын зургуудыг GitHub-д commit хийж URL буцаана
netlify/functions/generate-background.js   ← Background: remove.bg segmentation + Gemini дэвсгэр + sharp composite + GitHub + Firestore
netlify/functions/status.js                ← requestId-аар pending/done/error статус шалгах (frontend polling-д)
netlify/functions/history.js               ← Firestore-с "done" статустай сүүлийн зургуудыг brand-аар шүүж авчирна
netlify.toml                                ← Netlify тохиргоо (sharp-ыг external_node_modules болгосон)
package.json                                ← firebase-admin, sharp dependencies
```

## Тохируулах алхмууд

### 1. Environment variables (Netlify dashboard → Site settings → Environment variables)

| Variable | Тайлбар |
|---|---|
| `GEMINI_API_KEY` | Таны Gemini Developer API key |
| `REMOVEBG_API_KEY` | **Шинэ!** remove.bg дээрээс авах API key (https://www.remove.bg/api → sign up → API key). Free tier-т сарын хязгаарлагдмал тооны дуудалт багтдаг, дараа нь төлбөртэй |
| `GITHUB_TOKEN` | Зураг commit хийх Personal Access Token (`repo` эрхтэй) |
| `GITHUB_OWNER` | GitHub username |
| `GITHUB_REPO` | Зураг хадгалах repo-ийн нэр (жишээ: `zt-photoshoot-assets`) |
| `GITHUB_BRANCH` | Заавал биш, default `main` |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Console → Project settings → Service accounts → Generate new private key. Татаж авсан JSON-г **бүхэлд нь нэг мөр string** болгож энд тавина |

> ⚠️ GitHub token-ы хугацаа дуусах өдөр (8-р сарын 7) ойрхон байгаа тул энэ project-д шинэ эсвэл сунгасан token ашиглана уу.
> ⚠️ **REMOVEBG_API_KEY заавал тохируулаагүй бол `compose` горим (анхны generate) алдаа өгнө** — эхлээд remove.bg дээр бүртгүүлж key аваарай.

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

## Background function payload хязгаарын тухай (шийдэгдсэн)

Анх бид зургуудыг шууд `generate-background.js`-д base64 хэлбэрээр дамжуулж байсан ч энэ нь **413 Content Too Large** алдаа өгдөг байсан — учир нь Background Functions ердөө ~256KB хүртэлх payload л зөвшөөрдөг. Одоо энэ асуудлыг `upload-input.js` (synchronous, 6MB хүртэл payload зөвшөөрдөг) нэмж, зургуудыг эхлээд GitHub-д commit хийгээд, дараа нь зөвхөн URL-ыг background function руу дамжуулах байдлаар шийдсэн.

## Дараагийн сайжруулалт боломжтой зүйлс

- Одоогоор бүтээгдэхүүний cutout-ийг канвасын **төв доод хэсэгт, 55% өргөнөөр** тогтмол байрлуулдаг (heuristic). Илүү нарийвчлалтай байрлал/хэмжээ хүсвэл Gemini-ээс "энэ дэвсгэрт бүтээгдэхүүнийг хаана, ямар хэмжээгээр байрлуулах вэ" гэсэн bounding box санал авч динамик болгож болно
- Оролтын зургуудыг (`uploads/<requestId>/`) generate дуусангуут GitHub-с автоматаар устгах (одоогоор repo дотор хуримтлагдана)
- Тайлбарын түүхийг Firestore дээр хадгалж, өмнө бичсэн тайлбаруудаа дахин ашиглах (autocomplete/quick-pick)
- Generate хийсэн зургаа шууд GitHub дээрх бүтээгдэхүүний үндсэн галерейд оруулах товч нэмэх
- Batch горим — нэг дор олон бүтээгдэхүүний зураг upload хийж дараалан generate хийх
- Firebase Auth ашиглаж PIN-ээс илүү найдвартай нэвтрэлт хийх
- remove.bg-ийн оронд өөр segmentation service (жишээ нь Photoroom-ийн API өөрийг нь) туршиж чанарыг харьцуулах
