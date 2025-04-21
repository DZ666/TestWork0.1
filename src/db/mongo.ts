import { MongoClient, Db, Collection } from 'mongodb'
import { logToFile, logError, logWarning } from '@utils/logger'

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017'
const DB_NAME = process.env.DB_NAME || 'chat'
const MONGO_OPTIONS = {
  connectTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  serverSelectionTimeoutMS: 5000,
  maxPoolSize: 10,
  minPoolSize: 5,
  retryWrites: true,
  retryReads: true
}

let client: MongoClient
let db: Db
let messagesCollection: Collection
let isConnected = false

/**
 * Подключение к MongoDB
 */
export async function connectToMongo() {
  if (isConnected) {
    logWarning('Повторный вызов подключения к MongoDB. Соединение уже установлено.')
    return
  }

  logToFile(`Попытка подключения к MongoDB: ${MONGO_URL}`, 'INFO')
  
  try {
    client = new MongoClient(MONGO_URL, MONGO_OPTIONS)
    await client.connect()
    logToFile('MongoDB: подключение установлено', 'INFO')
    
    db = client.db(DB_NAME)
    
    // Проверяем существование коллекции, создаем при необходимости
    const collections = await db.listCollections({ name: 'messages' }).toArray()
    if (collections.length === 0) {
      logToFile('Коллекция messages не найдена, создаю новую', 'INFO')
      await db.createCollection('messages')
      
      // Создаем индексы для оптимизации запросов
      await db.collection('messages').createIndex({ createdAt: 1 })
      await db.collection('messages').createIndex({ user: 1 })
      logToFile('Индексы для коллекции messages созданы', 'INFO')
    }
    
    messagesCollection = db.collection('messages')
    logToFile(`MongoDB: выбрана база данных ${DB_NAME} и коллекция messages`, 'INFO')
    
    isConnected = true
    
    // Настройка события для обработки ошибок соединения
    client.on('error', (error) => {
      logError(`MongoDB ошибка соединения: ${error.message}`)
      
      if (isConnected) {
        isConnected = false
        // Пытаемся переподключиться
        setTimeout(async () => {
          logToFile('Попытка переподключения к MongoDB...', 'INFO')
          try {
            await connectToMongo()
          } catch (reconnectError) {
            logError(`Ошибка переподключения к MongoDB: ${reconnectError instanceof Error ? reconnectError.message : String(reconnectError)}`)
          }
        }, 5000)
      }
    })
    
    // Обработка закрытия соединения
    client.on('close', () => {
      logToFile('MongoDB соединение закрыто', 'INFO')
      isConnected = false
    })
    
  } catch (error) {
    isConnected = false
    logError(`Ошибка при подключении к MongoDB: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

/**
 * Закрытие соединения с MongoDB
 */
export async function closeMongoConnection() {
  if (!client) {
    logWarning('Невозможно закрыть соединение: клиент MongoDB не инициализирован')
    return
  }
  
  try {
    await client.close()
    logToFile('MongoDB соединение успешно закрыто', 'INFO')
    isConnected = false
  } catch (error) {
    logError(`Ошибка при закрытии соединения с MongoDB: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

/**
 * Проверка состояния соединения
 */
export function isMongoConnected(): boolean {
  return isConnected
}

export { client, db, messagesCollection }
 