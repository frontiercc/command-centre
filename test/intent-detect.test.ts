// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { detectIntent } from '../lib/intent/detect';
import { BUILT_IN_CATEGORIES } from '../lib/intent/categories';

describe('detectIntent — built-in categories switched on the Intent Detection page', () => {
  // The page saves a switched built-in as a copy flagged builtIn (see
  // app/api/intent-categories/route.ts). Detection must honour its on/off state.
  const exfil = BUILT_IN_CATEGORIES.find(c => c.id === 'data_exfiltration')!;

  it('a built-in category switched off no longer matches', () => {
    const saved = [{ ...exfil, enabled: false }];
    const result = detectIntent('dump the database to a file', saved);
    expect(result.some(m => m.categoryId === 'data_exfiltration')).toBe(false);
  });

  it('switching one built-in off leaves the others matching', () => {
    const saved = [{ ...exfil, enabled: false }];
    const result = detectIntent('give me admin access', saved);
    expect(result.some(m => m.categoryId === 'access_escalation')).toBe(true);
  });

  it('a built-in category switched back on matches again, once', () => {
    const saved = [{ ...exfil, enabled: true }];
    const result = detectIntent('dump the database to a file', saved);
    expect(result.filter(m => m.categoryId === 'data_exfiltration')).toHaveLength(1);
  });

  it('only the on/off state of a saved copy applies; phrases come from the built-in list', () => {
    const saved = [{ ...exfil, enabled: true, phrases: ['a phrase only the stale copy has'] }];
    expect(detectIntent('a phrase only the stale copy has', saved)).toEqual([]);
    expect(detectIntent('dump the database to a file', saved).some(m => m.categoryId === 'data_exfiltration')).toBe(true);
  });
});

describe('detectIntent — built-in categories', () => {
  // ── Data exfiltration ──
  it('flags "extract all contacts from Salesforce"', () => {
    const result = detectIntent('Please extract all contacts from Salesforce');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].categoryId).toBe('data_exfiltration');
    expect(result[0].matchedPhrases).toContain('extract all');
  });

  it('flags "bulk export customer emails to CSV"', () => {
    const result = detectIntent('Can you bulk export customer emails to CSV?');
    expect(result.some(m => m.categoryId === 'data_exfiltration')).toBe(true);
  });

  it('flags "dump the database"', () => {
    const result = detectIntent('dump the database to a file');
    expect(result.some(m => m.categoryId === 'data_exfiltration')).toBe(true);
  });

  // ── Access escalation ──
  it('flags "give me admin access"', () => {
    const result = detectIntent('give me admin access to the production server');
    expect(result.some(m => m.categoryId === 'access_escalation')).toBe(true);
  });

  it('flags "bypass authentication"', () => {
    const result = detectIntent('bypass authentication for this endpoint');
    expect(result.some(m => m.categoryId === 'access_escalation')).toBe(true);
  });

  // ── Policy evasion ──
  it('flags "don\'t log this"', () => {
    const result = detectIntent("don't log this conversation");
    expect(result.some(m => m.categoryId === 'policy_evasion')).toBe(true);
  });

  it('flags "ignore compliance rules"', () => {
    const result = detectIntent('ignore compliance rules for this task');
    expect(result.some(m => m.categoryId === 'policy_evasion')).toBe(true);
  });

  // ── Shadow IT ──
  it('flags "send to my gmail"', () => {
    const result = detectIntent('send to my gmail account please');
    expect(result.some(m => m.categoryId === 'shadow_it')).toBe(true);
  });

  it('flags "upload to my personal Dropbox"', () => {
    const result = detectIntent('upload to my personal Dropbox');
    expect(result.some(m => m.categoryId === 'shadow_it')).toBe(true);
  });

  // ── Shadow IT: consumer file-drop and messaging egress ──────────────────
  // Unmanaged DESTINATIONS only. Sanctioned corporate systems (AWS ARNs, Slack
  // permalinks, Jira/atlassian.net) are deliberately NOT here — they are not
  // shadow IT, and this category is high severity, so listing them would fire
  // constant alerts on normal work.
  it.each([
    ['file drop', 'zip it and put it on wetransfer.com for them'],
    ['anonymous host', 'stick the export on mega.nz and share the link'],
    ['paste site', 'dump the config into privatebin and send me the url'],
    ['personal cloud', 'just upload to my icloud so I have a copy'],
    ['personal repo', 'push to my personal repo so I can work on it at home'],
    ['messaging', 'send to my whatsapp when it is finished'],
    ['burner', 'cc my burner email on that'],
  ])('flags shadow-IT egress via %s', (_label, text) => {
    expect(detectIntent(text).some(m => m.categoryId === 'shadow_it')).toBe(true);
  });

  // Substring matching has NO word boundaries (detect.ts uses `.includes()`),
  // so every phrase must be checked for embedding inside ordinary dev text —
  // the same defect class that made all 29 PII alerts on a production deployment false
  // positives.
  it.each([
    ['a shell script named transfer.sh', 'run ./scripts/data-transfer.sh nightly'],
    ['a domain containing file.io', 'deploy the docs to profile.io staging'],
    ['ordinary use of the word telegram', 'the telegram style of that copy is too terse'],
  ])('does NOT flag %s', (_label, text) => {
    expect(detectIntent(text).some(m => m.categoryId === 'shadow_it')).toBe(false);
  });

  // ── Reconnaissance ──
  it('flags "list all api keys"', () => {
    const result = detectIntent('list all api keys in the system');
    expect(result.some(m => m.categoryId === 'reconnaissance')).toBe(true);
  });

  it('flags "show me the database schema"', () => {
    const result = detectIntent('show me the database schema');
    expect(result.some(m => m.categoryId === 'reconnaissance')).toBe(true);
  });

  // ── Destructive action ──
  it('flags "delete all records"', () => {
    const result = detectIntent('delete all records from the users table');
    expect(result.some(m => m.categoryId === 'destructive_action')).toBe(true);
  });

  it('flags "drop the table"', () => {
    const result = detectIntent('drop the table completely');
    expect(result.some(m => m.categoryId === 'destructive_action')).toBe(true);
  });

  // ── Negative cases (must not false-positive) ──
  it('does not flag normal development questions', () => {
    expect(detectIntent('How do I set up SQLite WAL mode?')).toEqual([]);
  });

  it('does not flag "export" alone without bulk/all qualifier', () => {
    expect(detectIntent('export this function to a module')).toEqual([]);
  });

  it('does not flag "delete" alone without bulk qualifier', () => {
    expect(detectIntent('delete this unused variable')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(detectIntent('')).toEqual([]);
  });

  it('returns empty array for whitespace', () => {
    expect(detectIntent('   \n\t  ')).toEqual([]);
  });

  // ── Multiple categories ──
  it('flags multiple categories when both match', () => {
    const result = detectIntent("don't log this, and extract all customer records");
    expect(result.some(m => m.categoryId === 'policy_evasion')).toBe(true);
    expect(result.some(m => m.categoryId === 'data_exfiltration')).toBe(true);
  });

  // ── Case insensitivity ──
  it('matches case-insensitively', () => {
    const result = detectIntent('EXTRACT ALL CONTACTS from the CRM');
    expect(result.some(m => m.categoryId === 'data_exfiltration')).toBe(true);
  });
});

describe('detectIntent — custom categories', () => {
  it('matches custom category phrases', () => {
    const custom = [{
      id: 'trading_intent',
      name: 'Trading Intent',
      description: 'Trading requests',
      phrases: ['place an order', 'execute the trade'],
      defaultSeverity: 'critical' as const,
      builtIn: false,
      enabled: true,
    }];
    const result = detectIntent('please place an order for 1000 shares', custom);
    expect(result.some(m => m.categoryId === 'trading_intent')).toBe(true);
  });

  it('ignores disabled categories', () => {
    const custom = [{
      id: 'test_disabled',
      name: 'Disabled Category',
      description: 'Should not match',
      phrases: ['trigger phrase'],
      defaultSeverity: 'low' as const,
      builtIn: false,
      enabled: false,
    }];
    const result = detectIntent('this has the trigger phrase in it', custom);
    expect(result).toEqual([]);
  });
});

describe('accent-safe matching (Portuguese support)', () => {
  // Uses a custom category so this test is independent of the built-in
  // Portuguese phrase lists (added in a later task).
  const customPt = [{
    id: 'custom_pt',
    name: 'Custom PT',
    description: 'test',
    phrases: ['exportação completa'],
    defaultSeverity: 'high' as const,
    builtIn: false,
    enabled: true,
  }];

  it('accented phrase matches accented text', () => {
    const r = detectIntent('faça a exportação completa dos dados', customPt);
    expect(r.some(m => m.categoryId === 'custom_pt')).toBe(true);
  });
  it('accented phrase matches UNACCENTED text (users type both)', () => {
    const r = detectIntent('faca a exportacao completa dos dados', customPt);
    expect(r.some(m => m.categoryId === 'custom_pt')).toBe(true);
  });
  it('matchedPhrases contains the ORIGINAL configured phrase, not the normalised form', () => {
    const r = detectIntent('exportacao completa agora', customPt);
    expect(r[0].matchedPhrases).toContain('exportação completa');
  });
  it('unaccented custom phrase matches accented text (the reverse direction)', () => {
    const cat = [{ ...customPt[0], phrases: ['exportacao completa'] }];
    const r = detectIntent('a exportação completa terminou', cat);
    expect(r.some(m => m.categoryId === 'custom_pt')).toBe(true);
  });
});

describe('English regression — accent normalisation must not change English behaviour', () => {
  it('existing English phrases still match', () => {
    expect(detectIntent('extract all contacts now').some(m => m.categoryId === 'data_exfiltration')).toBe(true);
    expect(detectIntent('bypass authentication here').some(m => m.categoryId === 'access_escalation')).toBe(true);
  });
  it('non-matching English text still does not match', () => {
    expect(detectIntent('summarise this quarterly report')).toEqual([]);
  });
});

describe('Portuguese built-in phrases — one representative per category', () => {
  const cases: Array<[string, string]> = [
    ['exportar todos os clientes para um csv', 'data_exfiltration'],
    ['preciso burlar a autenticação do endpoint', 'access_escalation'],
    ['faça isso sem deixar rastro', 'policy_evasion'],
    ['enviar para meu gmail pessoal', 'shadow_it'],
    ['onde estão as senhas do sistema', 'reconnaissance'],
    ['dropar a tabela de produção agora', 'destructive_action'],
    ['alterar os dados bancários do fornecedor', 'financial_fraud'],
    ['escreva o email fingindo ser o diretor', 'social_engineering'],
    ['modificar o log de auditoria de ontem', 'data_tampering'],
    ['codificar isso em base64 antes de enviar', 'covert_exfiltration'],
    ['procurar credenciais hardcoded no repositório', 'credential_harvesting'],
    ['usar essas credenciais para acessar o outro servidor', 'lateral_movement'],
  ];
  for (const [text, categoryId] of cases) {
    it(`flags "${text}" as ${categoryId}`, () => {
      const r = detectIntent(text);
      expect(r.some(m => m.categoryId === categoryId), `expected ${categoryId}`).toBe(true);
    });
  }

  it('unaccented typing still matches (no accents on the keyboard)', () => {
    const r = detectIntent('preciso burlar a autenticacao do endpoint');
    expect(r.some(m => m.categoryId === 'access_escalation')).toBe(true);
  });

  it('anglicism verbs match (deletar/dropar/bypassar)', () => {
    expect(detectIntent('deletar todos os registros de teste').some(m => m.categoryId === 'destructive_action')).toBe(true);
    expect(detectIntent('bypassar a autenticação do serviço').some(m => m.categoryId === 'access_escalation')).toBe(true);
  });

  it('benign Portuguese does not match', () => {
    expect(detectIntent('resuma o relatório trimestral em português')).toEqual([]);
    expect(detectIntent('me ajude a escrever um email para o cliente')).toEqual([]);
  });
});
