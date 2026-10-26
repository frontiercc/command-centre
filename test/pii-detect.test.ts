// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { detectPii, detectPiiWithMatches, redactPii, validateCpf, PII_PATTERNS } from '../lib/pii/detect';

describe('detectPii', () => {
  // ── Existing patterns (must not regress) ──
  it('detects email addresses', () => {
    expect(detectPii('contact john@example.com for details')).toContain('email');
  });
  it('detects UK phone numbers', () => {
    expect(detectPii('call 07700 900123 now')).toContain('uk_phone');
    expect(detectPii('call +44 7700 900123')).toContain('uk_phone');
  });
  it('detects NINOs', () => {
    expect(detectPii('NI number AB123456C')).toContain('nino');
  });
  it('does not flag NINO-shaped strings with an invalid first letter (D/F/I/Q/U/V excluded)', () => {
    expect(detectPii('ref DA123456A')).not.toContain('nino');
    expect(detectPii('ref FA123456A')).not.toContain('nino');
    expect(detectPii('ref QA123456A')).not.toContain('nino');
  });
  it('does not flag NINO-shaped strings with an invalid second letter (O excluded)', () => {
    expect(detectPii('ref AO123456A')).not.toContain('nino');
  });
  it('does not flag NINO-shaped strings with a denylisted two-letter prefix', () => {
    expect(detectPii('ref GB123456A')).not.toContain('nino');
    expect(detectPii('ref BG123456A')).not.toContain('nino');
    expect(detectPii('ref NK123456A')).not.toContain('nino');
    expect(detectPii('ref ZZ123456A')).not.toContain('nino');
  });
  it('does not flag a tool-use-id hex fragment that coincidentally matches the loose shape', () => {
    // A false positive seen in real use: a <task-notification> block's
    // task-id/tool-use-id hex string matched the old unvalidated regex.
    expect(detectPii('tool-use-id: da123456a1b2c3')).not.toContain('nino');
  });
  it('detects credit card numbers', () => {
    expect(detectPii('card 4111 1111 1111 1111')).toContain('credit_card');
    expect(detectPii('card 4111-1111-1111-1111')).toContain('credit_card');
  });

  // ── False-positive shapes seen in real use ──────────────────────────────────
  // Every nino/uk_phone/credit_card/us_phone alert in one review (29 in total)
  // was a false positive. The strings below are invented, with the same shapes
  // as the real matches. Root cause in every case: the pattern has no token boundaries, so
  // it matches inside a longer identifier — or, for credit_card, `[\s-]?`
  // matched a NEWLINE and glued adjacent spreadsheet cells into a "card".
  describe('false-positive shapes seen in real use', () => {
    it('does not flag a Salesforce 18-char record id as a NINO', () => {
      // 4 of the 8 nino alerts. `a9|hQ700000B|krta` — mid-token, and `Q` is not
      // even a legal NINO second letter (HMRC excludes D/F/I/Q/U/V).
      expect(detectPii("','a9hQ700000BkrtaIAB','a9hQ700000BkrtbIAZ'")).not.toContain('nino');
    });
    it('does not flag a CloudWatch log-stream hex hash as a NINO', () => {
      expect(detectPii('/[$LATEST]7b1e3f09ac524318b6a0c3d57f2b9e41",')).not.toContain('nino');
    });
    it('does not flag ordinary English prose as a NINO', () => {
      // The starkest one: "th|an 413207 b|ecause" — the pattern read straight
      // across two word boundaries into the middle of a sentence.
      expect(detectPii('branch rather than 413207 because achieving 3')).not.toContain('nino');
    });
    it('does not flag a UUID hex fragment as a NINO', () => {
      expect(detectPii('d27f-41bc-a93e-b05cf817362d</file_uuid>')).not.toContain('nino');
    });

    it('does not flag a Slack permalink timestamp as a UK phone number', () => {
      expect(detectPii('C0XX0X2XXXX/p1739071234567890')).not.toContain('uk_phone');
    });
    it('does not flag a LinkedIn activity URN as a UK phone number', () => {
      expect(detectPii('i-activity-7123450123456789012-Ab12?utm_source=')).not.toContain('uk_phone');
    });
    it('does not flag tab/newline-separated query results as a UK phone number', () => {
      expect(detectPii('ndroid\t51834072\t7203946\t16420583\t39175264')).not.toContain('uk_phone');
      expect(detectPii('display_rows\n1\n208361\n4810529.0\n35906')).not.toContain('uk_phone');
    });

    it('does not flag a UUID prefix as a credit card', () => {
      // 8-4-4 digit groups read as 4-4-4-4 once hyphens count as separators.
      expect(detectPii('/-workspace/41827305-6194-4832-bfde-9a17c3e5d062')).not.toContain('credit_card');
      expect(detectPii('/uploads/38194027-5612-4973-b1c4-d6a2f9e08b37')).not.toContain('credit_card');
    });
    it('does not flag adjacent spreadsheet cells as a credit card', () => {
      expect(detectPii('eng_set\n1\n7042\n5900\n4100\n6233\n3190')).not.toContain('credit_card');
      expect(detectPii('alances_movements\n31742809\n52918463\n3\ninventory')).not.toContain('credit_card');
    });

    it('does not flag ATS / GitHub numeric ids as a US phone number', () => {
      expect(detectPii('greenhouse.io/examplecorp/jobs/5021934768')).not.toContain('us_phone');
      expect(detectPii('issues/142#issuecomment-6318204957')).not.toContain('us_phone');
      expect(detectPii('1 6203 4185 208361 7316 i want you to')).not.toContain('us_phone');
    });
  });
  it('detects sk- API keys', () => {
    expect(detectPii('key is sk-proj-a1b2c3d4e5f6g7h8i9j0k1l2')).toContain('api_key');
  });

  // ── New GDPR patterns ──
  it('detects IBANs with digits only', () => {
    expect(detectPii('pay to GB29 NWBK 6016 1331 9268 19')).toContain('iban');
  });
  it('detects IBANs with letters in BBAN', () => {
    expect(detectPii('pay to FR76 3000 6000 0112 3456 7890 189')).toContain('iban');
  });
  it('detects IP addresses', () => {
    expect(detectPii('server at 192.168.1.42')).toContain('ip_address');
    expect(detectPii('external 10.0.0.1 host')).toContain('ip_address');
  });
  it('detects date of birth patterns', () => {
    expect(detectPii('DOB: 15/03/1990')).toContain('date_of_birth');
    expect(detectPii('date of birth = 1990-03-15')).toContain('date_of_birth');
    expect(detectPii('born: 15.03.90')).toContain('date_of_birth');
  });
  it('does not flag plain dates without DOB keyword', () => {
    expect(detectPii('meeting on 15/03/2024')).not.toContain('date_of_birth');
  });
  it('detects US SSN', () => {
    expect(detectPii('SSN is 123-45-6789')).toContain('us_ssn');
  });
  it('detects passport numbers with keyword', () => {
    expect(detectPii('passport: AB1234567')).toContain('passport');
    expect(detectPii('Passport = X123456789')).toContain('passport');
  });
  it('does not flag alphanumeric codes without passport keyword', () => {
    expect(detectPii('product code AB1234567')).not.toContain('passport');
  });
  it('detects US phone numbers', () => {
    expect(detectPii('call (555) 123-4567')).toContain('us_phone');
    expect(detectPii('number 555.123.4567')).toContain('us_phone');
  });

  // ── New ISO 27001 secret patterns ──
  it('detects AWS access keys', () => {
    expect(detectPii('key AKIAIOSFODNN7EXAMPLE')).toContain('aws_key');
  });
  it('does not flag short AKIA strings', () => {
    expect(detectPii('AKIA is a prefix')).not.toContain('aws_key');
  });
  it('detects GitHub tokens', () => {
    expect(detectPii('token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890ab')).toContain('github_token');
  });
  it('detects JWT tokens', () => {
    expect(detectPii('auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0')).toContain('jwt_token');
  });
  it('detects private key headers', () => {
    expect(detectPii('-----BEGIN RSA PRIVATE KEY-----')).toContain('private_key'); // gitleaks:allow (header text only, no key)
    expect(detectPii('-----BEGIN EC PRIVATE KEY-----')).toContain('private_key'); // gitleaks:allow (header text only, no key)
  });
  it('detects connection strings', () => {
    expect(detectPii('postgres://user:pass@localhost/db')).toContain('connection_string');
    expect(detectPii('mongodb://admin:secret@host:27017/mydb')).toContain('connection_string');
    expect(detectPii('redis://default:password@cache:6379')).toContain('connection_string');
  });
  it('detects generic secrets', () => {
    expect(detectPii('password = "myS3cretP@ss"')).toContain('generic_secret');
    expect(detectPii("api_key: 'longSecretValue123'")).toContain('generic_secret');
    expect(detectPii('secret = "abcdefghij"')).toContain('generic_secret');
  });
  it('does not flag short password values', () => {
    expect(detectPii('password = "short"')).not.toContain('generic_secret');
  });

  // ── Combo and edge cases ──
  it('detects multiple patterns in one text', () => {
    const result = detectPii('Email john@example.com, card 4111 1111 1111 1111, server 192.168.1.1');
    expect(result).toContain('email');
    expect(result).toContain('credit_card');
    expect(result).toContain('ip_address');
  });
  it('returns empty array for clean text', () => {
    expect(detectPii('What are best practices for SQLite WAL mode?')).toEqual([]);
  });
  it('returns empty array for empty string', () => {
    expect(detectPii('')).toEqual([]);
  });
  it('returns empty array for whitespace', () => {
    expect(detectPii('   \n\t  ')).toEqual([]);
  });

  // ── Boundary fixes ──
  it('does not flag an IBAN shape embedded in a longer alphanumeric token', () => {
    expect(detectPii('ref XGB82WEST12345698765432X')).not.toContain('iban');
    expect(detectPii('buildid GB82WEST12345698765432abc')).not.toContain('iban');
  });
  it('still detects a genuine IBAN', () => {
    expect(detectPii('pay to GB82 WEST 1234 5698 7654 32')).toContain('iban');
    expect(detectPii('pay to GB82WEST12345698765432')).toContain('iban');
  });
  it('does not join two lines into an IBAN', () => {
    expect(detectPii('GB82\nWEST\n1234\n5698')).not.toContain('iban');
  });

  it('does not flag an SSN shape inside a longer hyphenated code', () => {
    expect(detectPii('part X-123-45-6789')).not.toContain('us_ssn');
    expect(detectPii('order 123-45-6789-01')).not.toContain('us_ssn');
  });
  it('still detects a genuine SSN', () => {
    expect(detectPii('SSN 123-45-6789')).toContain('us_ssn');
  });

  it('does not join two lines into a Brazilian phone number', () => {
    expect(detectPii('(11) 98765\n4321')).not.toContain('br_phone');
  });
  it('still detects a genuine Brazilian phone number', () => {
    expect(detectPii('ligue (11) 98765-4321')).toContain('br_phone');
    expect(detectPii('ligue +55 11 98765 4321')).toContain('br_phone');
  });
});

describe('redactPii', () => {
  it('masks structured PII so the raw value no longer appears', () => {
    const out = redactPii('Email me at bob@example.com or call 415-555-0199.');
    expect(out).not.toContain('bob@example.com');
    expect(out).not.toContain('415-555-0199');
    expect(out).toContain('Email me at'); // surrounding prose preserved
  });
  it('leaves prose with no PII unchanged', () => {
    const s = 'Redline the vendor contract against our clause playbook.';
    expect(redactPii(s)).toBe(s);
  });
  it('handles empty string', () => {
    expect(redactPii('')).toBe('');
  });
});

describe('detectPiiWithMatches — masking', () => {
  it('masks credit card numbers (last 4 visible)', () => {
    const matches = detectPiiWithMatches('card 4111 0008 1111 1234');
    const cc = matches.find(m => m.type === 'credit_card');
    expect(cc).toBeDefined();
    expect(cc!.masked).toBe('****-****-****-1234');
  });

  it('masks credit card with dashes', () => {
    const matches = detectPiiWithMatches('card 4111-0002-1111-5678');
    const cc = matches.find(m => m.type === 'credit_card');
    expect(cc!.masked).toBe('****-****-****-5678');
  });

  it('masks NINOs (prefix + suffix visible)', () => {
    const matches = detectPiiWithMatches('NI number AB123456C');
    const nino = matches.find(m => m.type === 'nino');
    expect(nino).toBeDefined();
    expect(nino!.masked).toBe('AB *** ***C');
  });

  it('masks US SSNs (last 4 visible)', () => {
    const matches = detectPiiWithMatches('SSN 123-45-6789');
    const ssn = matches.find(m => m.type === 'us_ssn');
    expect(ssn).toBeDefined();
    expect(ssn!.masked).toBe('***-**-6789');
  });

  it('masks emails (first char + domain visible)', () => {
    const matches = detectPiiWithMatches('email john@example.com');
    const email = matches.find(m => m.type === 'email');
    expect(email).toBeDefined();
    expect(email!.masked).toBe('j***@example.com');
  });

  it('masks UK phone numbers (last 4 visible)', () => {
    const matches = detectPiiWithMatches('call 07700 900123');
    const phone = matches.find(m => m.type === 'uk_phone');
    expect(phone).toBeDefined();
    expect(phone!.masked).toMatch(/\*+0123$/);
  });

  it('masks IP addresses (last octet visible)', () => {
    const matches = detectPiiWithMatches('IP is 192.168.1.100');
    const ip = matches.find(m => m.type === 'ip_address');
    expect(ip).toBeDefined();
    expect(ip!.masked).toBe('***.***.***.100');
  });

  it('masks API keys (prefix + last 3)', () => {
    const matches = detectPiiWithMatches('key sk-abc123def456ghi789jkl');
    const key = matches.find(m => m.type === 'api_key');
    expect(key).toBeDefined();
    expect(key!.masked).toMatch(/^sk-\*\*\*\.\.\.jkl$/);
  });

  it('masks AWS keys (prefix + last 4)', () => {
    const matches = detectPiiWithMatches('AKIAIOSFODNN7EXAMPLE');
    const aws = matches.find(m => m.type === 'aws_key');
    expect(aws).toBeDefined();
    expect(aws!.masked).toBe('AKIA***MPLE');
  });

  it('masks private keys as [private key detected]', () => {
    const matches = detectPiiWithMatches('-----BEGIN RSA PRIVATE KEY-----');
    const pk = matches.find(m => m.type === 'private_key');
    expect(pk).toBeDefined();
    expect(pk!.masked).toBe('[private key detected]');
  });

  it('masks connection strings as [connection string detected]', () => {
    const matches = detectPiiWithMatches('postgres://user:pass@host/db');
    const cs = matches.find(m => m.type === 'connection_string');
    expect(cs).toBeDefined();
    expect(cs!.masked).toBe('[connection string detected]');
  });

  it('returns empty array for clean text', () => {
    expect(detectPiiWithMatches('nothing sensitive here')).toEqual([]);
  });

  it('returns multiple matches for text with multiple PII types', () => {
    const matches = detectPiiWithMatches('card 4111 0008 1111 1234, email john@test.com');
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.find(m => m.type === 'credit_card')).toBeDefined();
    expect(matches.find(m => m.type === 'email')).toBeDefined();
  });
});

describe('CPF detection (Brazil)', () => {
  // 529.982.247-25 and 111.444.777-35 are classic valid test CPFs.
  it('detects a valid formatted CPF', () => {
    expect(detectPii('meu cpf é 529.982.247-25')).toContain('cpf');
  });
  it('detects a valid bare CPF', () => {
    expect(detectPii('cadastro 52998224725 confirmado')).toContain('cpf');
  });
  it('detects the formatted CPF the §3.2 probe missed', () => {
    expect(detectPii('CPF: 111.444.777-35')).toContain('cpf');
  });
  it('rejects an 11-digit run with bad check digits', () => {
    expect(detectPii('pedido 12345678901 enviado')).not.toContain('cpf');
  });
  it('rejects all-same-digit CPFs (which pass naive mod-11)', () => {
    expect(detectPii('teste 111.111.111-11')).not.toContain('cpf');
    expect(detectPii('teste 00000000000')).not.toContain('cpf');
  });
  it('yields ZERO matches on the spec §3.2 noise corpus', () => {
    const noise = [
      'order id 12345678901',                    // sequential digits, bad check
      'invoice 98765432109 attached',            // bad check digits
      'tracking 40123456789 in transit',         // bad check digits
      'phone digits 07700900123 called',         // bad check digits
      'repeated 22222222222 filler',             // all-same-digit
      'placeholder 00000000000 zeros',           // all-same-digit
      'txn 10203040506 processed',               // bad check digits
      'ref 55544433221 logged',                  // bad check digits
      'batch 31415926535 pi digits',             // bad check digits
      'serial 27182818284 e digits',             // bad check digits
    ];
    for (const s of noise) {
      expect(detectPii(s), `false positive on: ${s}`).not.toContain('cpf');
    }
  });
  it('masks a CPF showing only the check-digit block', () => {
    const matches = detectPiiWithMatches('cpf 529.982.247-25');
    const cpf = matches.find(m => m.type === 'cpf');
    expect(cpf).toBeDefined();
    expect(cpf!.masked).toBe('***.***.***-25');
  });
  it('detectPiiWithMatches skips an invalid candidate and finds a later valid one', () => {
    // First 11-digit run fails validation, second passes — the exec loop must advance.
    const matches = detectPiiWithMatches('ids 12345678901 then 52998224725');
    expect(matches.some(m => m.type === 'cpf')).toBe(true);
  });
});

describe('validateCpf', () => {
  it('accepts valid CPFs in both forms', () => {
    expect(validateCpf('529.982.247-25')).toBe(true);
    expect(validateCpf('52998224725')).toBe(true);
    expect(validateCpf('111.444.777-35')).toBe(true);
  });
  it('rejects wrong length, bad check digits, and repeated digits', () => {
    expect(validateCpf('1234567890')).toBe(false);      // 10 digits
    expect(validateCpf('12345678901')).toBe(false);     // bad check
    expect(validateCpf('11111111111')).toBe(false);     // all-same
  });
});

describe('redactPii — CPF (spec §5.3, closes the emergent-suggestions leak)', () => {
  it('redacts a valid CPF', () => {
    expect(redactPii('o cpf do cliente é 529.982.247-25, ok?'))
      .toBe('o cpf do cliente é ***.***.***-25, ok?');
  });
  it('leaves a validator-failed match UNMASKED (spec §5.4)', () => {
    // 12345678901 matches the cpf regex shape but fails check digits — it must
    // pass through untouched, or every 11-digit order id gets redacted.
    expect(redactPii('order 12345678901 shipped')).toBe('order 12345678901 shipped');
  });
});

describe('three-consumer agreement (spec §5.4)', () => {
  it('detectPii, detectPiiWithMatches and redactPii agree on the same input', () => {
    const text = 'cpf 529.982.247-25 e pedido 12345678901';
    const names = detectPii(text);
    const withMatches = detectPiiWithMatches(text).map(m => m.type);
    expect(names.includes('cpf')).toBe(true);
    expect(withMatches.includes('cpf')).toBe(true);
    // redactPii changed the text (valid CPF masked) but left the invalid run alone
    const redacted = redactPii(text);
    expect(redacted).toContain('***.***.***-25');
    expect(redacted).toContain('12345678901');
  });
});

describe('RG detection (Brazil, labelled-only — spec D3)', () => {
  it('detects a labelled formatted RG', () => {
    expect(detectPii('documento RG 12.345.678-9 anexado')).toContain('rg');
  });
  it('detects a labelled RG with colon and X check character', () => {
    expect(detectPii('RG: 12.345.678-X')).toContain('rg');
  });
  it('detects a labelled bare RG', () => {
    expect(detectPii('RG 123456789')).toContain('rg');
  });
  it('detects a lowercase-labelled rg (case-insensitive, matching the passport/date_of_birth precedent)', () => {
    expect(detectPii('documento rg 12.345.678-9')).toContain('rg');
  });
  it('does NOT detect an unlabelled RG-shaped number (labelled-only by design)', () => {
    expect(detectPii('numero 12.345.678-9 no formulário')).not.toContain('rg');
  });
  it('masks an RG showing only the final character', () => {
    const rg = detectPiiWithMatches('RG 12.345.678-9').find(m => m.type === 'rg');
    expect(rg).toBeDefined();
    expect(rg!.masked).toBe('RG **.***.***-9');
  });
});

describe('Brazilian phone detection', () => {
  it('detects +55 international format', () => {
    expect(detectPii('ligue +55 11 98765-4321')).toContain('br_phone');
  });
  it('detects parenthesised area-code format', () => {
    expect(detectPii('contato (11) 98765-4321')).toContain('br_phone');
  });
  it('detects an 8-digit landline with parenthesised area code', () => {
    expect(detectPii('fixo (11) 3456-7890')).toContain('br_phone');
  });
  it('does NOT detect a bare digit run without +55 or parens (conservative by design)', () => {
    expect(detectPii('valor 11 98765 4321 unidades')).not.toContain('br_phone');
  });
  it('masks a Brazilian phone showing the last 4 digits', () => {
    const m = detectPiiWithMatches('tel (11) 98765-4321').find(x => x.type === 'br_phone');
    expect(m).toBeDefined();
    expect(m!.masked.endsWith('4321')).toBe(true);
    expect(m!.masked).toMatch(/^\*+4321$/);
  });
});

describe('pattern-entry invariants', () => {
  it('every validator-bearing pattern carries the /g flag (the exec-loop in the detectors spins forever without it)', () => {
    for (const { name, pattern, validate } of PII_PATTERNS) {
      if (validate) expect(pattern.flags, `pattern '${name}' has a validator but no g flag`).toContain('g');
    }
  });
});
