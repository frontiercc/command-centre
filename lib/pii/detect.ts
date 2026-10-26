// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Brazilian CPF check-digit validation (mod-11, two digits). Accepts formatted
 * (123.456.789-09) or bare (12345678909) input; strips non-digits first.
 * All-same-digit values pass naive mod-11 and are explicitly rejected.
 */
export function validateCpf(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;
  const checkDigit = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(digits[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return checkDigit(9) === Number(digits[9]) && checkDigit(10) === Number(digits[10]);
}

/**
 * Luhn (mod-10) check for payment card numbers. Every real card number
 * satisfies it by construction, so this loses no genuine detections — it only
 * rejects 16-digit runs that could never be a card (spreadsheet cells glued
 * together, UUID fragments). Same role Brazilian mod-11 plays for CPF.
 */
export function luhn(raw: string): boolean {
  const d = raw.replace(/\D/g, '');
  if (d.length !== 16) return false;
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    let n = Number(d[15 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * Shared PII and secret detection patterns used by ingest routes.
 * Patterns are grouped by compliance driver:
 * - GDPR Art. 4(1), Recital 30: personal data identifiers
 * - ISO 27001 A.8.11/A.8.12: secrets, credentials, data masking
 */
export const PII_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
  /**
   * Optional semantic validation applied to each regex match. A match that
   * fails validation is treated as NOT detected (detectPii /
   * detectPiiWithMatches skip it; redactPii leaves it unmasked). Required for
   * check-digit types like cpf — shape-only matching false-positives on
   * ordinary dev strings (order ids, tracking numbers); the same class as an
   * earlier NINO defect.
   */
  validate?: (match: string) => boolean;
}> = [
  // ── Existing patterns ──
  { name: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  // Leading (?<![\w+.]) stops the bare-0 branch matching INSIDE a longer digit
  // run — a production defect, where a Slack permalink (…/p1785507487786939)
  // and a LinkedIn activity URN both contained "0 + 10 digits". The [1235789]
  // after the trunk 0 is the UK numbering plan: no allocated range starts 00,
  // 04, 06 or 09.
  { name: 'uk_phone', pattern: /(?<![\w+.])(?:\+44\s?\(?0?\)?\s?|0)[1235789]\d{3}\s?\d{6}(?![\d\w])/g },
  // Real UK NINO rules: first letter excludes D/F/I/Q/U/V, second letter
  // excludes those PLUS O, and the two-letter prefix excludes
  // BG/GB/NK/KN/TN/NT/ZZ. The surrounding (?<![A-Za-z0-9]) / (?![A-Za-z0-9])
  // are load-bearing: without them the shape matches INSIDE longer tokens —
  // observed in production against Salesforce record ids (a5|hQ500000C|xmpa),
  // CloudWatch hex hashes, UUID fragments, and even plain English prose
  // ("th|an 880629 b|ecause"). Case-insensitivity is deliberately RETAINED —
  // the boundaries alone clear every observed false positive, so there is no
  // need to trade away recall (redactPii must still mask a lowercase NINO).
  { name: 'nino', pattern: /(?<![A-Za-z0-9])(?!BG|GB|NK|KN|TN|NT|ZZ)[ABCEGHJKLMNOPRSTWXYZ][ABCEGHJKLMNPRSTWXYZ]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D](?![A-Za-z0-9])/gi },
  // Separators are space/hyphen ONLY — never \s, which matched a NEWLINE and
  // glued four adjacent spreadsheet cells (8035\n6800\n5200\n5144) into a
  // "card number". Hyphen boundaries reject UUID prefixes, whose 8-4-4 digit
  // groups otherwise read as 4-4-4-4 (60336229-7563-4721-adaf). Luhn is the
  // backstop: no real card fails it.
  { name: 'credit_card', pattern: /(?<![\d.\-])\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}(?![\d.\-])/g, validate: luhn },
  { name: 'api_key', pattern: /sk-[a-zA-Z0-9_-]{20,}/g },
  // ── GDPR — personal data (Art. 4(1), Recital 30) ──
  // Token boundaries: without them the shape matched INSIDE
  // longer alphanumeric strings, the same class of bug as earlier false
  // positives. `[\s]?` also became ` ?` — \s matches a NEWLINE, which glues
  // adjacent table cells into a single fake IBAN (the credit_card precedent).
  { name: 'iban', pattern: /(?<![A-Za-z0-9])[A-Z]{2}\d{2} ?[A-Z0-9]{4} ?[A-Z0-9]{4} ?[A-Z0-9]{4} ?[A-Z0-9]{0,6}(?![A-Za-z0-9])/g },
  { name: 'ip_address', pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  { name: 'date_of_birth', pattern: /\b(?:DOB|date of birth|born)\s*[:=\-]?\s*(?:\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}|\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\b/gi },
  // \b does NOT exclude an adjacent hyphen, so a part code like X-123-45-6789
  // matched. Same guard credit_card already uses.
  { name: 'us_ssn', pattern: /(?<![\d.\-])\d{3}-\d{2}-\d{4}(?![\d.\-])/g },
  { name: 'passport', pattern: /\b(?:passport)\s*[:=\-]?\s*[A-Z]{1,2}\d{7,9}\b/gi },
  // Requires parenthesised area code OR a real separator between groups. A
  // BARE 10-digit run is indistinguishable from an ordinary identifier and was
  // the whole of this pattern's false-positive load in production (Greenhouse
  // job ids, GitHub comment ids). Accepted cost: "5551234567" written with no
  // separators is no longer detected.
  { name: 'us_phone', pattern: /(?<![\d.\-])(?:\+1[ .\-]?)?(?:\(\d{3}\)[ .\-]?\d{3}[ .\-]?\d{4}|\d{3}[ .\-]\d{3}[ .\-]\d{4})(?![\d\-])/g },
  // ── ISO 27001 A.8.11/A.8.12 — secrets & credentials ──
  { name: 'aws_key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'github_token', pattern: /gh[ps]_[a-zA-Z0-9]{36,}/g },
  { name: 'jwt_token', pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },
  { name: 'private_key', pattern: /-----BEGIN [\w\s]* PRIVATE KEY-----/g },
  { name: 'connection_string', pattern: /(postgres|mysql|mongodb|redis):\/\/[^\s]+/g },
  { name: 'generic_secret', pattern: /(?:password|secret|token|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/gi },
  // ── LGPD — Brazilian personal data (Lei 13.709/2018, Art. 5(I)) ──
  // Type names cpf/rg/br_phone are FROZEN — they are lookup keys into the
  // alert TITLES map and severity sets (see lib/alerts/pii-alerts.ts).
  { name: 'cpf', pattern: /\b(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})\b/g, validate: validateCpf },
  // RG has NO national format standard (state-issued; São Paulo differs from
  // other states), so it is deliberately labelled-only — a literal "RG" prefix
  // is required. Same precedent as the passport and date_of_birth patterns.
  { name: 'rg', pattern: /\bRG\s*(?:n[ºo°]?\.?\s*)?[:=\-]?\s*\d{1,2}\.?\d{3}\.?\d{3}-?[0-9Xx]\b/gi },
  // Requires +55 or a parenthesised 2-digit area code — bare digit runs are
  // NOT matched (conservative; mirrors the uk_phone/us_phone tradeoff).
  // Every \s became a literal space (\s matches a newline) and a
  // leading boundary was added.
  { name: 'br_phone', pattern: /(?<![\d.\-])(?:\+55 ?\(?\d{2}\)?|\(\d{2}\)) ?9?\d{4}[-. ]?\d{4}(?![\d\-])/g },
];

export function detectPii(text: string): string[] {
  const found: string[] = [];
  for (const { name, pattern, validate } of PII_PATTERNS) {
    pattern.lastIndex = 0;
    if (!validate) {
      if (pattern.test(text)) found.push(name);
      continue;
    }
    let m = pattern.exec(text);
    while (m && !validate(m[0])) m = pattern.exec(text);
    if (m) found.push(name);
  }
  return found;
}

// ── Masking functions per PII type ──────────────────────────────────────

export interface PiiMatch {
  type: string;
  masked: string;
}

function maskValue(type: string, value: string): string {
  switch (type) {
    case 'credit_card': {
      // Show last 4 digits: ****-****-****-1234
      const digits = value.replace(/[\s-]/g, '');
      return `****-****-****-${digits.slice(-4)}`;
    }
    case 'nino': {
      // Show prefix and suffix: QQ ***  ***C
      const clean = value.replace(/\s/g, '');
      return `${clean.slice(0, 2)} *** ***${clean.slice(-1)}`;
    }
    case 'us_ssn': {
      // Show last 4: ***-**-6789
      return `***-**-${value.slice(-4)}`;
    }
    case 'email': {
      // Show first char and domain: j***@example.com
      const [local, domain] = value.split('@');
      return `${local[0]}***@${domain}`;
    }
    case 'uk_phone':
    case 'us_phone':
    case 'br_phone': {
      // Show last 4 digits
      const d = value.replace(/\D/g, '');
      return `${'*'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`;
    }
    case 'iban': {
      // Show country code + last 4: GB29 **** **** **** **68 19
      const clean = value.replace(/\s/g, '');
      return `${clean.slice(0, 4)} ${'*'.repeat(Math.max(0, clean.length - 8))} ${clean.slice(-4)}`;
    }
    case 'ip_address': {
      // Show last octet: ***.***.***.100
      const parts = value.split('.');
      return `***.***.***.${parts[3]}`;
    }
    case 'date_of_birth': {
      // Show year only: DOB: **/**/1990
      const yearMatch = value.match(/(\d{4})/);
      return yearMatch ? `**/**/` + yearMatch[1] : '**/**/****';
    }
    case 'passport': {
      // Show first 2 and last 2: AB*****67
      const alphaNum = value.replace(/^(?:passport)\s*[:=\-]?\s*/i, '');
      return `${alphaNum.slice(0, 2)}${'*'.repeat(Math.max(0, alphaNum.length - 4))}${alphaNum.slice(-2)}`;
    }
    case 'api_key': {
      // Show prefix and last 3: sk-***...456
      return `${value.slice(0, 3)}***...${value.slice(-3)}`;
    }
    case 'aws_key': {
      // Show prefix and last 4: AKIA***AMPLE
      return `${value.slice(0, 4)}***${value.slice(-4)}`;
    }
    case 'github_token': {
      // Show prefix and last 3: ghp_***...789
      return `${value.slice(0, 4)}***...${value.slice(-3)}`;
    }
    case 'jwt_token': {
      // Truncate: eyJ***...[truncated]
      return `${value.slice(0, 3)}***...[truncated]`;
    }
    case 'private_key':
      return '[private key detected]';
    case 'connection_string':
      return '[connection string detected]';
    case 'generic_secret': {
      // Show key name only: secret = "***"
      const keyMatch = value.match(/^((?:password|secret|token|api_key)\s*[:=]\s*)/i);
      return keyMatch ? `${keyMatch[1]}"***"` : '[secret detected]';
    }
    case 'rg': {
      // Show the check character only: RG **.***.***-9
      const tail = value.replace(/[^0-9Xx]/g, '').slice(-1);
      return `RG **.***.***-${tail}`;
    }
    case 'cpf': {
      // Show the check-digit block only: ***.***.***-25. The check digits are
      // derived from the hidden nine, so this reveals least while staying
      // traceable (cf. us_ssn showing last 4 of 9).
      const digits = value.replace(/\D/g, '');
      return `***.***.***-${digits.slice(-2)}`;
    }
    default:
      return '***';
  }
}

/**
 * Detect PII and return masked versions of the matched values.
 * One match per PII type (first occurrence).
 */
export function detectPiiWithMatches(text: string): PiiMatch[] {
  const matches: PiiMatch[] = [];
  for (const { name, pattern, validate } of PII_PATTERNS) {
    pattern.lastIndex = 0;
    let m = pattern.exec(text);
    while (m && validate && !validate(m[0])) m = pattern.exec(text);
    if (m) {
      matches.push({ type: name, masked: maskValue(name, m[0]) });
    }
  }
  return matches;
}

/**
 * Replace every PII_PATTERNS match in `text` with its masked form. Best-effort:
 * masks STRUCTURED PII (emails, phones, SSNs, cards, keys) — does NOT catch
 * names or free-text sensitive content.
 */
export function redactPii(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { name, pattern, validate } of PII_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    out = out.replace(new RegExp(pattern.source, flags), (m) =>
      validate && !validate(m) ? m : maskValue(name, m),
    );
  }
  return out;
}
