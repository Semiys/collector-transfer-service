const CBR_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
let cachedRate;

function xmlValue(xml, tag) {
  return xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1]?.trim();
}

export function parseEurRate(xml) {
  const date = xml.match(/<ValCurs\b[^>]*\bDate="(\d{2}\.\d{2}\.\d{4})"/i)?.[1];
  const currency = [...xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/gi)]
    .map((match) => match[1])
    .find((block) => xmlValue(block, 'CharCode') === 'EUR');
  const nominal = Number(xmlValue(currency ?? '', 'Nominal'));
  const value = Number(xmlValue(currency ?? '', 'Value')?.replace(',', '.'));
  if (!date || !currency || !Number.isFinite(nominal) || nominal <= 0 ||
      !Number.isFinite(value) || value <= 0) {
    throw new Error('В ответе ЦБ нет корректного курса EUR');
  }
  return { currency: 'EUR', rubPerEuro: value / nominal, date, source: CBR_URL };
}

export async function getEurRate(fetchImpl = fetch) {
  if (fetchImpl === fetch && cachedRate && cachedRate.expiresAt > Date.now()) return cachedRate.rate;
  const response = await fetchImpl(CBR_URL, {
    signal: AbortSignal.timeout(8_000),
    headers: { Accept: 'application/xml' },
  });
  if (!response.ok) throw new Error('ЦБ временно не отвечает. Попробуйте позже');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 100_000) throw new Error('Ответ ЦБ слишком большой');
  const xml = new TextDecoder('windows-1251').decode(bytes);
  const rate = parseEurRate(xml);
  if (fetchImpl === fetch) cachedRate = { rate, expiresAt: Date.now() + 60 * 60 * 1000 };
  return rate;
}
