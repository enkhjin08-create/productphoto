# Product Photoshoot Generator (prototype)

Хувийн бизнес хэрэглээнд зориулсан — ZuvkhunTuund / Meowie / CuteCups брэндүүдийн бүтээгдэхүүний зургийг Gemini-ээр шинэ photoshoot scene рүү оруулах tool.

## ⚠️ Netlify төлбөрийн багц — заавал уншина уу

Энэ prototype **Netlify Background Functions** ашигладаг (`generate-background.js`). Background Functions одоо (2026 оноос) **Free/Personal/Pro бүх credit-based багцад ажилладаг** (өмнө нь зөвхөн Pro шаарддаг байсан).

**Чухал хязгаарлалт:** Background Functions ердөө **~256KB** хүртэлх payload л зөвшөөрдөг (synchronous function-ий 6MB-тай харьцуулбал маш бага, учир нь AWS Lambda-ийн async invoke API-ийн хязгаар). Тиймээс base64 зургийг шууд background function руу дамжуулж болохгүй — доорх 2 үе шаттай архитектур яг үүнийг шийддэг.

## Урсгал (2 үе шаттай)

```
1. Frontend: зургуудыг upload-input.js руу явуулж ХАРИУ ХҮЛЭЭНЭ
   (энэ synchronous function, Gemini орохгүй тул хурдан, 6MB хүртэл payload зөвшөөрдөг)
   → upload-input.js зургуудыг GitHub-д commit хийгээд, тэдгээрийн raw URL-г буцаана

2. Frontend: requestId + GitHub URL-ууд (жижиг payload) -ыг generate-background.js руу
   явуулж, ХАРИУ ХҮЛЭЭХГҮЙ (background function, ~256KB payload хязгаарт багтана)
   → Netlify client рүү шууд 202 буцаагаад, background-д ажлаа үргэлжлүүлнэ

3. generate-background.js:
   a. Firestore дээр requestId-аар "pending" бичлэг үүсгэнэ
   b. GitHub URL-уудаас зургуудыг татаж base64 болгоно
   c. Gemini image API дуудна (503 гарвал 2 удаа хүртэл дахин оролдоно)
   d. Үр дүнг GitHub repo руу commit хийнэ
   e. Firestore бичлэгийг "done" (imageUrl-той) эсвэл "error" болгож шинэчилнэ

4. Frontend: status.js-г 2 секунд тутам polling хийж, "done"/"error" болтол хүлээнэ
5. "done" болмогц зургийг stage дээр харуулна
```

Энэ бүтцээр **client тал хэзээ ч timeout авахгүй**, мөн background function-ий payload хязгаарт ч мөргөлдөхгүй.

Бүтээгдэхүүний зураг **өөрчлөгдөхгүй** байхаар prompt-д тодорхой заасан байгаа; reference зургууд зөвхөн орчин/гэрэл/mood-ийн жишээ болгож ашиглагдана, тэднээс бүтээгдэхүүн авахгүй. Тайлбар (`description`) сонголтоор — хоосон орхивол ерөнхий (base) prompt дангаараа professional photoshoot зураг үүсгэнэ.

## Файлын бүтэц

```
public/index.html                          ← Frontend (PIN gate + upload + reference зураг + тайлбар + polling)
netlify/functions/upload-input.js          ← Synchronous: оролтын зургуудыг GitHub-д commit хийж URL буцаана
netlify/functions/generate-background.js   ← Background: GitHub-с зураг татаж, Gemini + GitHub commit + Firestore
netlify/functions/status.js                ← requestId-аар pending/done/error статус шалгах (frontend polling-д)
netlify/functions/history.js               ← Firestore-с "done" статустай сүүлийн зургуудыг brand-аар шүүж авчирна
netlify.toml                                ← Netlify тохиргоо
package.json                                ← firebase-admin dependency
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

## Background function payload хязгаарын тухай (шийдэгдсэн)

Анх бид зургуудыг шууд `generate-background.js`-д base64 хэлбэрээр дамжуулж байсан ч энэ нь **413 Content Too Large** алдаа өгдөг байсан — учир нь Background Functions ердөө ~256KB хүртэлх payload л зөвшөөрдөг. Одоо энэ асуудлыг `upload-input.js` (synchronous, 6MB хүртэл payload зөвшөөрдөг) нэмж, зургуудыг эхлээд GitHub-д commit хийгээд, дараа нь зөвхөн URL-ыг background function руу дамжуулах байдлаар шийдсэн.

## Дараагийн сайжруулалт боломжтой зүйлс

- Оролтын зургуудыг (`uploads/<requestId>/`) generate дуусангуут GitHub-с автоматаар устгах (одоогоор repo дотор хуримтлагдана)
- Тайлбарын түүхийг Firestore дээр хадгалж, өмнө бичсэн тайлбаруудаа дахин ашиглах (autocomplete/quick-pick)
- Generate хийсэн зургаа шууд GitHub дээрх бүтээгдэхүүний үндсэн галерейд оруулах товч нэмэх
- Batch горим — нэг дор олон бүтээгдэхүүний зураг upload хийж дараалан generate хийх
- Firebase Auth ашиглаж PIN-ээс илүү найдвартай нэвтрэлт хийх
