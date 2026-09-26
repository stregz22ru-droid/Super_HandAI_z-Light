// mcp-stdio.ts — защита канала stdio для MCP-входа.
// stdout зарезервирован под JSON-RPC MCP: ЛЮБОЙ случайный console.log из
// импортируемых модулей (registry/featureLog/engine) сломал бы протокол.
// Поэтому этот модуль обязан импортироваться ПЕРВЫМ в mcp.ts (ESM выполняет
// импорты в порядке объявления): console.log/info переносятся на stderr.
// process.stdout.write НЕ трогаем — им пользуется StdioServerTransport SDK.
const err = process.stderr;

const toLine = (args: unknown[]): string =>
  args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';

// eslint-disable-next-line no-console
console.log = (...args: unknown[]) => err.write(toLine(args));
// eslint-disable-next-line no-console
console.info = (...args: unknown[]) => err.write(toLine(args));
// console.warn/error и так идут в stderr — оставляем как есть.
