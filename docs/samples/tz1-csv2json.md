````markdown
```tz
# ЗАДАЧ: CSV→JSON CLI на TS
# META
workdir: new:csv2json
mode: confirm
on_fail: stop
cycle: 1

## ШАГ 1. Проект
RUN shell: pwsh
```pwsh
npm init -y; npm i csv-parse; npm i -D typescript @types/node; exit $LASTEXITCODE
```
EXPECT exit=0

## ШАГ 2. Исходник
WRITE tsconfig.json
```json
{"compilerOptions":{"target":"ES2022","module":"NodeNext","outDir":"dist","strict":true},"include":["src"]}
```
WRITE src/index.ts
```ts
import { parse } from "csv-parse/sync";
import { readFileSync, writeFileSync } from "node:fs";
const [inPath, outPath = inPath.replace(/\.csv$/, ".json")] = process.argv.slice(2);
const rows = parse(readFileSync(inPath, "utf8"), { columns: true });
writeFileSync(outPath, JSON.stringify(rows, null, 2));
console.log(`rows=${rows.length} -> ${outPath}`);
```

## ШАГ 3. Сборка и проверка
RUN shell: pwsh
```pwsh
npx tsc; exit $LASTEXITCODE
```
EXPECT exit=0
RUN shell: pwsh
```pwsh
Set-Content -Encoding utf8 sample.csv '"name","age"'; Add-Content -Encoding utf8 sample.csv '"Alice","30"'; node dist/index.js sample.csv; exit $LASTEXITCODE
```
EXPECT exit=0
EXPECT stdout contains: rows=1

## ШАГ 4. Чекпоинт
GIT commit: "init: рабочий конвертер"
```
````
