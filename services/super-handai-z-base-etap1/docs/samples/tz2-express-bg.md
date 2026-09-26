````markdown
```tz
# ЗАДАЧ: Express API с фоновым сервером
# META
workdir: new:express-api
mode: confirm
on_fail: stop
cycle: 1

## ШАГ 1. Проект
RUN shell: pwsh
```pwsh
npm init -y; npm i express; npm i -D typescript @types/node @types/express; exit $LASTEXITCODE
```
EXPECT exit=0

## ШАГ 2. Код
WRITE tsconfig.json
```json
{"compilerOptions":{"target":"ES2022","module":"NodeNext","outDir":"dist","strict":true},"include":["src"]}
```
WRITE src/server.ts
```ts
import express from "express";
const app = express();
app.get("/ping", (_q, r) => r.json({ pong: true }));
app.listen(3456, () => console.log("listening:3456"));
```

## ШАГ 3. Сборка и запуск сервера
RUN shell: pwsh
```pwsh
npx tsc; exit $LASTEXITCODE
```
EXPECT exit=0
RUN_BG shell: pwsh
```pwsh
node dist/server.js
```
WAIT stdout: listening:3456

## ШАГ 4. Проверка HTTP
RUN shell: bash
```bash
curl -s http://127.0.0.1:3456/ping | grep pong
```
EXPECT exit=0

## ШАГ 5. Чекпоинт
GIT commit: "init: express api с проверенным /ping"
```
````
