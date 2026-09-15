import fs from 'fs';
import path from 'path';

/**
 * Безопасная атомарная запись JSON-файла.
 * Записывает данные во временный файл .tmp, затем выполняет атомарный переименовывание fs.renameSync.
 * Это предотвращает повреждение базы данных при внезапной перезагрузке контейнера или сбое процесса.
 */
export function atomicWriteJson(filePath: string, data: any, indent: number = 2): boolean {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const jsonStr = JSON.stringify(data, null, indent);
    
    fs.writeFileSync(tempPath, jsonStr, 'utf8');
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (err) {
    console.error(`[ATOMIC DB SAVER] Error writing atomic JSON to ${filePath}:`, err);
    // Фолбэк на стандартную запись, если atomic rename не удался
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, indent), 'utf8');
      return true;
    } catch (fallbackErr) {
      console.error(`[ATOMIC DB SAVER] Critical fallback write error for ${filePath}:`, fallbackErr);
      return false;
    }
  }
}

/**
 * Валидация структуры DB перед сохранением
 */
export function validateDbIntegrity(dbData: any): boolean {
  if (!dbData || typeof dbData !== 'object') return false;
  if (!Array.isArray(dbData.trades)) return false;
  if (!Array.isArray(dbData.knowledge)) return false;
  return true;
}
