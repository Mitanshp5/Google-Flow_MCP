import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { reserveProjectCredits, projectCreditCap } from '../src/utils/project-credit-budget.js';

const homes = [];
function home() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-budget-test-')); homes.push(dir); return dir; }
afterEach(() => homes.splice(0).forEach(dir => fs.rmSync(dir, {recursive:true,force:true})));
describe('persistent total project budget', () => {
  it('defaults to 50, counts cumulative quotes and refuses over-budget clicks', () => {
    expect(projectCreditCap()).toBe(50);
    const args = {home:home(),account:'test',projectId:'project',operationId:'one',credits:30};
    expect(reserveProjectCredits(args).remaining).toBe(20);
    expect(() => reserveProjectCredits({...args,operationId:'two',credits:21})).toThrow(/cap 50 exceeded/);
    expect(reserveProjectCredits({...args,operationId:'three',credits:20}).remaining).toBe(0);
  });
  it('persists reservations and isolates projects and accounts', () => {
    const args = {home:home(),account:'test',projectId:'one',operationId:'first',credits:40};
    reserveProjectCredits(args);
    expect(() => reserveProjectCredits({...args,operationId:'next',credits:11})).toThrow(/cap 50 exceeded/);
    expect(reserveProjectCredits({...args,projectId:'two'}).remaining).toBe(10);
    expect(reserveProjectCredits({...args,account:'other'}).remaining).toBe(10);
  });
  it('rejects duplicate intents, unknown prices and invalid caps', () => {
    const args = {home:home(),account:'test',projectId:'one',operationId:'first',credits:4};
    reserveProjectCredits(args);
    expect(() => reserveProjectCredits(args)).toThrow(/already reserved/);
    expect(() => reserveProjectCredits({...args,credits:NaN})).toThrow(/known non-negative/);
    expect(() => reserveProjectCredits({...args,cap:-1})).toThrow(/known non-negative/);
  });
});
