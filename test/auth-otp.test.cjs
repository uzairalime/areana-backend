require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const bcrypt = require('bcrypt');
const { AuthService } = require('../src/auth/auth.service');
const { MailDeliveryDelayedError } = require('../src/auth/mail.service');

function setup(initialRecords = []) {
  const records = initialRecords.map((record) => ({ consumedAt: null, ...record }));
  const sent = [];
  const logs = [];
  const events = [];
  let nextId = 0;
  const matches = (record, where) =>
    (where.email === undefined || record.email === where.email) &&
    (where.ip === undefined || record.ip === where.ip) &&
    (where.createdAt === undefined || record.createdAt >= where.createdAt.gte) &&
    (where.consumedAt !== null || record.consumedAt === null);
  const otpCode = {
    count: async ({ where }) => records.filter((record) => matches(record, where)).length,
    findFirst: async ({ where }) => {
      const oldest = records.filter((record) => matches(record, where))
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      return oldest ? { createdAt: oldest.createdAt } : null;
    },
    updateMany: async ({ where, data }) => {
      const matching = records.filter((record) => matches(record, where));
      for (const record of matching) Object.assign(record, data);
      events.push('invalidate');
      return { count: matching.length };
    },
    create: async ({ data }) => {
      const record = {
        ...data, id: `new-${++nextId}`, createdAt: new Date(), attempts: 0, consumedAt: null,
      };
      records.push(record);
      events.push('create');
      return record;
    },
  };
  const prisma = {
    otpCode,
    $transaction: async (callback) => {
      events.push('transaction');
      const snapshot = records.map((record) => ({ ...record }));
      try {
        return await callback({ otpCode });
      } catch (error) {
        records.splice(0, records.length, ...snapshot);
        throw error;
      }
    },
  };
  const mail = {
    sendOtp: async (email, code) => {
      sent.push({ email, code });
      events.push('send');
    },
  };
  const config = { get: (key) => ({ 'smtp.host': 'localhost', 'smtp.port': 1025 })[key] };
  const auth = new AuthService(prisma, {}, config, mail, {});
  auth.logger.error = (message) => logs.push(message);
  return { auth, records, sent, logs, events, otpCode, prisma, mail };
}

function isDeliveryUnavailable(error) {
  assert.equal(error.getStatus(), 503);
  assert.equal(error.message, 'Unable to send login code. Please try again later.');
  return true;
}

test('sends before persisting and atomically replaces the previous OTP with a hashed, expiring code', async () => {
  const previous = { id: 'previous', email: 'player@example.com', createdAt: new Date() };
  const unrelated = { id: 'unrelated', email: 'other@example.com', createdAt: new Date() };
  const { auth, records, mail, events } = setup([previous, unrelated]);
  let deliveredCode;
  mail.sendOtp = async (email, code) => {
    assert.equal(email, 'player@example.com');
    assert.match(code, /^\d{6}$/);
    assert.equal(records.length, 2);
    assert.equal(records[0].consumedAt, null);
    deliveredCode = code;
    events.push('send');
  };
  const started = Date.now();
  const response = await auth.requestOtp({ email: ' Player@Example.com ' }, '192.0.2.1');
  const created = records.find((record) => record.id === 'new-1');
  assert.ok(deliveredCode);
  assert.ok(created);
  assert.notEqual(created.codeHash, deliveredCode);
  assert.equal(await bcrypt.compare(deliveredCode, created.codeHash), true);
  assert.equal(created.email, 'player@example.com');
  assert.equal(created.ip, '192.0.2.1');
  assert.equal(created.consumedAt, null);
  assert.ok(records[0].consumedAt instanceof Date);
  assert.equal(records[1].consumedAt, null);
  assert.ok(created.expiresAt.getTime() >= started + 10 * 60_000);
  assert.ok(created.expiresAt.getTime() <= Date.now() + 10 * 60_000);
  assert.deepEqual(response, {
    message: 'Login code sent to your email',
    expiresAt: created.expiresAt.toISOString(),
    ttlSeconds: 600,
  });
  assert.deepEqual(events, ['send', 'transaction', 'invalidate', 'create']);
});

test('failed SMTP delivery preserves previous codes without persistence or secret logging', async () => {
  const previous = { id: 'previous', email: 'player@example.com', createdAt: new Date() };
  const unrelated = { id: 'unrelated', email: 'other@example.com', createdAt: new Date() };
  const { auth, records, mail, logs, events } = setup([previous, unrelated]);
  const before = records.map((record) => ({ ...record }));
  mail.sendOtp = async () => {
    throw Object.assign(new Error('password=provider-secret'), {
      code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535,
      response: 'provider-secret',
    });
  };
  await assert.rejects(auth.requestOtp({ email: 'player@example.com' }), isDeliveryUnavailable);
  assert.deepEqual(records, before);
  assert.deepEqual(events, []);
  assert.match(logs.join('\n'), /localhost:1025/);
  assert.match(logs.join('\n'), /EAUTH/);
  assert.doesNotMatch(logs.join('\n'), /provider-secret/);
});

test('delayed delivery keeps its distinct 503 and preserves the previous OTP', async () => {
  const { auth, records, mail, events } = setup([
    { id: 'previous', email: 'player@example.com', createdAt: new Date() },
  ]);
  const before = records.map((record) => ({ ...record }));
  mail.sendOtp = async () => { throw new MailDeliveryDelayedError(); };
  await assert.rejects(auth.requestOtp({ email: 'player@example.com' }), (error) => {
    assert.equal(error.getStatus(), 503);
    assert.match(error.message, /Mail delivery was delayed/);
    assert.match(error.message, /previous code still works/);
    return true;
  });
  assert.deepEqual(records, before);
  assert.deepEqual(events, []);
});

test('repeated failed deliveries do not exhaust the hourly quota', async () => {
  const { auth, records, mail } = setup();
  mail.sendOtp = async () => { throw new Error('SMTP unavailable'); };
  for (let attempt = 0; attempt < 6; attempt++) {
    await assert.rejects(auth.requestOtp({ email: 'player@example.com' }), isDeliveryUnavailable);
    assert.equal(records.length, 0);
  }
  mail.sendOtp = async () => {};
  await auth.requestOtp({ email: 'player@example.com' });
  assert.equal(records.length, 1);
});

test('five recent codes return 429 without sending or persisting another code', async () => {
  const recent = Array.from({ length: 5 }, (_, index) => ({
    id: `sent-${index}`, email: 'player@example.com', createdAt: new Date(),
  }));
  const { auth, records, sent, events } = setup(recent);
  const before = records.map((record) => ({ ...record }));
  await assert.rejects(auth.requestOtp({ email: 'player@example.com' }), (error) => {
    assert.equal(error.getStatus(), 429);
    assert.ok(error.getResponse().retryAfterSeconds > 0);
    assert.ok(error.getResponse().resetsAt);
    return true;
  });
  assert.deepEqual(records, before);
  assert.equal(sent.length, 0);
  assert.deepEqual(events, []);
});

test('the IP hourly cap rejects requests across different email addresses before delivery', async () => {
  const recent = Array.from({ length: 30 }, (_, index) => ({
    id: `sent-${index}`, email: `player-${index}@example.com`, ip: '192.0.2.1', createdAt: new Date(),
  }));
  const { auth, sent, events } = setup(recent);
  await assert.rejects(auth.requestOtp({ email: 'new@example.com' }, '192.0.2.1'), (error) => {
    assert.equal(error.getStatus(), 429);
    return true;
  });
  assert.equal(sent.length, 0);
  assert.deepEqual(events, []);
});

test('database count failures before delivery are not misreported as SMTP failures', async () => {
  const { auth, otpCode, sent, logs, events } = setup();
  const failure = new Error('database unavailable');
  otpCode.count = async () => { throw failure; };
  await assert.rejects(auth.requestOtp({ email: 'player@example.com' }), (error) => error === failure);
  assert.equal(sent.length, 0);
  assert.deepEqual(events, []);
  assert.equal(logs.length, 0);
});

test('database persistence failures after delivery propagate and roll back previous-code invalidation', async () => {
  const { auth, records, otpCode, sent, logs } = setup([
    { id: 'previous', email: 'player@example.com', createdAt: new Date() },
  ]);
  const before = records.map((record) => ({ ...record }));
  const failure = new Error('database unavailable');
  otpCode.create = async () => { throw failure; };
  await assert.rejects(auth.requestOtp({ email: 'player@example.com' }), (error) => error === failure);
  assert.equal(sent.length, 1);
  assert.deepEqual(records, before);
  assert.equal(logs.length, 0);
});
