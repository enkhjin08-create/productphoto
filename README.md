# Product Photoshoot Generator (prototype)

Хувийн бизнес хэрэглээнд зориулсан — ZuvkhunTuund / Meowie / CuteCups брэндүүдийн бүтээгдэхүүний зургийг Gemini-ээр шинэ photoshoot scene рүү оруулах tool.

## ⚠️ Netlify төлбөрийн багц — заавал уншина уу

Энэ prototype **Netlify Background Functions** ашигладаг (`generate-background.js`). Энэ нь Gemini + GitHub + Firestore-ийн нийт хугацаа synchronous function-ий 10-26 секундын хязгаараас хэтэрдэг тул зайлшгүй хэрэгтэй болсон.

**Background Functions зөвхөн Netlify-ийн Pro болон түүнээс дээш багцад ажилладаг** (Free/Starter багц дээр ажиллахгүй). Хэрэв одоо Free багц дээр байгаа бол Site configuration → Billing хэсгээс шалгаж, эсвэл упгрейд хийх шаардлагатай.

## Урсгал

```
1. Frontend: requestId үүсгээд generate-background.js рүү явуулж, ХАРИУ ХҮЛЭЭХГҮЙ
2. Netlify: client рүү шууд 202 буцаагаад, background-д ажлаа үргэлжлүүлнэ
3. generate-background.js:
   a. Firestore дээр requestId-аар "pending" бичлэг үүсгэнэ
   b. Gemini image API дуудна (503 гарвал 2 удаа хүртэл дахин оролдоно)
   c. Үр дүнг GitHub repo руу commit хийнэ
   d. Firestore бичлэгийг "done" (imageUrl-той) эсвэл "error" болгож шинэчилнэ
4. Frontend: status.js-г 2 секунд тутам polling хийж, "done"/"error" болтол хүлээнэ
5. "done" болмогц зургийг stage дээр харуулна
```

Энэ бүтцээр **client тал хэзээ ч timeout авахгүй** — учир нь эхний дуудалт шууд буцдаг, харин бодит ажил арын талд, хугацааны дарамтгүйгээр (15 минут хүртэл) явагдана.

Бүтээгдэхүүний зураг **өөрчлөгдөхгүй** байхаар prompt-д тодорхой заасан байгаа; reference зургууд зөвхөн орчин/гэрэл/mood-ийн жишээ болгож ашиглагдана, тэднээс бүтээгдэхүүн авахгүй.

## Файлын бүтэц

```
public/index.html                          ← Frontend (PIN gate + upload + reference зураг + тайлбар + polling)
netlify/functions/generate-background.js   ← Background function: Gemini + GitHub + Firestore
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

## Хэрэв Netlify Free/Starter багц дээр байгаа бол

Background Functions ажиллахгүй тул `generate-background.js` дуудахад алдаа өгнө (жишээ нь 404 эсвэл ердийн synchronous хэлбэрээр ажиллаад timeout хэвээр давтагдана). Энэ тохиолдолд сонголтууд:

1. **Netlify Pro багцад шилжих** — хамгийн энгийн шийдэл, background functions шууд ажиллана
2. **Өөр platform ашиглах** — жишээ нь Google Cloud Functions/Cloud Run (60 мин хүртэл timeout зөвшөөрдөг), эсвэл Vercel-ийн Pro/Enterprise багц дээрх Edge/Background functions
3. **Gemini дуудалтыг өөрөө хурдасгах** — зурган хэмжээг бага болгох (аль хэдийн хийсэн, 1400px), reference зургийн тоог 1-ээр хязгаарлах, generation config-д `"candidateCount": 1` шиг зүйл нэмэх зэргээр нийт хугацааг synchronous хязгаар (10-26с)-т багтаах — гэхдээ найдвартай байдал багатай

## Дараагийн сайжруулалт боломжтой зүйлс

- Тайлбарын түүхийг Firestore дээр хадгалж, өмнө бичсэн тайлбаруудаа дахин ашиглах (autocomplete/quick-pick)
- Generate хийсэн зургаа шууд GitHub дээрх бүтээгдэхүүний үндсэн галерейд оруулах товч нэмэх
- Batch горим — нэг дор олон бүтээгдэхүүний зураг upload хийж дараалан generate хийх
- Firebase Auth ашиглаж PIN-ээс илүү найдвартай нэвтрэлт хийх
