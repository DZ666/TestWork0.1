import { Message } from '@models/message'
import { messagesCollection } from './mongo'
import { logToFile, logError, logWarning } from '@utils/logger'
import fs from 'fs'
import path from 'path'
import { ObjectId } from 'mongodb'

// Константы
const BUFFER_FILE = path.join(__dirname, '../../messageBuffer.json')
const BATCH_SIZE = 10
const BATCH_INTERVAL = 1000 // 1 секунда
const MAX_RETRIES = 5
const RETRY_DELAY = 1000 // 1 секунда
const MAX_BUFFER_SIZE = 1000 // Максимальный размер буфера для предотвращения утечек памяти

// Буфер сообщений и состояние
let buffer: Message[] = []
let flushTimeout: NodeJS.Timeout | null = null
let isBufferLocked = false // Блокировка для предотвращения параллельной записи
let totalProcessedMessages = 0
let lastFlushTime = Date.now()

// Восстановление буфера из файла при старте
if (fs.existsSync(BUFFER_FILE)) {
  try {
    const data = fs.readFileSync(BUFFER_FILE, 'utf-8')
    const parsedData = JSON.parse(data)
    
    // Проверка на валидность данных
    if (Array.isArray(parsedData) && parsedData.every(isValidMessage)) {
      buffer = parsedData
      logToFile(`Буфер восстановлен из файла: ${buffer.length} сообщений`, 'INFO')
    } else {
      buffer = []
      logWarning(`Файл буфера содержит невалидные данные, создан пустой буфер`)
    }
  } catch (error) {
    buffer = []
    logError(`Ошибка при чтении буфера из файла: ${error instanceof Error ? error.message : String(error)}`)
  }
} else {
  logToFile('Файл буфера не найден, создан пустой буфер', 'INFO')
}

import { promisify } from 'util'

const writeFile = promisify(fs.writeFile)

/**
 * Проверяет, что объект является валидным сообщением
 */
function isValidMessage(obj: any): obj is Message {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.user === 'string' && 
    obj.user.trim() !== '' &&
    typeof obj.text === 'string' && 
    obj.text.trim() !== '' &&
    obj.createdAt && 
    (obj.createdAt instanceof Date || new Date(obj.createdAt).toString() !== 'Invalid Date')
  )
}

/**
 * Сохраняет буфер сообщений в файл
 */
async function saveBufferToFile() {
  try {
    await writeFile(BUFFER_FILE, JSON.stringify(buffer))
    logToFile(`Буфер сохранен в файл: ${buffer.length} сообщений`, 'INFO')
  } catch (error) {
    logError(`Ошибка при сохранении буфера в файл: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Очищает буфер сообщений
 * @param count Количество сообщений для удаления
 */
function clearBuffer(count: number) {
  buffer.splice(0, count)
  logToFile(`Удалено ${count} сообщений из буфера. Осталось: ${buffer.length}`, 'INFO')
}

/**
 * Обрабатывает и записывает в MongoDB сообщения из буфера
 */
async function flushBuffer() {
  if (buffer.length === 0) return
  if (isBufferLocked) {
    logToFile('Буфер уже обрабатывается, пропускаем запуск', 'INFO')
    return
  }
  
  isBufferLocked = true
  const toInsert = buffer.slice(0, BATCH_SIZE)
  const count = toInsert.length
  
  logToFile(`Попытка записи в MongoDB: ${count} сообщений`, 'INFO')
  
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      // Подготавливаем сообщения для вставки (преобразуем даты и т.д.)
      const preparedMessages = toInsert.map(msg => {
        // Убедимся, что createdAt - это объект Date
        if (!(msg.createdAt instanceof Date)) {
          msg.createdAt = new Date(msg.createdAt)
        }
        return msg
      })
      
      // Вставляем сообщения в MongoDB
      const result = await messagesCollection.insertMany(preparedMessages)
      
      if (result.insertedCount === count) {
        logToFile('Запись в MongoDB успешно завершена', 'INFO')
        clearBuffer(count)
        totalProcessedMessages += count
        lastFlushTime = Date.now()
        await saveBufferToFile()
        isBufferLocked = false
        return
      } else {
        logWarning(`Неполная вставка: вставлено ${result.insertedCount} из ${count} сообщений`)
        // Удаляем только успешно вставленные сообщения
        clearBuffer(result.insertedCount)
        // Прерываем retry-цикл и повторно запустим flush для оставшихся
        break
      }
    } catch (error) {
      logError(`Ошибка при записи в MongoDB (Попытка ${i + 1}/${MAX_RETRIES}): ${error instanceof Error ? error.message : String(error)}`)
      
      if (i < MAX_RETRIES - 1) {
        logToFile(`Ожидание перед повторной попыткой: ${RETRY_DELAY}ms`, 'INFO')
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY))
      } else {
        logError('Критическая ошибка: Не удалось записать сообщения в MongoDB после нескольких попыток')
      }
    }
  }
  
  // Если после всех попыток не удалось записать, сохраняем буфер
  await saveBufferToFile()
  isBufferLocked = false
  
  // Если остались сообщения в буфере, планируем следующую запись
  if (buffer.length > 0) {
    scheduleFlush()
  }
}

/**
 * Планирует запись сообщений из буфера через указанный интервал
 */
function scheduleFlush() {
  if (flushTimeout) return
  
  flushTimeout = setTimeout(async () => {
    logToFile('Запущена отложенная запись в MongoDB', 'INFO')
    await flushBuffer()
    flushTimeout = null
    
    // Если остались сообщения, планируем следующую запись
    if (buffer.length > 0) {
      scheduleFlush()
    }
  }, BATCH_INTERVAL)
}

/**
 * Проверяет и обрезает буфер, если он слишком большой
 * @returns true если буфер был обрезан
 */
function checkAndTrimBuffer(): boolean {
  if (buffer.length > MAX_BUFFER_SIZE) {
    const excess = buffer.length - MAX_BUFFER_SIZE
    buffer = buffer.slice(excess)
    logWarning(`Буфер превысил максимальный размер. Удалено ${excess} старых сообщений для предотвращения переполнения памяти`)
    return true
  }
  return false
}

/**
 * Добавляет сообщение в буфер и запускает запись в MongoDB, если буфер заполнен
 * @param msg Сообщение для добавления
 */
export async function addMessageToBuffer(msg: Omit<Message, '_id'>): Promise<void> {
  // Проверка валидности данных
  if (!isValidMessage(msg)) {
    logError(`Попытка добавить невалидное сообщение: ${JSON.stringify(msg)}`)
    throw new Error('Невалидные данные сообщения')
  }
  
  buffer.push(msg as Message)
  logToFile(`Новое сообщение добавлено в буфер от пользователя ${msg.user}`, 'INFO')
  
  // Проверка переполнения буфера
  checkAndTrimBuffer()
  
  // Сохраняем буфер после добавления сообщения
  await saveBufferToFile()
  
  if (buffer.length >= BATCH_SIZE) {
    logToFile(`Буфер заполнен (${buffer.length}/${BATCH_SIZE}), запускаем запись`, 'INFO')
    
    // Отменяем отложенную запись, если она планировалась
    if (flushTimeout) {
      clearTimeout(flushTimeout)
      flushTimeout = null
      logToFile('Отложенная запись отменена', 'INFO')
    }
    
    // Выполняем запись немедленно
    await flushBuffer()
  } else if (!flushTimeout) {
    // Если таймер еще не установлен, планируем запись
    scheduleFlush()
    logToFile('Запланирована отложенная запись буфера', 'INFO')
  }
}

/**
 * Получает все сообщения из MongoDB
 * @param limit Максимальное количество сообщений
 * @param skip Количество сообщений для пропуска
 */
export async function getAllMessages(limit = 100, skip = 0): Promise<Message[]> {
  logToFile(`Запрос сообщений из MongoDB (limit: ${limit}, skip: ${skip})`, 'INFO')
  
  try {
    const messages = (await messagesCollection
      .find()
      .sort({ createdAt: -1 }) // Сначала новые
      .skip(skip)
      .limit(limit)
      .toArray()) as Message[]
    
    logToFile(`Получено ${messages.length} сообщений из MongoDB`, 'INFO')
    return messages
  } catch (error) {
    logError(`Ошибка при получении сообщений из MongoDB: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

/**
 * Получает сообщение по ID
 * @param id ID сообщения
 */
export async function getMessageById(id: string): Promise<Message | null> {
  try {
    const message = await messagesCollection.findOne({ _id: new ObjectId(id) }) as Message | null
    return message
  } catch (error) {
    logError(`Ошибка при получении сообщения по ID ${id}: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

/**
 * Возвращает статистику буфера сообщений
 */
export function getBufferStats() {
  return {
    currentSize: buffer.length,
    maxSize: MAX_BUFFER_SIZE,
    totalProcessed: totalProcessedMessages,
    lastFlushTime: new Date(lastFlushTime).toISOString(),
    isLocked: isBufferLocked,
    pendingFlush: flushTimeout !== null
  }
}
