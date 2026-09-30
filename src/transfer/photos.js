import sharp from 'sharp';

const HUNT64_PHOTO_HOST = 'juegmurcnhnfnvsqsqxn.supabase.co';
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
let placeholderPromise;

export function validateHunt64PhotoUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Некорректная ссылка на фото'); }
  if (url.protocol !== 'https:' || url.hostname !== HUNT64_PHOTO_HOST ||
      url.port || url.username || url.password ||
      !url.pathname.startsWith('/storage/v1/object/public/collection-photos/')) {
    throw new Error('Пока поддерживаются только ссылки на личные фото Hunt64');
  }
  return url;
}

export async function placeholderPhoto() {
  placeholderPromise ??= sharp(Buffer.from(`<svg width="480" height="360" xmlns="http://www.w3.org/2000/svg">
    <rect width="480" height="360" fill="#edf0f4"/>
    <rect x="138" y="125" width="204" height="135" rx="18" fill="none" stroke="#8895a7" stroke-width="12"/>
    <path d="M185 125l17-25h76l17 25" fill="none" stroke="#8895a7" stroke-width="12" stroke-linejoin="round"/>
    <circle cx="240" cy="192" r="37" fill="none" stroke="#8895a7" stroke-width="12"/>
  </svg>`)).jpeg({ quality: 80 }).toBuffer();
  return placeholderPromise;
}

export async function downloadHunt64Photo(value, fetchImpl = fetch) {
  const url = validateHunt64PhotoUrl(value);
  const response = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'image/jpeg,image/png,image/webp' },
  });
  if (!response.ok) throw new Error(`Фото недоступно: HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > MAX_DOWNLOAD_BYTES) throw new Error('Фото больше 8 МБ');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_DOWNLOAD_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new Error('Фото больше 8 МБ');
    }
    chunks.push(Buffer.from(chunk));
  }
  const source = Buffer.concat(chunks);
  const image = sharp(source, { limitInputPixels: 40_000_000, failOn: 'error' });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
    throw new Error('Формат фото должен быть JPG, PNG или WebP');
  }
  const result = await image.rotate().resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).jpeg({ quality: 78 }).toBuffer();
  if (result.length > 12 * 1024 * 1024) throw new Error('Обработанное фото слишком большое');
  return result;
}
