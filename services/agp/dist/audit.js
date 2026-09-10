"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GhostweaveAudit = void 0;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
class GhostweaveAudit {
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
    }
    lastHash() {
        if (!(0, node_fs_1.existsSync)(this.filePath))
            return '0'.repeat(64);
        const lines = (0, node_fs_1.readFileSync)(this.filePath, 'utf8').trim().split('\n');
        const last = lines[lines.length - 1];
        try {
            return JSON.parse(last).hash;
        }
        catch {
            return '0'.repeat(64);
        }
    }
    // INTENT-событие: решение шлюза по интенту (формула хеша неизменна с Этапа 1)
    append(intent, decision) {
        const prev = this.lastHash();
        const seq = this.size() + 1;
        const ts = new Date().toISOString();
        const hash = (0, node_crypto_1.createHash)('sha256')
            .update(seq + '|' + ts + '|' + JSON.stringify(intent) + '|' + JSON.stringify(decision) + '|' + prev)
            .digest('hex');
        const entry = { seq, ts, kind: 'INTENT', intent, decision, prevHash: prev, hash };
        (0, node_fs_1.appendFileSync)(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
        return entry;
    }
    // RESULT-событие: отчёт агента «действие выполнено» (Этап 3, шаг 3)
    appendResult(result) {
        const prev = this.lastHash();
        const seq = this.size() + 1;
        const ts = new Date().toISOString();
        // Доменная метка 'RESULT' в хеше: INTENT- и RESULT-записи невозможно спутать
        const hash = (0, node_crypto_1.createHash)('sha256')
            .update(seq + '|' + ts + '|RESULT|' + JSON.stringify(result) + '|' + prev)
            .digest('hex');
        const entry = { seq, ts, kind: 'RESULT', result, prevHash: prev, hash };
        (0, node_fs_1.appendFileSync)(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
        return entry;
    }
    size() {
        if (!(0, node_fs_1.existsSync)(this.filePath))
            return 0;
        return (0, node_fs_1.readFileSync)(this.filePath, 'utf8').trim().split('\n').filter(Boolean).length;
    }
    verify() {
        if (!(0, node_fs_1.existsSync)(this.filePath))
            return { ok: true };
        const lines = (0, node_fs_1.readFileSync)(this.filePath, 'utf8').trim().split('\n').filter(Boolean);
        let prev = '0'.repeat(64);
        for (let i = 0; i < lines.length; i++) {
            let e;
            try {
                e = JSON.parse(lines[i]);
            }
            catch {
                return { ok: false, brokenAt: i + 1 };
            } // битый JSON = битая цепь (fail-secure)
            // Записи без kind (Этапы 1–2) трактуются как INTENT — обратная совместимость
            const expect = e && e.kind === 'RESULT'
                ? (0, node_crypto_1.createHash)('sha256')
                    .update(e.seq + '|' + e.ts + '|RESULT|' + JSON.stringify(e.result) + '|' + prev)
                    .digest('hex')
                : (0, node_crypto_1.createHash)('sha256')
                    .update(e.seq + '|' + e.ts + '|' + JSON.stringify(e.intent) + '|' + JSON.stringify(e.decision) + '|' + prev)
                    .digest('hex');
            if (e.prevHash !== prev || e.hash !== expect)
                return { ok: false, brokenAt: i + 1 };
            prev = e.hash;
        }
        return { ok: true };
    }
}
exports.GhostweaveAudit = GhostweaveAudit;
//# sourceMappingURL=audit.js.map