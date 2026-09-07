// test/guard.test.ts
import { describe, it, expect } from 'vitest';
import { checkScript, checkWritePath } from '../src/core/guard.js';

const WS = 'C:/Super_HandAI_z/workspace';

describe('guard', () => {
  it('rm -rf — deny', () => {
    expect(checkScript('rm -rf /').denied).toBe(true);
  });

  it('Remove-Item -Recurse -Force — deny', () => {
    expect(checkScript('Remove-Item ./x -Recurse -Force').denied).toBe(true);
  });

  it('Format-Volume — deny', () => {
    expect(checkScript('Format-Volume -DriveLetter C').denied).toBe(true);
  });

  it('Clear-Disk — deny', () => {
    expect(checkScript('Clear-Disk -Number 0').denied).toBe(true);
  });

  it('Stop-Computer — deny', () => {
    expect(checkScript('Stop-Computer').denied).toBe(true);
  });

  it('shutdown — deny', () => {
    expect(checkScript('shutdown /s /t 0').denied).toBe(true);
  });

  it('mkfs — deny', () => {
    expect(checkScript('mkfs.ext4 /dev/sda1').denied).toBe(true);
  });

  it('dd of=/dev/ — deny', () => {
    expect(checkScript('dd if=/dev/zero of=/dev/sda bs=1M').denied).toBe(true);
  });

  it('taskkill — deny', () => {
    expect(checkScript('taskkill /F /IM node.exe').denied).toBe(true);
  });

  it('Set-ExecutionPolicy — deny', () => {
    expect(checkScript('Set-ExecutionPolicy Unrestricted').denied).toBe(true);
  });

  it('fork bomb — deny', () => {
    expect(checkScript(':(){ :|:& };:').denied).toBe(true);
  });

  it('rm -rf node_modules внутри workspace — всё равно deny (абсолютный список)', () => {
    expect(checkScript('rm -rf node_modules').denied).toBe(true);
  });

  it('WRITE с абсолютным путём вне workspace → deny', () => {
    expect(checkWritePath('C:/Windows/System32/evil.bat', WS).denied).toBe(true);
  });

  it('WRITE с .. — будет детектить? guard не проверяет .. сам, это задача линтера. Проверяем абсолютные.', () => {
    expect(checkWritePath('sub/file.txt', WS).denied).toBe(false);
  });

  it('обычные npm i — пропускает', () => {
    expect(checkScript('npm i express').denied).toBe(false);
  });

  it('git status — пропускает', () => {
    expect(checkScript('git status').denied).toBe(false);
  });

  it('Remove-Item без -Force/-Recurse — пропускает', () => {
    expect(checkScript('Remove-Item ./single.txt').denied).toBe(false);
  });
});
