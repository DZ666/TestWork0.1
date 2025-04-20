import fs from 'fs'
import path from 'path'
import os from 'os'
import { promisify } from 'util'

// Имя проекта из package.json
let projectName = 'app'
try {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'))
  projectName = packageJson.name || 'app'
} catch (e) {
  console.error('Не удалось прочитать package.json')
}

// Создаем директорию для логов
const LOG_DIR = path.join(os.homedir(), `${projectName}.logs`)
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

// Текущая дата для имени файла
const now = new Date()
const dateStr = now.toISOString().split('T')[0] // YYYY-MM-DD
const timeStr = now.toISOString().split('T')[1].split('.')[0].replace(/:/g, '-') // HH-MM-SS

// Пути к файлам логов
const LOG_FILE_PATH = path.join(LOG_DIR, `logs-${dateStr}-${timeStr}.log`)
const LOGS_FILE_PATH = path.join(process.cwd(), 'info.log')

// Инициализация файла
fs.writeFileSync(LOG_FILE_PATH, `[${new Date().toISOString()}] [INIT] Запуск приложения\n`)
fs.writeFileSync(LOGS_FILE_PATH, `[${new Date().toISOString()}] [INIT] Запуск приложения\n`)

// Внутренняя функция для получения информации о вызывающем файле и строке
function getCallerInfo() {
  const err = new Error()
  const stack = err.stack || ''
  const stackLines = stack.split('\n')
  
  // Получаем третью строку стека (первая - Error, вторая - getCallerInfo, третья - logToFile, четвертая - вызывающий код)
  const callerLine = stackLines[3] || ''
  
  // Извлекаем имя файла и номер строки
  const match = callerLine.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/)
  if (match) {
    const [, fnName, filePath, line, column] = match
    const fileName = path.basename(filePath)
    return { fileName, line, fnName }
  }
  
  // Если не удалось извлечь информацию, возвращаем "server"
  return { fileName: 'server', line: '?', fnName: 'server' }
}

const writeFileAsync = promisify(fs.writeFile)
const appendFileAsync = promisify(fs.appendFile)

/**
 * Записывает сообщение в лог с дополнительной информацией
 * @param message Сообщение для логирования
 * @param level Уровень логирования (INFO, WARN, ERROR)
 */
export function logToFile(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO'): void {
  const timestamp = new Date().toISOString()
  const { fileName, line, fnName } = getCallerInfo()
  const formattedMessage = `[${timestamp}] [${level}] [${fileName}:${line}] [${fnName}] ${message}\n`
  
  // Запись в файл logs.log синхронно (для немедленного отображения)
  fs.appendFileSync(LOGS_FILE_PATH, formattedMessage)
  
  // Запись в файл логов асинхронно
  appendFileAsync(LOG_FILE_PATH, formattedMessage).catch(err => {
    console.error(`Ошибка при записи лога: ${err.message}`)
  })
  
  // Также вывод в консоль
  console.log(`[${level}] [${fileName}:${line}] [${fnName}] ${message}`)
}

/**
 * Запись лога уровня WARN
 */
export function logWarning(message: string): void {
  logToFile(message, 'WARN')
}

/**
 * Запись лога уровня ERROR
 */
export function logError(message: string): void {
  logToFile(message, 'ERROR')
}

/**
 * Читает содержимое файла logs.log
 */
export function readLogFile(): string {
  if (fs.existsSync(LOGS_FILE_PATH)) {
    return fs.readFileSync(LOGS_FILE_PATH, 'utf-8')
  }
  return ''
}

/**
 * Возвращает путь к директории логов
 */
export function getLogDirectory(): string {
  return LOG_DIR
}

/**
 * Возвращает список файлов логов
 */
export function getLogFiles(): string[] {
  if (fs.existsSync(LOG_DIR)) {
    return fs.readdirSync(LOG_DIR)
      .filter(file => file.startsWith('logs-') && file.endsWith('.log'))
      .sort()
      .reverse() // Новые файлы сверху
  }
  return []
}
