// Чтение .env (без зависимостей). Понимает BOM от Блокнота, CRLF, пробелы, кавычки.
const fs = require('fs'), path = require('path');
module.exports = function loadEnv(dir) {
  const f = path.join(dir, '.env');
  if (!fs.existsSync(f)) {
    const alt = ['.env.txt', '.env.example', 'env', 'env.txt', '.env.example.txt'].find(n => fs.existsSync(path.join(dir, n)));
    console.warn('⚠ Файл .env не найден в ' + dir + (alt ? '\n  Найден «' + alt + '» — переименуйте его в «.env» командой:\n  Rename-Item "' + alt + '" .env' : ''));
    return false;
  }
  const text = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1].toUpperCase()] === undefined) process.env[m[1].toUpperCase()] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return true;
};
