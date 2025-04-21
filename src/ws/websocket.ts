import { logToFile, logError, logWarning } from '@utils/logger'
import { watchMessages } from '@utils/resumeWatcher'
import { WebSocket, WebSocketServer } from 'ws'

// Расширяем тип WebSocket для добавления свойства isAlive
interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean
}

/**
 * Настройка WebSocket сервера для отправки уведомлений о новых сообщениях
 * @param wss WebSocketServer для настройки
 * @returns Функция для остановки слежения за сообщениями
 */
export function setupWebSocket(wss: WebSocketServer): () => void {
  let clientCount = 0
  let stopMessageWatcher: (() => void) | null = null
  const pingInterval = setInterval(() => pingClients(wss), 30000) // Пинг каждые 30 секунд
  
  // Настройка сервера WebSocket
  wss.on('connection', (ws: WebSocket, req) => {
    const extWs = ws as ExtendedWebSocket
    clientCount++
    const clientIp = req.socket.remoteAddress || 'unknown'
    logToFile(`WebSocket подключение установлено: ${clientIp}, всего клиентов: ${clientCount}`, 'INFO')
    
    // Установка свойств для обнаружения отключений
    extWs.isAlive = true
    extWs.on('pong', () => { extWs.isAlive = true })
    
    // Отправляем приветственное сообщение
    sendToClient(extWs, { type: 'info', message: 'WebSocket подключен' })
    
    // Обработка входящих сообщений
    extWs.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString())
        // Здесь можно обрабатывать команды от клиентов, если нужно
        logToFile(`Получено сообщение от клиента ${clientIp}: ${JSON.stringify(data)}`, 'INFO')
      } catch (error) {
        logWarning(`Не удалось разобрать сообщение от клиента ${clientIp}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    
    // Обработка закрытия соединения
    extWs.on('close', () => {
      clientCount--
      logToFile(`WebSocket соединение закрыто: ${clientIp}, осталось клиентов: ${clientCount}`, 'INFO')
    })
    
    // Обработка ошибок
    extWs.on('error', (error) => {
      logError(`WebSocket ошибка для клиента ${clientIp}: ${error.message}`)
    })
  })
  
  // Обработчик ошибок сервера
  wss.on('error', (error) => {
    logError(`WebSocket сервер ошибка: ${error.message}`)
  })
  
  // Обработчик закрытия сервера
  wss.on('close', () => {
    logToFile('WebSocket сервер закрыт', 'INFO')
    clearInterval(pingInterval)
  })
  
  logToFile('Инициализация отслеживания изменений в MongoDB', 'INFO')
  try {
    // Запуск отслеживания сообщений
    stopMessageWatcher = watchMessages((msg) => {
      const messageInfo = `${msg.user}: ${msg.text.substring(0, 20)}${msg.text.length > 20 ? '...' : ''}`
      logToFile(`Отправка нового сообщения всем клиентам: ${messageInfo}`, 'INFO')
      
      const payload = { type: 'new_message', data: msg }
      broadcastToClients(wss, payload)
    })
  } catch (error) {
    logError(`Ошибка при инициализации отслеживания изменений в MongoDB: ${error instanceof Error ? error.message : String(error)}`)
  }
  
  // Функция остановки всех процессов
  return () => {
    if (stopMessageWatcher) {
      stopMessageWatcher()
    }
    clearInterval(pingInterval)
    
    // Закрытие всех соединений
    wss.clients.forEach(client => {
      try {
        sendToClient(client as ExtendedWebSocket, { type: 'info', message: 'Сервер завершает работу' })
        client.terminate()
      } catch (error) {
        logError(`Ошибка при закрытии WebSocket соединения: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    
    logToFile('WebSocket сервис остановлен', 'INFO')
  }
}

/**
 * Отправка сообщения одному клиенту с обработкой ошибок
 * @param client WebSocket клиент
 * @param data Данные для отправки
 */
function sendToClient(client: WebSocket, data: any): void {
  try {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data))
    }
  } catch (error) {
    logError(`Ошибка при отправке данных клиенту: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Рассылка сообщения всем подключенным клиентам
 * @param wss WebSocketServer
 * @param data Данные для отправки
 */
function broadcastToClients(wss: WebSocketServer, data: any): void {
  let sentCount = 0
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      sendToClient(client, data)
      sentCount++
    }
  })
  logToFile(`Сообщение отправлено ${sentCount} клиентам`, 'INFO')
}

/**
 * Проверка соединений и удаление неактивных клиентов
 * @param wss WebSocketServer
 */
function pingClients(wss: WebSocketServer): void {
  wss.clients.forEach(client => {
    const extClient = client as ExtendedWebSocket
    if (extClient.isAlive === false) {
      logToFile('Отключение неактивного клиента', 'INFO')
      return client.terminate()
    }
    
    // Помечаем как неактивного до получения pong
    extClient.isAlive = false
    client.ping()
  })
}
 