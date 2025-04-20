#!/bin/bash

# Этот скрипт запускает Docker контейнер с MongoDB для проекта.

# Проверяем, запущен ли уже контейнер с таким именем
if [ $(docker ps -q -f name=mongo-for-testwork) ]; then
    echo "Контейнер 'mongo-for-testwork' уже запущен."
else
    # Проверяем, существует ли контейнер (остановлен)
    if [ $(docker ps -aq -f name=mongo-for-testwork) ]; then
        echo "Контейнер 'mongo-for-testwork' существует, но остановлен. Запускаем..."
        docker start mongo-for-testwork
    else
        # Создаем и запускаем новый контейнер как репликасет
        echo "Контейнер 'mongo-for-testwork' не найден. Создаем и запускаем новый как репликасет..."
        docker run --name mongo-for-testwork -p 27017:27017 -d mongo:latest --replSet rs0
        if [ $? -ne 0 ]; then
            echo "Ошибка при запуске Docker контейнера."
            exit 1
        fi
    fi
    
    # Ожидаем некоторое время, чтобы MongoDB успела запуститься
    echo "Ожидание запуска MongoDB..."
    sleep 10

    # Проверяем статус репликасета и инициализируем, если необходимо
    # Проверяем статус репликасета и инициализируем, если необходимо
    echo "Проверка статуса репликасета..."
    docker exec mongo-for-testwork mongo --eval 'rs.status()'
    
    MONGO_STATUS=$(docker exec mongo-for-testwork mongo --quiet --eval 'rs.status().ok' 2>/dev/null)
    if [ "$MONGO_STATUS" != "1" ]; then
        echo "Инициализация репликасета..."
        docker exec mongo-for-testwork mongo --eval 'rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] })'
        echo "Ожидание инициализации репликасета..."
        sleep 10
        # Повторная проверка статуса после инициализации
        echo "Повторная проверка статуса репликасета после инициализации..."
        docker exec mongo-for-testwork mongo --eval 'rs.status()'
    else
        echo "Репликасет уже инициализирован."
    fi
fi

echo "Статус контейнера 'mongo-for-testwork':"
docker ps -f name=mongo-for-testwork

echo "MongoDB должна быть доступна на mongodb://localhost:27017"