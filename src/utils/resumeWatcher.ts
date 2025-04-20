import { messagesCollection } from '@db/mongo'
import fs from 'fs'
import path from 'path'
import { ObjectId } from 'mongodb'
import { Message } from '@models/message'
import { logToFile, logError, logWarning } from '@utils/logger'

const LAST_MESSAGE_FILE = path.join(__dirname, '../../lastMessageId.json')
const POLL_INTERVAL = 1000 // Интервал опроса в мс
const MAX_BATCH_SIZE = 100 // Максимальное количество сообщений за один опрос
const MAX_RETRY_COUNT = 3 // Максимальное количество попыток переподключения
const RETRY_DELAY = 5000 // Задержка перед повторной попыткой в мс

import { promisify } from 'util'

const writeFile = promisify(fs.writeFile)
const readFile = promisify(fs.readFile)

/**
 * Сохраняет ID последнего обработанного сообщения
 * @param id ID последнего обработанного сообщения
 */
async function saveLastMessageId(id: string): Promise<void> {
  try {
    await writeFile(LAST_MESSAGE_FILE, JSON.stringify({ id, timestamp: new Date().toISOString() }))
    logToFile(`Последний ID сообщения сохранен: ${id}`, 'INFO')
  } catch (error) {
    logError(`Ошибка при сохранении ID сообщения: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Загружает ID последнего обработанного сообщения
 * @returns ID последнего обработанного сообщения или null
 */
async function loadLastMessageId(): Promise<string | null> {
  if (fs.existsSync(LAST_MESSAGE_FILE)) {
    try {
      const data = await readFile(LAST_MESSAGE_FILE, 'utf-8')
      const parsed = JSON.parse(data)
      
      if (parsed && parsed.id) {
        logToFile(`Загружен последний ID сообщения: ${parsed.id} (${parsed.timestamp || 'время неизвестно'})`, 'INFO')
        return parsed.id
      }
      
      logWarning('Файл с ID последнего сообщения имеет неверный формат')
      return null
    } catch (error) {
      logError(`Ошибка при загрузке ID сообщения: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
  logToFile('Файл с ID последнего сообщения не найден, начинаем отслеживание с начала', 'INFO')
  return null
}

/**
 * Опрос коллекции сообщений и обработка новых сообщений
 * @param onNewMessage Функция обратного вызова для обработки новых сообщений
 * @returns Функция для остановки отслеживания
 */
export function watchMessages(onNewMessage: (msg: Message) => void): () => void {
  let isPolling = false
  let lastMessageId: string | null = null
  let isActive = true
  let intervalId: NodeJS.Timeout | null = null
  let retryCount = 0
  
  // Инициализация с загрузкой последнего ID
  const init = async () => {
    try {
      lastMessageId = await loadLastMessageId()
      startPolling()
    } catch (error) {
      logError(`Ошибка при инициализации отслеживания: ${error instanceof Error ? error.message : String(error)}`)
      // Пытаемся переинициализировать через задержку
      setTimeout(init, RETRY_DELAY)
    }
  }
  
  // Запуск периодического опроса
  const startPolling = () => {
    if (!isActive) return
    
    logToFile('Запуск отслеживания изменений в коллекции messages (режим опроса)', 'INFO')
    if (lastMessageId) {
      logToFile(`Начало опроса с сообщения ID: ${lastMessageId}`, 'INFO')
    } else {
      logToFile('Начало опроса всех новых сообщений', 'INFO')
    }
    
    intervalId = setInterval(pollCollection, POLL_INTERVAL)
    
    // Начальный опрос
    pollCollection()
  }
  
  // Функция опроса коллекции
  const pollCollection = async () => {
    if (!isActive || isPolling) return
    
    isPolling = true
    try {
      // Формируем запрос: если есть lastMessageId, ищем сообщения с _id > lastMessageId
      let query = {}
      if (lastMessageId) {
        try {
          query = { _id: { $gt: new ObjectId(lastMessageId) } }
        } catch (error) {
          logError(`Ошибка при создании запроса с ObjectId: ${error instanceof Error ? error.message : String(error)}`)
          // Сбрасываем lastMessageId в случае ошибки
          lastMessageId = null
        }
      }
      
      // Получаем новые сообщения
      const newMessages = await messagesCollection
        .find(query)
        .sort({ _id: 1 })
        .limit(MAX_BATCH_SIZE)
        .toArray() as Message[]
      
      if (newMessages.length > 0) {
        logToFile(`Обнаружено ${newMessages.length} новых сообщений`, 'INFO')
        
        // Обрабатываем сообщения
        for (const msg of newMessages) {
          if (msg._id) {
            lastMessageId = msg._id.toString()
            await saveLastMessageId(lastMessageId)
            
            try {
              onNewMessage(msg)
            } catch (callbackError) {
              logError(`Ошибка в обработчике сообщения: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`)
            }
          }
        }
        
        // Сбрасываем счетчик повторных попыток при успешном получении сообщений
        retryCount = 0
      }
    } catch (error) {
      retryCount++
      const errorMessage = error instanceof Error ? error.message : String(error)
      logError(`Ошибка при опросе коллекции (попытка ${retryCount}/${MAX_RETRY_COUNT}): ${errorMessage}`)
      
      // Если достигли максимального количества попыток, перезапускаем опрос
      if (retryCount >= MAX_RETRY_COUNT) {
        logToFile('Достигнуто максимальное количество ошибок, перезапуск опроса...', 'INFO')
        stopPolling()
        
        // Перезапускаем опрос через задержку
        setTimeout(startPolling, RETRY_DELAY)
      }
    } finally {
      isPolling = false
    }
  }
  
  // Остановка периодического опроса
  const stopPolling = () => {
    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
      logToFile('Отслеживание изменений остановлено', 'INFO')
    }
  }
  
  // Остановка отслеживания
  const stop = () => {
    isActive = false
    stopPolling()
    logToFile('Отслеживание изменений полностью завершено', 'INFO')
  }
  
  // Запуск отслеживания
  init().catch(error => {
    logError(`Критическая ошибка при запуске отслеживания: ${error instanceof Error ? error.message : String(error)}`)
  })
  
  // Возвращаем функцию для остановки отслеживания
  return stop
}
