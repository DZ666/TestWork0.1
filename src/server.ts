// Регистрация псевдонимов путей для скомпилированного кода
import 'module-alias/register';

import express from 'express';
import { connectToMongo } from '@db/mongo';
import messageRoutes from '@routes/messages';
import { setupWebSocket } from '@ws/websocket';
import http from 'http';
import path from 'path';
import { logError, logToFile } from '@utils/logger';
import { WebSocketServer } from 'ws';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Промежуточное ПО для логирования запросов
app.use((req, res, next) => {
  logToFile(`${req.method} ${req.url}`, 'INFO');
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logToFile(`${req.method} ${req.url} ${res.statusCode} ${duration}ms`, 'INFO');
  });
  
  next();
});

// Обработка ошибок JSON парсинга
app.use(express.json({ 
  limit: '1mb',
  strict: true,
  reviver: (key, value) => {
    // Преобразуем строки даты в объекты Date
    if (typeof value === 'string' && 
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/.test(value)) {
      return new Date(value);
    }
    return value;
  }
}));

// Устанавливаем лимиты для защиты от DoS-атак
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// CORS для разработки
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// Маршруты
app.use('/messages', messageRoutes);

// Статическая страница для чата
app.use(express.static(path.join(__dirname, '../public')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Обработка ошибки 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Маршрут не найден' });
});

// Глобальный обработчик ошибок
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logError(`Необработанная ошибка: ${err.message}\n${err.stack}`);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const PORT = process.env.PORT || 3000;
let isShuttingDown = false;

async function start() {
  logToFile('Запуск сервера', 'INFO');
  try {
    await connectToMongo();
    logToFile('Подключено к MongoDB', 'INFO');
    
    const stopWebsocket = setupWebSocket(wss);
    logToFile('WebSocket сервер запущен', 'INFO');
    
    const httpServer = server.listen(PORT, () => {
      logToFile(`Сервер запущен на порту ${PORT}`, 'INFO');
    });
    
    // Корректное завершение работы
    process.on('SIGTERM', () => gracefulShutdown(httpServer, stopWebsocket));
    process.on('SIGINT', () => gracefulShutdown(httpServer, stopWebsocket));
    
  } catch (error) {
    logError(`Ошибка при запуске: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Функция корректного завершения работы
async function gracefulShutdown(httpServer: http.Server, stopWebsocket: () => void) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  logToFile('Получен сигнал завершения. Начинаем корректное закрытие...', 'INFO');
  
  // Устанавливаем таймаут на случай зависания
  const forceExit = setTimeout(() => {
    logError('Принудительное завершение из-за таймаута');
    process.exit(1);
  }, 30000);
  
  try {
    // Прекращаем принимать новые соединения
    httpServer.close(() => {
      logToFile('HTTP сервер остановлен', 'INFO');
    });
    
    // Останавливаем WebSocket-сервер
    stopWebsocket();
    logToFile('WebSocket мониторинг остановлен', 'INFO');
    
    // Закрываем соединения с MongoDB и очищаем ресурсы
    await import('@db/mongo').then(async ({ closeMongoConnection }) => {
      await closeMongoConnection();
      logToFile('MongoDB соединение закрыто', 'INFO');
    });
    
    clearTimeout(forceExit);
    logToFile('Сервер успешно завершил работу', 'INFO');
    process.exit(0);
  } catch (error) {
    logError(`Ошибка при завершении работы: ${error instanceof Error ? error.message : String(error)}`);
    clearTimeout(forceExit);
    process.exit(1);
  }
}

// Глобальная обработка необработанных исключений
process.on('uncaughtException', (error) => {
  logError(`Необработанное исключение: ${error.message}\n${error.stack}`);
  // Принудительное завершение после необработанного исключения
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  logError(`Необработанное отклонение промиса: ${reason instanceof Error ? reason.message : String(reason)}`);
});

// Запуск приложения
start(); 