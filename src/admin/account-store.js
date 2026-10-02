import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILE_NAME = 'openrouter-accounts.enc.json';
const AAD = Buffer.from('collector-transfer-service:openrouter-accounts:v1');

// Preserve the existing encrypted volume, but never send legacy provider keys to Groq.
function compatible(account) {
  return account.provider === 'groq' && /^gsk_[A-Za-z0-9_-]{16,508}$/.test(account.apiKey ?? '');
}

function requireGroq(account) {
  if (!compatible(account)) throw new Error('Этот ключ относится к старому провайдеру. Добавьте новый API-ключ Groq.');
}

function publicAccount(account) {
  const { apiKey, ...rest } = account;
  return { ...rest, provider: account.provider ?? 'openrouter', compatible: compatible(account),
    enabled: account.enabled && compatible(account), keyPreview: `••••${apiKey.slice(-4)}` };
}

export function createAccountStore({ dataDir, encryptionKey }) {
  if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey ?? '')) {
    throw new Error('AI_KEY_ENC_KEY должен содержать 64 шестнадцатеричных символа');
  }
  const key = Buffer.from(encryptionKey, 'hex');
  const filePath = path.join(dataDir, FILE_NAME);
  let queue = Promise.resolve();

  async function readAccounts() {
    let encrypted;
    try { encrypted = JSON.parse(await readFile(filePath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error('Не удалось прочитать зашифрованный список ключей');
    }
    if (encrypted.version !== 1) throw new Error('Неизвестная версия хранилища ключей');
    try {
      const iv = Buffer.from(encrypted.iv, 'base64');
      const tag = Buffer.from(encrypted.tag, 'base64');
      const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid envelope');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const accounts = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
      if (!Array.isArray(accounts)) throw new Error('invalid accounts');
      return accounts;
    } catch {
      throw new Error('Список ключей повреждён или изменён ключ шифрования');
    }
  }

  async function writeAccounts(accounts) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(accounts), 'utf8'), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, envelope, { mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  function mutate(operation) {
    const result = queue.then(async () => {
      const accounts = await readAccounts();
      const value = operation(accounts);
      await writeAccounts(accounts);
      return value;
    });
    queue = result.catch(() => {});
    return result;
  }

  return {
    async list() {
      await queue;
      return (await readAccounts()).map(publicAccount);
    },
    async getKey(id) {
      await queue;
      const account = (await readAccounts()).find((item) => item.id === id);
      if (!account) throw new Error('Ключ не найден');
      requireGroq(account);
      return account.apiKey;
    },
    async getEnabledKey(id) {
      await queue;
      const account = (await readAccounts()).find((item) => item.id === id);
      if (!account) throw new Error('Ключ не найден');
      requireGroq(account);
      if (!account.enabled) throw new Error('Выбранный ключ выключен');
      return account.apiKey;
    },
    async getEnabledAccounts(primaryId) {
      await queue;
      const accounts = await readAccounts();
      const primary = accounts.find((item) => item.id === primaryId);
      if (!primary) throw new Error('Ключ не найден');
      requireGroq(primary);
      if (!primary.enabled) throw new Error('Выбранный ключ выключен');
      const owners = new Set([primary.owner.trim().toLocaleLowerCase('ru')]);
      const fallback = accounts.filter((item) => {
        if (!item.enabled || !compatible(item) || item.id === primaryId) return false;
        const owner = item.owner.trim().toLocaleLowerCase('ru');
        if (owners.has(owner)) return false;
        owners.add(owner);
        return true;
      });
      return [primary, ...fallback];
    },
    add({ owner, label, apiKey, consent }) {
      const normalizedOwner = String(owner ?? '').trim();
      const normalizedLabel = String(label ?? '').trim();
      const normalizedKey = String(apiKey ?? '').trim();
      if (!consent) throw new Error('Подтвердите согласие владельца API-ключа');
      if (!normalizedOwner || normalizedOwner.length > 80 || !normalizedLabel || normalizedLabel.length > 80) {
        throw new Error('Укажите владельца и название ключа (до 80 символов)');
      }
      if (!/^gsk_[A-Za-z0-9_-]{16,508}$/.test(normalizedKey)) {
        throw new Error('Введите корректный API-ключ Groq');
      }
      return mutate((accounts) => {
        if (accounts.length >= 30) throw new Error('В панели можно хранить не более 30 ключей');
        if (accounts.some((item) => item.apiKey === normalizedKey)) throw new Error('Этот API-ключ уже добавлен');
        const account = { id: randomUUID(), owner: normalizedOwner, label: normalizedLabel,
          apiKey: normalizedKey, provider: 'groq', enabled: true, createdAt: new Date().toISOString() };
        accounts.push(account);
        return publicAccount(account);
      });
    },
    setEnabled(id, enabled) {
      if (typeof enabled !== 'boolean') throw new Error('Укажите enabled: true или false');
      return mutate((accounts) => {
        const account = accounts.find((item) => item.id === id);
        if (!account) throw new Error('Ключ не найден');
        if (enabled) requireGroq(account);
        account.enabled = enabled;
        return publicAccount(account);
      });
    },
    remove(id) {
      return mutate((accounts) => {
        const index = accounts.findIndex((item) => item.id === id);
        if (index < 0) throw new Error('Ключ не найден');
        accounts.splice(index, 1);
        return { removed: true };
      });
    },
  };
}
