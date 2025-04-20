import { addMessageToBuffer, getAllMessages } from '@db/messageBuffer'
import { logToFile, logError, logWarning } from '@utils/logger'
import { Request, Response, Router } from 'express'

/**
 * Обработчик общих ошибок для маршрутов
 * @param res Объект ответа
 * @param error Ошибка
 * @param message Сообщение для пользователя
 */
function handleError(res: Response, error: unknown, message: string): void {
  logError(`Ошибка при ${message}: ${error instanceof Error ? error.message : String(error)}`)
  res.status(500).json({ error: message })
}

/**
 * Валидация сообщения с возвращением подробных ошибок
 * @param userData Данные пользователя
 * @param text Текст сообщения
 */
function validateMessage(userData: unknown, text: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // Проверка пользователя
  if (!userData) {
    errors.push('Поле user обязательно')
  } else if (typeof userData !== 'string') {
    errors.push('Поле user должно быть строкой')
  } else if (userData.trim().length === 0) {
    errors.push('Поле user не должно быть пустым')
  } else if (userData.length > 100) {
    errors.push('Имя пользователя слишком длинное (максимум 100 символов)')
  }

  // Проверка текста
  if (!text) {
    errors.push('Поле text обязательно')
  } else if (typeof text !== 'string') {
    errors.push('Поле text должно быть строкой')
  } else if (text.trim().length === 0) {
    errors.push('Поле text не должно быть пустым')
  } else if (text.length > 5000) {
    errors.push('Текст сообщения слишком длинный (максимум 5000 символов)')
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

const router = Router()

/**
 * GET /messages - Получить список сообщений с пагинацией
 */
router.get('/', async (req: Request, res: Response) => {
  const clientIp = req.ip || 'unknown'
  logToFile(`GET /messages запрос от ${clientIp}`, 'INFO')

  // Параметры пагинации и сортировки
  const limit = parseInt(req.query.limit as string) || 100
  const skip = parseInt(req.query.skip as string) || 0

  // Проверка параметров
  if (limit > 500) {
    logWarning(`Запрошен слишком большой limit=${limit}, ограничено до 500`)
    return res.status(400).json({ error: 'Максимальное значение для limit - 500' })
  }

  try {
    const messages = await getAllMessages(limit, skip)
    
    // Добавляем метаданные о пагинации
    const response = {
      data: messages,
      meta: {
        limit,
        skip,
        count: messages.length
      }
    }
    
    logToFile(`Успешно отправлено ${messages.length} сообщений клиенту`, 'INFO')
    res.json(response)
  } catch (error) {
    handleError(res, error, 'Ошибка при получении сообщений')
  }
})

/**
 * POST /messages - Создать новое сообщение
 */
router.post('/', async (req: Request, res: Response) => {
  const clientIp = req.ip || 'unknown'
  logToFile(`POST /messages запрос от ${clientIp}: ${JSON.stringify(req.body)}`, 'INFO')

  const { user, text } = req.body
  
  // Валидация данных
  const validation = validateMessage(user, text)
  if (!validation.valid) {
    logWarning(`Ошибка валидации: ${validation.errors.join(', ')}`)
    return res.status(400).json({ error: 'Невалидные данные', details: validation.errors })
  }

  try {
    await addMessageToBuffer({ 
      user: String(user).trim(), 
      text: String(text).trim(), 
      createdAt: new Date() 
    })
    logToFile(`Сообщение от ${user} добавлено в буфер`, 'INFO')
    res.status(201).json({ status: 'accepted' })
  } catch (error) {
    handleError(res, error, 'Ошибка при добавлении сообщения')
  }
})

export default router
