import crypto from 'node:crypto';

/** Criptografia das cópias enviadas para fora (AES-256-GCM com senha). Sem dependência do banco: o restaurador usa. */

const MAGIC = Buffer.from('BBK1');

export function encrypt(data: Buffer, password: string): Buffer {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decrypt(data: Buffer, password: string): Buffer {
  if (!data.subarray(0, 4).equals(MAGIC)) throw new Error('Arquivo não é uma cópia criptografada do sistema.');
  const salt = data.subarray(4, 20);
  const iv = data.subarray(20, 32);
  const tag = data.subarray(32, 48);
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(password, salt, 32), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data.subarray(48)), decipher.final()]);
  } catch {
    throw new Error('Senha da cópia incorreta (ou arquivo corrompido).');
  }
}
